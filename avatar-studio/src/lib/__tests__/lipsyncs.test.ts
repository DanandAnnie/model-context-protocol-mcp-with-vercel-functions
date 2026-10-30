// Lip syncs (HeyGen lip sync): a video given a new audio track, the speaker's mouth redrawn to match. The footage is a
// library video or a public link, the audio a saved audio clip or a public link. What is accepted, what HeyGen is asked,
// how a job is followed, and that it goes with its video and the account.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_LIPSYNCS, createClip, deleteClip, deleteLipsync, deleteOwnerData, deleteVideo, exportOwnerData, forgetLipsyncChecks, lipsyncKeySchema, lipsyncRequestSchema, listLipsyncs, publicLipsync, startLipsync } from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { getStore } from "../store";
import type { AudioClip, LipsyncJob, Video, VoiceChange } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetLipsyncChecks();
});

const now = () => new Date().toISOString();
async function finished(owner: string, extra: Partial<Video> = {}): Promise<Video> {
  const video = {
    id: `vid_${Math.random().toString(36).slice(2, 10)}`,
    ownerId: owner,
    title: "Founder update",
    script: "Hello.",
    avatarId: "stock_1",
    voiceId: "stock_voice_1",
    aspect: "16:9",
    background: { type: "color", value: "#000000" },
    captions: false,
    speed: 1,
    status: "completed",
    provider: "mock",
    videoUrl: "https://93.184.216.34/update.mp4",
    durationSec: 40,
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  } as Video;
  return getStore().put("video", video);
}

/** A silent one-second 16-bit mono WAV, as the editor saves clips. */
function wavDataUrl(): string {
  const rate = 8000;
  const size = rate * 2;
  const v = new DataView(new ArrayBuffer(44 + size));
  const put = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + size, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, size, true);
  return `data:audio/wav;base64,${Buffer.from(v.buffer).toString("base64")}`;
}

const clipMs = MockAvatarProvider as unknown as { CLIP_MS: number };
const VIDEO = "https://93.184.216.34/interview.mp4";
const AUDIO = "https://93.184.216.34/new-take.mp3";

describe("lip syncs", () => {
  it("takes one footage and one audio, each a library item or a public https link, at a known quality", async () => {
    assert.throws(() => lipsyncRequestSchema.parse({ audioUrl: AUDIO }), /Choose one of your videos or paste a link to a video/);
    assert.throws(() => lipsyncRequestSchema.parse({ videoId: "vid_1", sourceUrl: VIDEO, audioUrl: AUDIO }), /Choose one of your videos/);
    assert.throws(() => lipsyncRequestSchema.parse({ sourceUrl: VIDEO }), /Choose one of your audio clips or recordings in another voice, or paste a link/);
    assert.throws(() => lipsyncRequestSchema.parse({ sourceUrl: VIDEO, clipId: "clip_1", audioUrl: AUDIO }), /Choose one of your audio clips/);
    assert.throws(() => lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO, mode: "turbo" }));
    assert.equal(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO }).mode, "speed", "fast unless asked otherwise");
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: "http://93.184.216.34/a.mp4", audioUrl: AUDIO }), "u1"), /public https link to the video/);
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: "https://127.0.0.1/a.mp3" }), "u1"), (e: unknown) => e instanceof ValidationError && /new audio/.test((e as Error).message));
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: "https://10.0.0.5/a.mp4", audioUrl: AUDIO }), "u1"), ValidationError);
    assert.throws(() => lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: `https://93.184.216.34/${"a".repeat(2000)}` }), /too long/);
  });

  it("syncs in demo mode, followed until ready, for the account that asked only", async () => {
    assert.equal(providerStatus().lipsync, true);
    const saved = clipMs.CLIP_MS;
    try {
      clipMs.CLIP_MS = 60_000;
      const job = await startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO, mode: "precision", title: " Interview " }), "u1");
      assert.match(job.id, /^ls_/);
      assert.deepEqual([job.status, job.title, job.sourceUrl, job.audioUrl, job.mode, job.videoId, job.clipId], ["processing", "Interview", VIDEO, AUDIO, "precision", undefined, undefined]);
      assert.deepEqual(Object.keys(publicLipsync(job)).filter((k) => ["ownerId", "provider", "providerJobId"].includes(k)), [], "the renderer and its job id stay on the server");
      assert.equal((await listLipsyncs("u1"))[0].status, "processing");
      clipMs.CLIP_MS = 0;
      assert.equal((await listLipsyncs("u1"))[0].status, "processing", "asked again at once, it is not checked twice");
      forgetLipsyncChecks();
      const [done] = await listLipsyncs("u1");
      assert.deepEqual([done.status, done.durationSec], ["completed", 12]);
      assert.match(done.videoUrl!, /\/demo\/render\.webm$/);
      assert.deepEqual(await listLipsyncs("u2"), [], "another account sees none");
      await assert.rejects(deleteLipsync(done.id, "u2"), NotFoundError);
      await deleteLipsync(done.id, "u1");
      assert.deepEqual(await listLipsyncs("u1"), []);
      await assert.rejects(deleteLipsync("../x", "u1"), /Unknown lip sync/);
    } finally {
      clipMs.CLIP_MS = saved;
    }
  });

  it("syncs a finished library video to a saved clip, and refuses footage or audio that is not the account's to use", async () => {
    const video = await finished("u1");
    const clip = await createClip({ name: "New take", audio: wavDataUrl() }, "u1");
    const job = await startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, clipId: clip.id }), "u1");
    assert.deepEqual([job.title, job.videoId, job.clipId, job.sourceUrl, job.audioUrl], ["Founder update (lip-synced)", video.id, clip.id, undefined, undefined]);
    const rendering = await finished("u1", { status: "processing", videoUrl: undefined });
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: rendering.id, audioUrl: AUDIO }), "u1"), /Only a finished video/);
    const trashed = await finished("u1", { deletedAt: now() });
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: trashed.id, audioUrl: AUDIO }), "u1"), /Restore the video/);
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, audioUrl: AUDIO }), "u2"), NotFoundError);
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, clipId: clip.id }), "u2"), /no longer available/, "another account's clip is not offered");
    await deleteClip(clip.id, "u1");
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, clipId: clip.id }), "u1"), /no longer available/);
  });

  it("syncs a video to a recording spoken in one of the account's voices, sending the renderer's own link", async () => {
    const change = (id: string, owner: string, extra: Partial<VoiceChange> = {}): VoiceChange => ({
      id,
      ownerId: owner,
      title: "Welcome in Narrator",
      voiceId: "iv_1",
      voiceName: "Narrator",
      text: "Welcome.",
      provider: "mock",
      providerVoiceId: "mockiv_1",
      status: "completed",
      audioUrl: "https://files.heygen.ai/generated/speech.wav?sig=1",
      createdAt: now(),
      updatedAt: now(),
      ...extra,
    });
    await getStore().put("voicechange", change("vc_ready", "u1"));
    await getStore().put("voicechange", change("vc_busy", "u1", { status: "processing", audioUrl: undefined }));
    await getStore().put("voicechange", change("vc_theirs", "u2"));
    await getStore().put("voicechange", change("vc_old", "u1", { updatedAt: new Date(Date.now() - 61 * 60 * 1000).toISOString() }));
    await getStore().put("voicechange", change("vc_other", "u1", { provider: "heygen" }));
    const proto = MockAvatarProvider.prototype as unknown as { startLipsync: (...a: unknown[]) => Promise<{ jobId: string }> };
    const real = proto.startLipsync;
    const sent: Array<{ audio: unknown }> = [];
    proto.startLipsync = async function (this: unknown, ...a: unknown[]) {
      sent.push(a[0] as { audio: unknown });
      return real.apply(this, a);
    };
    try {
      const video = await finished("u1");
      const job = await startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_ready" }), "u1", { key: "voice-lipsync-1" });
      assert.deepEqual([job.voiceChangeId, job.audioName, job.audioUrl, job.clipId], ["vc_ready", "Welcome in Narrator", undefined, undefined]);
      assert.deepEqual(sent[0].audio, { type: "url", url: "https://files.heygen.ai/generated/speech.wav?sig=1" });
      // Retried with the same key it is the same lip sync; with other audio it is not.
      assert.equal((await startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_ready" }), "u1", { key: "voice-lipsync-1" })).id, job.id);
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, audioUrl: AUDIO }), "u1", { key: "voice-lipsync-1" }), ConflictError);
      // One still being spoken, another account's, or one deleted is refused before the renderer is asked.
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_busy" }), "u1"), /still being spoken/);
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_theirs" }), "u1"), /recording in another voice is no longer available/);
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_gone" }), "u1"), /no longer available/);
      // Its link is good for about an hour, and only to the renderer that made it.
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_old" }), "u1"), /over an hour ago, and its link from the renderer has expired; make it again/);
      // One kept as an audio clip points to that clip, while it is the account's.
      const keptClip: AudioClip = { id: "clip_kept", ownerId: "u1", name: "Welcome in Narrator", mimeType: "audio/wav", bytes: 100, durationSec: 2, createdAt: new Date().toISOString() };
      await getStore().put("clip", keptClip);
      const old = (await getStore().get<VoiceChange>("voicechange", "vc_old"))!;
      await getStore().put("voicechange", { ...old, savedClipId: keptClip.id });
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_old" }), "u1"), /has expired; choose the audio clip “Welcome in Narrator” you kept of it instead/);
      await getStore().put("clip", { ...keptClip, ownerId: "u2" });
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_old" }), "u1"), /has expired; make it again/);
      await getStore().remove("clip", keptClip.id);
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_other" }), "u1"), /made by another renderer/);
      assert.equal(sent.length, 1);
      // Exactly one audio source.
      assert.throws(() => lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "vc_ready", audioUrl: AUDIO }), /Choose one of your audio clips or recordings/);
      assert.throws(() => lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: "nope" }), /recordings in another voice/);
      // An empty field is one left out, whichever it is.
      assert.deepEqual(JSON.parse(JSON.stringify(lipsyncRequestSchema.parse({ videoId: video.id, voiceChangeId: " vc_ready ", clipId: "", audioUrl: "  " }))), { videoId: video.id, voiceChangeId: "vc_ready", mode: "speed" });
    } finally {
      proto.startLipsync = real;
    }
  });

  it("returns the same lip sync for a start retried with the same key, without asking the renderer again", async () => {
    const proto = MockAvatarProvider.prototype as unknown as { startLipsync: (...a: unknown[]) => Promise<{ jobId: string }> };
    const real = proto.startLipsync;
    const keys: unknown[] = [];
    proto.startLipsync = async function (this: unknown, ...a: unknown[]) {
      keys.push((a[0] as { key: string }).key);
      return real.apply(this, a);
    };
    try {
      const input = lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO });
      let admitted = 0;
      const admit = () => void admitted++;
      const first = await startLipsync(input, "u1", { key: "retry-key-1", admit });
      const again = await startLipsync(input, "u1", { key: "retry-key-1", admit });
      assert.equal(again.id, first.id);
      assert.deepEqual([keys.length, admitted], [1, 1], "a repeat neither asks the renderer nor counts against the limit");
      assert.equal(keys[0], first.id, "the renderer's idempotency key is the lip sync's id");
      assert.notEqual((await startLipsync(input, "u2", { key: "retry-key-1" })).id, first.id, "the same key from another account is another lip sync");
      assert.notEqual((await startLipsync(input, "u1")).id, first.id, "without a key every start is new");
      for (const other of [{ sourceUrl: "https://93.184.216.34/other.mp4", audioUrl: AUDIO }, { sourceUrl: VIDEO, audioUrl: "https://93.184.216.34/other.mp3" }, { sourceUrl: VIDEO, audioUrl: AUDIO, mode: "precision" }]) {
        await assert.rejects(startLipsync(lipsyncRequestSchema.parse(other), "u1", { key: "retry-key-1" }), ConflictError, "the same key for another video, audio, or quality is refused");
      }
      assert.throws(() => lipsyncKeySchema.parse("short"), /8 to 100/);
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: "https://127.0.0.1/a.mp4", audioUrl: AUDIO }), "u1", { key: "retry-key-2", admit }), ValidationError);
      assert.equal(admitted, 1, "a refused start is not admitted");
    } finally {
      proto.startLipsync = real;
    }
  });

  it("goes with its library video when the video is deleted for good, and is not kept for one deleted while it started", async () => {
    const video = await finished("u1");
    const link = await startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO }), "u1");
    await startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, audioUrl: AUDIO }), "u1");
    await deleteVideo(video.id, "u1");
    assert.equal((await getStore().list("lipsync", "u1")).length, 2, "the trash keeps it, as it keeps the video");
    await deleteVideo(video.id, "u1", true);
    assert.deepEqual((await getStore().list<LipsyncJob>("lipsync", "u1")).map((c) => c.id), [link.id], "a lip sync of a link stays");
    const gone = await finished("u1");
    const proto = MockAvatarProvider.prototype as unknown as { startLipsync: (...a: unknown[]) => Promise<{ jobId: string }> };
    const real = proto.startLipsync;
    proto.startLipsync = async function (this: unknown, ...a: unknown[]) {
      await getStore().remove("video", gone.id);
      return real.apply(this, a);
    };
    try {
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: gone.id, audioUrl: AUDIO }), "u1"), NotFoundError);
      assert.equal((await getStore().list<LipsyncJob>("lipsync", "u1")).filter((c) => c.videoId === gone.id).length, 0);
    } finally {
      proto.startLipsync = real;
    }
  });

  it("keeps at most the account's limit, and goes with the account", async () => {
    for (let i = 0; i < MAX_LIPSYNCS; i++) {
      await getStore().put("lipsync", { id: `ls_old${i}`, ownerId: "u1", title: "Old", mode: "speed", provider: "mock", providerJobId: "x", status: "failed", createdAt: now(), updatedAt: now() } satisfies LipsyncJob);
    }
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO }), "u1"), ConflictError);
    const exported = (await exportOwnerData("u1")).lipsync;
    assert.equal(exported.length, MAX_LIPSYNCS);
    assert.deepEqual(Object.keys(exported[0]).filter((k) => k === "provider" || k === "providerJobId"), [], "the renderer and its job id stay out of the export");
    assert.equal((await deleteOwnerData("u1")).lipsync, MAX_LIPSYNCS);
  });

  it("asks HeyGen with a fresh video link, a clip uploaded once, the quality, and an idempotency key, and maps its answers", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
    let lipsync: Record<string, unknown> = { data: { status: "running" } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method ?? "GET", body, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/videos/hg_video") return Response.json({ data: { status: "completed", video_url: "https://files.heygen.ai/fresh.mp4?sig=1" } });
      if (url === "https://api.heygen.com/v3/assets" && init?.method === "POST") return Response.json({ data: { asset_id: "asset_take" } });
      if (url === "https://api.heygen.com/v3/lipsyncs" && init?.method === "POST") {
        if ((body as { title: string }).title === "in flight") return Response.json({ error: { code: "request_in_progress", message: "A request with this key is in progress." } }, { status: 409 });
        if ((body as { title: string }).title === "refuse") return Response.json({ error: { code: "invalid_parameter", message: "No face was found in the video." } }, { status: 400 });
        return Response.json({ data: { lipsync_id: "ls_hg1" } });
      }
      if (url === "https://api.heygen.com/v3/lipsyncs/ls_hg1") return lipsync.gone ? Response.json({ error: { code: "not_found" } }, { status: 404 }) : Response.json(lipsync);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const video = await finished("u1", { provider: "heygen", providerJobId: "hg_video", videoUrl: "https://files.heygen.ai/old.mp4?sig=expired" });
      const clip = await createClip({ name: "New take", audio: wavDataUrl() }, "u1");
      const job = await startLipsync(lipsyncRequestSchema.parse({ videoId: video.id, clipId: clip.id, mode: "precision" }), "u1");
      const post = calls.find((c) => c.url.endsWith("/v3/lipsyncs") && c.method === "POST")!;
      assert.deepEqual(post.body, { video: { type: "url", url: "https://files.heygen.ai/fresh.mp4?sig=1" }, audio: { type: "asset_id", asset_id: "asset_take" }, mode: "precision", title: "Founder update (lip-synced)" });
      assert.equal(post.idem, job.id, "the studio's id makes a retried start return the same job");
      // The clip's upload is kept, so syncing to it again does not upload it again.
      assert.equal((await getStore().get<AudioClip>("clip", clip.id))!.providerAssetIds?.["heygen:asset"], "asset_take");
      await startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, clipId: clip.id }), "u1");
      assert.equal(calls.filter((c) => c.url.endsWith("/v3/assets")).length, 1);
      await startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO }), "u1");
      assert.deepEqual(calls.filter((c) => c.url.endsWith("/v3/lipsyncs") && c.method === "POST").at(-1)!.body, { video: { type: "url", url: VIDEO }, audio: { type: "url", url: AUDIO }, mode: "speed", title: "Lip-synced video" });
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO, title: "in flight" }), "u1"), (e: unknown) => e instanceof ConflictError && /still being sent/.test((e as Error).message) && !/api\.heygen\.com/.test((e as Error).message));
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO, title: "refuse" }), "u1"), (e: unknown) => e instanceof ValidationError && /could not lip-sync that video: No face was found in the video\./.test((e as Error).message));

      const mine = async () => (await listLipsyncs("u1")).find((l) => l.id === job.id)!;
      const reset = async (extra: Partial<LipsyncJob> = {}) => {
        await getStore().put("lipsync", { ...(await getStore().get<LipsyncJob>("lipsync", job.id))!, status: "processing", ...extra });
        forgetLipsyncChecks();
      };
      assert.equal((await mine()).status, "processing");
      lipsync = { data: { status: "completed", duration: 41.5, video_url: "https://files2.heygen.ai/synced.mp4?sig=a" } };
      await reset();
      const done = await mine();
      assert.deepEqual([done.status, done.videoUrl, done.durationSec], ["completed", "https://files2.heygen.ai/synced.mp4?sig=a", 41.5]);
      // A finished job without a video, a failed one, and one HeyGen no longer has each fail with a reason.
      lipsync = { data: { status: "completed", video_url: "javascript:alert(1)" } };
      await reset();
      assert.deepEqual([(await mine()).status, (await mine()).error], ["failed", "HeyGen finished without a lip-synced video"]);
      lipsync = { data: { status: "failed", failure_message: "The audio has no speech." } };
      // A link from an earlier answer is held, so the failure is seen to drop it.
      await reset({ videoUrl: "https://files2.heygen.ai/synced.mp4?sig=a", durationSec: 41.5 });
      const failed = await mine();
      assert.deepEqual([failed.status, failed.error, failed.videoUrl, failed.durationSec], ["failed", "The audio has no speech.", undefined, undefined], "a failure drops the old link");
      lipsync = { gone: true };
      await reset();
      assert.match((await mine()).error!, /no longer available from HeyGen/);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("is not offered by a renderer without it", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().lipsync, false);
      await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO }), "u1"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
