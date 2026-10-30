// Cleaned recordings (HeyGen filler word removal): filler words and long silences cut out of a recording, from a public
// link or a library video. What is accepted, what HeyGen is asked, how a job is followed, and that it goes with the account.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_CLEANUPS, cleanupKeySchema, cleanupRequestSchema, deleteCleanup, deleteOwnerData, deleteVideo, exportOwnerData, forgetCleanupChecks, listCleanups, publicCleanup, startCleanup } from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { getStore } from "../store";
import type { CleanupJob, Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetCleanupChecks();
});

const now = () => new Date().toISOString();
async function finished(owner: string, extra: Partial<Video> = {}): Promise<Video> {
  const video = {
    id: `vid_${Math.random().toString(36).slice(2, 10)}`,
    ownerId: owner,
    title: "Q3 webinar",
    script: "Welcome in.",
    avatarId: "stock_1",
    voiceId: "stock_voice_1",
    aspect: "16:9",
    background: { type: "color", value: "#000000" },
    captions: false,
    speed: 1,
    status: "completed",
    provider: "mock",
    videoUrl: "https://93.184.216.34/webinar.mp4",
    durationSec: 512,
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  } as Video;
  return getStore().put("video", video);
}

const clipMs = MockAvatarProvider as unknown as { CLIP_MS: number };
const PUBLIC = "https://93.184.216.34/webinar.mp4";

describe("cleaned recordings", () => {
  it("takes one of a library video or a public https link", async () => {
    assert.throws(() => cleanupRequestSchema.parse({}), /Choose one of your videos or paste a link/);
    assert.throws(() => cleanupRequestSchema.parse({ videoId: "vid_1", sourceUrl: PUBLIC }), /Choose one/);
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: "http://93.184.216.34/a.mp4" }), "u1"), /public https link/);
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: "https://127.0.0.1/a.mp4" }), "u1"), (e: unknown) => e instanceof ValidationError && /public host/.test((e as Error).message));
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: "https://10.0.0.5/a.mp4" }), "u1"), ValidationError);
    assert.throws(() => cleanupRequestSchema.parse({ sourceUrl: `https://93.184.216.34/${"a".repeat(2000)}` }), /too long/);
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: "https://exa mple.com/a.mp4" }), "u1"), /public https link/);
  });

  it("cleans a recording in demo mode, followed until ready, for the account that asked only", async () => {
    assert.equal(providerStatus().fillerRemoval, true);
    const saved = clipMs.CLIP_MS;
    try {
      clipMs.CLIP_MS = 60_000;
      const job = await startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC, title: " Webinar " }), "u1");
      assert.match(job.id, /^cu_/);
      assert.deepEqual([job.status, job.title, job.sourceUrl, job.videoId], ["processing", "Webinar", PUBLIC, undefined]);
      assert.deepEqual(Object.keys(publicCleanup(job)).filter((k) => ["ownerId", "provider", "providerJobId"].includes(k)), [], "the renderer and its job id stay on the server");
      assert.equal((await listCleanups("u1"))[0].status, "processing");
      clipMs.CLIP_MS = 0;
      assert.equal((await listCleanups("u1"))[0].status, "processing", "asked again at once, it is not checked twice");
      forgetCleanupChecks();
      const [done] = await listCleanups("u1");
      assert.deepEqual([done.status, done.cuts, done.originalSec, done.outputSec, done.reductionPct, done.progress], ["completed", 7, 64, 58.5, 8.6, undefined]);
      assert.match(done.videoUrl!, /\/demo\/render\.webm$/);
      assert.deepEqual(await listCleanups("u2"), [], "another account sees none");
      await assert.rejects(deleteCleanup(done.id, "u2"), NotFoundError);
      await deleteCleanup(done.id, "u1");
      assert.deepEqual(await listCleanups("u1"), []);
      await assert.rejects(deleteCleanup("../x", "u1"), /Unknown cleanup/);
    } finally {
      clipMs.CLIP_MS = saved;
    }
  });

  it("cleans a finished library video under its title, and refuses one that is not finished, trashed, or another account's", async () => {
    const video = await finished("u1");
    const job = await startCleanup(cleanupRequestSchema.parse({ videoId: video.id }), "u1");
    assert.deepEqual([job.title, job.videoId, job.sourceUrl], ["Q3 webinar (cleaned)", video.id, undefined]);
    const rendering = await finished("u1", { status: "processing", videoUrl: undefined });
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ videoId: rendering.id }), "u1"), /Only a finished video/);
    const trashed = await finished("u1", { deletedAt: now() });
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ videoId: trashed.id }), "u1"), /Restore the video/);
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ videoId: video.id }), "u2"), NotFoundError);
  });

  it("returns the same cleanup for a start retried with the same key, without asking the renderer again", async () => {
    const proto = MockAvatarProvider.prototype as unknown as { startCleanup: (...a: unknown[]) => Promise<{ jobId: string }> };
    const real = proto.startCleanup;
    const keys: unknown[] = [];
    proto.startCleanup = async function (this: unknown, ...a: unknown[]) {
      keys.push((a[0] as { key: string }).key);
      return real.apply(this, a);
    };
    try {
      const input = cleanupRequestSchema.parse({ sourceUrl: PUBLIC });
      let admitted = 0;
      const admit = () => void admitted++;
      const first = await startCleanup(input, "u1", { key: "retry-key-1", admit });
      const again = await startCleanup(input, "u1", { key: "retry-key-1", admit });
      assert.equal(again.id, first.id);
      assert.deepEqual([keys.length, admitted], [1, 1], "a repeat neither asks the renderer nor counts against the limit");
      assert.equal(keys[0], first.id, "the renderer's idempotency key is the cleanup's id");
      const other = await startCleanup(input, "u2", { key: "retry-key-1" });
      assert.notEqual(other.id, first.id, "the same key from another account is another cleanup");
      assert.notEqual((await startCleanup(input, "u1")).id, first.id, "without a key every start is new");
      await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: "https://93.184.216.34/other.mp4" }), "u1", { key: "retry-key-1" }), ConflictError, "the same key for another recording is refused");
      assert.throws(() => cleanupKeySchema.parse("short"), /8 to 100/);
      assert.throws(() => cleanupKeySchema.parse("has spaces in it"), /8 to 100/);
      // A start that is refused is not admitted.
      await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: "https://127.0.0.1/a.mp4" }), "u1", { key: "retry-key-2", admit }), ValidationError);
      assert.equal(admitted, 1);
    } finally {
      proto.startCleanup = real;
    }
  });

  it("goes with its library video when the video is deleted for good, and is not kept for one deleted while it started", async () => {
    const video = await finished("u1");
    const link = await startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC }), "u1");
    await startCleanup(cleanupRequestSchema.parse({ videoId: video.id }), "u1");
    await deleteVideo(video.id, "u1");
    assert.equal((await getStore().list("cleanup", "u1")).length, 2, "the trash keeps it, as it keeps the video");
    await deleteVideo(video.id, "u1", true);
    assert.deepEqual((await getStore().list<CleanupJob>("cleanup", "u1")).map((c) => c.id), [link.id], "a cleanup of a link stays");
    const gone = await finished("u1");
    const proto = MockAvatarProvider.prototype as unknown as { startCleanup: (...a: unknown[]) => Promise<{ jobId: string }> };
    const real = proto.startCleanup;
    proto.startCleanup = async function (this: unknown, ...a: unknown[]) {
      await getStore().remove("video", gone.id);
      return real.apply(this, a);
    };
    try {
      await assert.rejects(startCleanup(cleanupRequestSchema.parse({ videoId: gone.id }), "u1"), NotFoundError);
      assert.equal((await getStore().list<CleanupJob>("cleanup", "u1")).filter((c) => c.videoId === gone.id).length, 0);
    } finally {
      proto.startCleanup = real;
    }
  });

  it("asks the renderer about at most five cleanups per listing, the least recently checked first", async () => {
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    for (let i = 0; i < 8; i++) {
      await getStore().put("cleanup", { id: `cu_relink${i}`, ownerId: "u1", title: `Old ${i}`, provider: "mock", providerJobId: "mockcu_1", status: "completed", videoUrl: "https://r.example/x.mp4", createdAt: old, updatedAt: old, checkedAt: new Date(Date.parse(old) - i * 1000).toISOString() } satisfies CleanupJob);
    }
    const list = await listCleanups("u1");
    const renewed = list.filter((c) => c.checkedAt && Date.parse(c.checkedAt) > Date.now() - 60_000).map((c) => c.id).sort();
    assert.deepEqual(renewed, ["cu_relink3", "cu_relink4", "cu_relink5", "cu_relink6", "cu_relink7"]);
  });

  it("keeps at most the account's limit, and goes with the account", async () => {
    for (let i = 0; i < MAX_CLEANUPS; i++) {
      await getStore().put("cleanup", { id: `cu_old${i}`, ownerId: "u1", title: "Old", provider: "mock", providerJobId: "x", status: "failed", createdAt: now(), updatedAt: now() } satisfies CleanupJob);
    }
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC }), "u1"), ConflictError);
    const exported = (await exportOwnerData("u1")).cleanup;
    assert.equal(exported.length, MAX_CLEANUPS);
    assert.deepEqual(Object.keys(exported[0]).filter((k) => k === "provider" || k === "providerJobId"), [], "the renderer and its job id stay out of the export");
    assert.equal((await deleteOwnerData("u1")).cleanup, MAX_CLEANUPS);
  });

  it("asks HeyGen to clean the recording with a fresh link and an idempotency key, follows the job, and maps its answers", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
    let removal: Record<string, unknown> = { data: { status: "running", progress: 30 } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/videos/hg_video") return Response.json({ data: { status: "completed", video_url: "https://files.heygen.ai/fresh.mp4?sig=1" } });
      if (url === "https://api.heygen.com/v3/filler-word-removals" && init?.method === "POST") {
        if ((JSON.parse(String(init.body)) as { title: string }).title === "refuse") return Response.json({ error: { code: "invalid_parameter", message: "The video has no speech." } }, { status: 400 });
        return Response.json({ data: { filler_word_removal_id: "fwr_1" } });
      }
      if (url === "https://api.heygen.com/v3/filler-word-removals/fwr_1") return removal.gone ? Response.json({ error: { code: "not_found" } }, { status: 404 }) : Response.json(removal);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const video = await finished("u1", { provider: "heygen", providerJobId: "hg_video", videoUrl: "https://files.heygen.ai/old.mp4?sig=expired" });
      const job = await startCleanup(cleanupRequestSchema.parse({ videoId: video.id }), "u1");
      const post = calls.find((c) => c.method === "POST")!;
      assert.deepEqual(post.body, { video: { type: "url", url: "https://files.heygen.ai/fresh.mp4?sig=1" }, title: "Q3 webinar (cleaned)" });
      assert.equal(post.idem, job.id, "the studio's id makes a retried start return the same job");
      await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC, title: "refuse" }), "u1"), (e: unknown) => e instanceof ValidationError && /could not clean that recording: The video has no speech\./.test((e as Error).message));
      assert.equal((await listCleanups("u1"))[0].progress, 30);
      removal = { data: { status: "completed", progress: 100, video_url: "https://files2.heygen.ai/out.mp4?sig=a", thumbnail_url: "https://r.heygen.ai/t.webp", original_duration: 512.6, output_duration: 471.9, num_cuts: 23, reduction_pct: 7.9 } };
      forgetCleanupChecks();
      const [done] = await listCleanups("u1");
      assert.deepEqual(
        { status: done.status, videoUrl: done.videoUrl, thumbnailUrl: done.thumbnailUrl, originalSec: done.originalSec, outputSec: done.outputSec, cuts: done.cuts, reductionPct: done.reductionPct },
        { status: "completed", videoUrl: "https://files2.heygen.ai/out.mp4?sig=a", thumbnailUrl: "https://r.heygen.ai/t.webp", originalSec: 512.6, outputSec: 471.9, cuts: 23, reductionPct: 7.9 },
      );
      // A finished job without a cleaned video, a failed one, and one HeyGen no longer has each fail with a reason.
      const reset = async () => {
        await getStore().put("cleanup", { ...(await getStore().get<CleanupJob>("cleanup", job.id))!, status: "processing" });
        forgetCleanupChecks();
      };
      removal = { data: { status: "completed", video_url: "javascript:alert(1)" } };
      await reset();
      assert.deepEqual([(await listCleanups("u1"))[0].status, (await listCleanups("u1"))[0].error], ["failed", "HeyGen finished without a cleaned video"]);
      removal = { data: { status: "failed", failure_message: "No speech was found." } };
      await reset();
      const [failed] = await listCleanups("u1");
      assert.deepEqual([failed.status, failed.error, failed.videoUrl], ["failed", "No speech was found.", undefined], "a failure drops the old link");
      removal = { gone: true };
      await reset();
      assert.match((await listCleanups("u1"))[0].error!, /no longer available from HeyGen/);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("can be renamed, and a check landing meanwhile keeps the rename", async () => {
    const { renameCleanup } = await import("../services");
    const saved = clipMs.CLIP_MS;
    const store = getStore();
    const putIf = store.putIf.bind(store);
    try {
      clipMs.CLIP_MS = 60_000;
      const job = await startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC, title: "Started as" }), "u1", { key: "rename-key-1" });
      const renamed = await renameCleanup(job.id, "Renamed once", "u1");
      assert.equal(renamed.title, "Renamed once");
      assert.equal("askedTitle" in renamed, false, "the name it was started with is server only");
      assert.ok(renamed.updatedAt > job.updatedAt);
      assert.equal((await startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC, title: "Started as" }), "u1", { key: "rename-key-1" })).id, job.id, "a retried start is still the same one, renamed");
      const twice = await renameCleanup(job.id, "Renamed twice", "u1");
      assert.equal("askedTitle" in (await store.get<CleanupJob>("cleanup", job.id))!, false, "a cleanup's retry is not compared on its title, so the first one is not kept");
      assert.doesNotMatch(JSON.stringify(await exportOwnerData("u1")), /askedTitle|Started as/, "nor is it in the account export");
      assert.deepEqual(await renameCleanup(job.id, "Renamed twice", "u1"), twice, "the same name again changes nothing");
      // Not another account's, nor an unknown or malformed id.
      await assert.rejects(renameCleanup(job.id, "Mine", "u2"), NotFoundError);
      await assert.rejects(renameCleanup("cu_missing", "Gone", "u1"), NotFoundError);
      await assert.rejects(renameCleanup("../x", "Gone", "u1"), NotFoundError);
      // It finishes while being renamed: the rename lands while the renderer is asked, and both are kept.
      clipMs.CLIP_MS = 0;
      forgetCleanupChecks();
      store.putIf = async (kind, item, field, expected) => {
        store.putIf = putIf;
        await renameCleanup(job.id, "Renamed mid-check", "u1");
        return putIf(kind, item, field, expected);
      };
      const [done] = await listCleanups("u1");
      assert.deepEqual([done.title, done.status], ["Renamed mid-check", "completed"]);
      const stored = (await store.get<CleanupJob>("cleanup", job.id))!;
      assert.deepEqual([stored.title, stored.status, !!stored.videoUrl], ["Renamed mid-check", "completed", true]);
    } finally {
      store.putIf = putIf;
      clipMs.CLIP_MS = saved;
    }
  });

  it("keeps the later of two checks that land together, whichever writes first", async () => {
    const saved = clipMs.CLIP_MS;
    const store = getStore();
    const putIf = store.putIf.bind(store);
    try {
      // This check hears "still cleaning", but a later one (on another server) stored the finished cleanup first.
      clipMs.CLIP_MS = 60_000;
      const a = await startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC }), "u1");
      const later = (current: CleanupJob): CleanupJob => ({ ...current, status: "completed", videoUrl: "https://93.184.216.34/clean.mp4", checkedAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date(Date.parse(current.updatedAt) + 5).toISOString() });
      forgetCleanupChecks();
      store.putIf = async (kind, item, field, expected) => {
        store.putIf = putIf;
        await store.put("cleanup", later((await store.get<CleanupJob>("cleanup", a.id))!));
        return putIf(kind, item, field, expected);
      };
      const [kept] = await listCleanups("u1");
      assert.deepEqual([kept.status, kept.videoUrl], ["completed", "https://93.184.216.34/clean.mp4"], "the finished answer is not undone");
      assert.equal((await store.get<CleanupJob>("cleanup", a.id))!.status, "completed");
      // This check hears "finished", and an earlier one stored "still cleaning" first: the finished answer is written.
      await deleteCleanup(a.id, "u1");
      const b = await startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC }), "u1");
      clipMs.CLIP_MS = 0;
      forgetCleanupChecks();
      store.putIf = async (kind, item, field, expected) => {
        store.putIf = putIf;
        const current = (await store.get<CleanupJob>("cleanup", b.id))!;
        await store.put("cleanup", { ...current, progress: 40, checkedAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date(Date.parse(current.updatedAt) + 5).toISOString() });
        return putIf(kind, item, field, expected);
      };
      const [done] = await listCleanups("u1");
      assert.equal(done.status, "completed");
      assert.equal((await store.get<CleanupJob>("cleanup", b.id))!.status, "completed");
    } finally {
      store.putIf = putIf;
      clipMs.CLIP_MS = saved;
    }
  });

  it("is not offered by a renderer without it", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().fillerRemoval, false);
      await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC }), "u1"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
