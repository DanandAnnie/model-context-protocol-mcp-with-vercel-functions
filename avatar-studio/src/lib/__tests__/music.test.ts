// Background music (HeyGen's music catalog and HyperFrames): a catalog track, found by describing it, mixed under a
// finished library video with any sound effects placed at its moments, and rendered as a new video. The page sent to the renderer, what is accepted, what HeyGen is
// asked, how a mix is followed, and that it goes with its video and the account.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { MemoryStore } from "../store/memory";
import { MAX_MUSIC_MIXES, deleteMusicJob, deleteOwnerData, deleteVideo, exportOwnerData, forgetMusicChecks, listMusicJobs, musicRequestSchema, publicMusicJob, searchMusicTracks, startMusic } from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { musicComposition, musicSegments } from "../music-mix";
import { getStore } from "../store";
import type { MusicJob, Video } from "../types";

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetMusicChecks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
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

const clipMs = MockAvatarProvider as unknown as { CLIP_MS: number };
const request = (videoId: string, extra: Record<string, unknown> = {}) => musicRequestSchema.parse({ videoId, trackId: "demo_music_calm", query: "calm ambient", ...extra });

describe("the music mix page sent to the renderer", () => {
  it("lays the track end to end until the video ends, the last copy cut there", () => {
    assert.deepEqual(musicSegments(40, 16), [
      { start: 0, duration: 16 },
      { start: 16, duration: 16 },
      { start: 32, duration: 8 },
    ]);
    assert.deepEqual(musicSegments(10, 30), [{ start: 0, duration: 10 }], "a track longer than the video is cut at its end");
    assert.deepEqual(musicSegments(12, 0), [{ start: 0, duration: 12 }], "a track of unknown length plays once");
    assert.equal(musicSegments(30 * 60, 1).length, 1800, "as many copies as half an hour of one-second tracks needs");
    assert.deepEqual(musicSegments(12, 0.5), [{ start: 0, duration: 12 }], "a track under a second plays once");
  });

  it("is one page: the video full frame with its sound, the music under it faded in and out, links escaped", () => {
    const html = musicComposition({ videoUrl: 'https://cdn.example/v.mp4?a=1&b="2"', durationSec: 40, aspect: "9:16", musicUrl: "https://cdn.example/m.wav?sig=<x>", musicDurationSec: 16, volume: 0.25 });
    assert.match(html, /data-composition-id="music-mix" data-start="0" data-width="1080" data-height="1920" data-duration="40" data-no-timeline/);
    assert.match(html, /<video id="footage" src="https:\/\/cdn\.example\/v\.mp4\?a=1&amp;b=&quot;2&quot;" data-start="0" data-duration="40" data-has-audio="true"/);
    const audio = html.match(/<audio [^>]+>/g)!;
    assert.equal(audio.length, 3);
    assert.match(audio[0], /id="music-1" src="https:\/\/cdn\.example\/m\.wav\?sig=&lt;x&gt;" data-start="0" data-duration="16" data-media-start="0" data-volume="0\.25" data-fade-in="1"/);
    assert.doesNotMatch(audio[0], /data-fade-out/);
    assert.match(audio[2], /data-start="32" data-duration="8" .*data-fade-out="2"/);
    assert.doesNotMatch(html, /<script/i, "nothing runs in the page");
  });

  it("plays each sound effect once from its moment at full volume, cut at the video's end, and leaves out one past it", () => {
    const html = musicComposition({
      videoUrl: "https://cdn.example/v.mp4",
      durationSec: 40,
      aspect: "16:9",
      musicUrl: "https://cdn.example/m.wav",
      musicDurationSec: 60,
      volume: 0.25,
      effects: [
        { url: "https://cdn.example/whoosh.wav?a=1&b=2", atSec: 5, durationSec: 1.2 },
        { url: "https://cdn.example/chime.wav", atSec: 39.5, durationSec: 3 },
        { url: "https://cdn.example/late.wav", atSec: 45, durationSec: 1 },
        { url: "https://cdn.example/unknown.wav", atSec: 30, durationSec: 0 },
      ],
    });
    const effects = html.match(/<audio id="effect-[^>]+>/g)!;
    assert.equal(effects.length, 3);
    assert.equal(effects[0], '<audio id="effect-1" src="https://cdn.example/whoosh.wav?a=1&amp;b=2" data-start="5" data-duration="1.2" data-media-start="0" data-volume="1">');
    assert.match(effects[1], /data-start="39\.5" data-duration="0\.5"/, "cut where the video ends");
    assert.match(effects[2], /src="https:\/\/cdn\.example\/unknown\.wav" data-start="30" data-duration="10"/, "one of unknown length may play to the end");
    assert.doesNotMatch(html, /late\.wav/);
    assert.doesNotMatch(effects.join(""), /data-fade/, "effects are not faded");
  });
});

describe("background music", () => {
  it("is offered in demo mode, from the demo catalog, ranked by the description", async () => {
    assert.equal(providerStatus().backgroundMusic, true);
    const tracks = await searchMusicTracks("upbeat energetic");
    assert.equal(tracks[0].id, "demo_music_upbeat");
    assert.equal(tracks.length, 3);
    assert.match(tracks[0].previewUrl, /\/demo\/music-upbeat\.mp3$/);
    await assert.rejects(searchMusicTracks("x"), /Describe the music in a few words/);
  });

  it("mixes a track under a finished video, follows it until ready, and keeps it to the account", async () => {
    const saved = clipMs.CLIP_MS;
    try {
      clipMs.CLIP_MS = 60_000;
      const video = await finished("u1");
      const job = await startMusic(request(video.id, { volume: "medium" }), "u1");
      assert.match(job.id, /^mm_/);
      assert.deepEqual([job.status, job.title, job.trackName, job.volume], ["processing", "Founder update (with music)", "Calm morning", "medium"]);
      assert.deepEqual(Object.keys(publicMusicJob(job)).filter((k) => ["ownerId", "provider", "providerJobId"].includes(k)), []);
      clipMs.CLIP_MS = 0;
      forgetMusicChecks();
      const [done] = await listMusicJobs("u1");
      assert.equal(done.status, "completed");
      assert.match(done.videoUrl!, /\/demo\/render\./);
      assert.deepEqual(await listMusicJobs("u2"), []);
      await assert.rejects(deleteMusicJob(job.id, "u2"), NotFoundError);
      await deleteMusicJob(job.id, "u1");
      assert.deepEqual(await listMusicJobs("u1"), []);
    } finally {
      clipMs.CLIP_MS = saved;
    }
  });

  it("places sound effects from the demo catalog at moments of the video, in the order they play, retried by key", async () => {
    const effects = await searchMusicTracks("whoosh transition", "effects");
    assert.deepEqual(effects.map((t) => t.id).slice(0, 1), ["demo_effect_whoosh"]);
    assert.match(effects[0].previewUrl, /\/demo\/effect-whoosh\.mp3$/);
    await assert.rejects(searchMusicTracks("x", "effects"), /Describe the sound effect in a few words/);
    const proto = MockAvatarProvider.prototype as unknown as { startMusicMix: (...a: unknown[]) => Promise<{ jobId: string }> };
    const real = proto.startMusicMix;
    const sent: Array<{ effects?: unknown }> = [];
    proto.startMusicMix = async function (this: unknown, ...a: unknown[]) {
      sent.push(a[0] as { effects?: unknown });
      return real.apply(this, a);
    };
    try {
      const video = await finished("u1");
      const chosen = [
        { trackId: "demo_effect_pop", query: "pop click", atSec: 12.25 },
        { trackId: "demo_effect_whoosh", query: "whoosh transition", atSec: 3 },
      ];
      const job = await startMusic(request(video.id, { effects: chosen }), "u1", { key: "effects-key-1" });
      assert.deepEqual(job.effects, [
        { trackId: "demo_effect_whoosh", name: "Whoosh", query: "whoosh transition", atSec: 3 },
        { trackId: "demo_effect_pop", name: "Pop", query: "pop click", atSec: 12.25 },
      ]);
      assert.deepEqual(sent[0].effects, [
        { url: effects[0].previewUrl, atSec: 3, durationSec: 0.9 },
        { url: (await searchMusicTracks("pop", "effects"))[0].previewUrl, atSec: 12.25, durationSec: 0.4 },
      ]);
      // The same effects in another order are the same start; another moment is not.
      assert.equal((await startMusic(request(video.id, { effects: [...chosen].reverse() }), "u1", { key: "effects-key-1" })).id, job.id);
      assert.equal(sent.length, 1);
      await assert.rejects(startMusic(request(video.id, { effects: [{ ...chosen[0], atSec: 13 }, chosen[1]] }), "u1", { key: "effects-key-1" }), ConflictError);
      await assert.rejects(startMusic(request(video.id), "u1", { key: "effects-key-1" }), ConflictError, "nor is the mix without them");
      const twice = [
        { trackId: "demo_effect_pop", query: "pop click", atSec: 5 },
        { trackId: "demo_effect_pop", query: "bubble pop", atSec: 5 },
      ];
      const tie = await startMusic(request(video.id, { effects: twice }), "u1", { key: "effects-key-tie" });
      assert.equal((await startMusic(request(video.id, { effects: [...twice].reverse() }), "u1", { key: "effects-key-tie" })).id, tie.id, "one effect twice at one moment, in either order");
      // One past the end, or no longer offered, is refused before the renderer is asked; more than five never arrives.
      await assert.rejects(startMusic(request(video.id, { effects: [{ ...chosen[0], atSec: 40 }] }), "u1"), /at 0:40\.0 plays at or after the end of the video \(0:40\.0\)/);
      await assert.rejects(startMusic(request(video.id, { effects: [{ ...chosen[0], trackId: "gone" }] }), "u1"), (e: unknown) => e instanceof ValidationError && /no longer offered for “pop click”/.test((e as Error).message));
      assert.throws(() => request(video.id, { effects: Array.from({ length: 6 }, (_, i) => ({ ...chosen[0], atSec: i })) }), /at most 5 sound effects/);
      assert.throws(() => request(video.id, { effects: [{ ...chosen[0], atSec: -1 }] }), /0 seconds or later/);
      assert.throws(() => request(video.id, { effects: [{ ...chosen[0], atSec: 1801 }] }), /within the first 30 minutes/);
      // To a tenth, so the moment and the end are told apart (40.06 on a video of 40.04 reads 0:40.1 against 0:40.0).
      await assert.rejects(startMusic(request((await finished("u1", { durationSec: 40.04 })).id, { effects: [{ ...chosen[0], atSec: 40.06 }] }), "u1"), /at 0:40\.1 plays at or after the end of the video \(0:40\.0\)/);
      await assert.rejects(startMusic(request((await finished("u1", { durationSec: 59.96 })).id, { effects: [{ ...chosen[0], atSec: 59.97 }] }), "u1"), /at 1:00\.0 plays at or after the end of the video \(1:00\.0\)/);
      assert.equal(sent.length, 2, "only the start of the effect twice reached the renderer");
      // Each description is asked again once, and each ask counts against the account's searches.
      let searched = 0;
      await startMusic(request(video.id, { effects: [chosen[0], { ...chosen[0], atSec: 20 }, chosen[1]] }), "u1", { search: () => void searched++ });
      assert.equal(searched, 3, "the music's description and the two effects' descriptions");
    } finally {
      proto.startMusicMix = real;
    }
  });

  it("refuses what cannot be mixed, and a track the catalog no longer offers", async () => {
    await assert.rejects(startMusic(request((await finished("u1", { status: "processing", videoUrl: undefined })).id), "u1"), /Only a finished video/);
    await assert.rejects(startMusic(request((await finished("u1", { deletedAt: now() })).id), "u1"), /Restore the video/);
    await assert.rejects(startMusic(request((await finished("u1", { transparent: true })).id), "u1"), /transparent background/);
    await assert.rejects(startMusic(request((await finished("u1", { durationSec: undefined })).id), "u1"), /length is not known/);
    await assert.rejects(startMusic(request((await finished("u1", { durationSec: 31 * 60 })).id), "u1"), /up to 30 minutes/);
    await assert.rejects(startMusic(request((await finished("u2")).id), "u1"), NotFoundError);
    await assert.rejects(startMusic(request((await finished("u1")).id, { trackId: "gone" }), "u1"), (e: unknown) => e instanceof ValidationError && /no longer offered/.test((e as Error).message));
    assert.throws(() => musicRequestSchema.parse({ videoId: "v", trackId: "t", query: "calm", volume: "deafening" }));
  });

  it("returns the same mix for a start retried with the same key, without asking the renderer again", async () => {
    const proto = MockAvatarProvider.prototype as unknown as { startMusicMix: (...a: unknown[]) => Promise<{ jobId: string }> };
    const real = proto.startMusicMix;
    const keys: unknown[] = [];
    proto.startMusicMix = async function (this: unknown, ...a: unknown[]) {
      keys.push((a[0] as { key: string }).key);
      return real.apply(this, a);
    };
    try {
      const video = await finished("u1");
      let admitted = 0;
      const admit = () => void admitted++;
      const first = await startMusic(request(video.id), "u1", { key: "music-key-1", admit });
      const again = await startMusic(request(video.id), "u1", { key: "music-key-1", admit });
      assert.equal(again.id, first.id);
      assert.deepEqual([keys, admitted], [[first.id], 1]);
      await assert.rejects(startMusic(request(video.id, { volume: "high" }), "u1", { key: "music-key-1" }), ConflictError);
      await assert.rejects(startMusic(request(video.id, { query: "calm piano" }), "u1", { key: "music-key-1" }), ConflictError, "the description it was found with too");
      await assert.rejects(startMusic(request(video.id, { title: "Another title" }), "u1", { key: "music-key-1" }), ConflictError, "and a title given");
      assert.throws(() => musicRequestSchema.parse({ trackId: "t", query: "calm" }), /Choose one of your videos/);
      assert.throws(() => musicRequestSchema.parse({ videoId: "v", trackId: "t", query: "calm", title: "x".repeat(121) }), /Keep the title to 120 characters/);
    } finally {
      proto.startMusicMix = real;
    }
  });

  it("keeps at most the account's limit, goes with its video and the account, and leaves the renderer out of the export", async () => {
    const video = await finished("u1");
    for (let i = 0; i < MAX_MUSIC_MIXES; i++) {
      await getStore().put("music", { id: `mm_old${i}`, ownerId: "u1", title: "Old", videoId: video.id, trackId: "t", trackName: "T", query: "calm", volume: "low", provider: "mock", providerJobId: "mockmm_1", status: "failed", createdAt: now(), updatedAt: now() } satisfies MusicJob);
    }
    await assert.rejects(startMusic(request(video.id), "u1"), ConflictError);
    const exported = (await exportOwnerData("u1")).music;
    assert.equal(exported.length, MAX_MUSIC_MIXES);
    assert.deepEqual(Object.keys(exported[0]).filter((k) => ["provider", "providerJobId"].includes(k)), []);
    await deleteVideo(video.id, "u1");
    await deleteVideo(video.id, "u1", true);
    assert.equal((await getStore().list("music", "u1")).length, 0, "a video deleted for good takes its mixes with it");
    await getStore().put("music", { id: "mm_again", ownerId: "u1", title: "Again", videoId: "vid_x", trackId: "t", trackName: "T", query: "calm", volume: "low", provider: "mock", providerJobId: "mockmm_1", status: "failed", createdAt: now(), updatedAt: now() } satisfies MusicJob);
    assert.equal((await deleteOwnerData("u1")).music, 1);
  });

  it("asks HeyGen's catalog again for the track, sends HyperFrames one page with the video and the music, and follows the render", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
    let render: Record<string, unknown> | "gone" = { status: "rendering" };
    let refuse: { status: number; message: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url.startsWith("https://api.heygen.com/v3/audio/sounds?") && url.endsWith("type=sound_effects")) return Response.json({ data: [{ id: "sfx_1", name: "Whoosh 3", audio_url: "https://heygen-product.s3.amazonaws.com/w.wav?X-Amz=2", duration: 1.5, type: "sound_effects" }], has_more: false });
      if (url.startsWith("https://api.heygen.com/v3/audio/sounds?")) return Response.json({ data: [{ id: "trk_1", name: "Astral 1", description: "upbeat corporate", audio_url: "https://heygen-product.s3.amazonaws.com/m1.wav?X-Amz=1", duration: 30, score: 0.93, type: "music" }, { id: "trk_2", name: "No link", audio_url: null, duration: 20 }], has_more: false });
      if (url === "https://api.heygen.com/v3/videos/hg_video") return Response.json({ data: { status: "completed", video_url: "https://files.heygen.ai/fresh.mp4?sig=1" } });
      if (url === "https://api.heygen.com/v3/hyperframes/renders" && init?.method === "POST") {
        if (refuse) return Response.json({ error: { code: "invalid_parameter", message: refuse.message } }, { status: refuse.status });
        return Response.json({ data: { render_id: "hfr_1" } });
      }
      if (url === "https://api.heygen.com/v3/hyperframes/renders/hfr_1" && init?.method === "DELETE") return Response.json({ data: { render_id: "hfr_1" } });
      if (url === "https://api.heygen.com/v3/hyperframes/renders/hfr_1") return render === "gone" ? Response.json({ error: { code: "not_found" } }, { status: 404 }) : Response.json({ data: render });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const tracks = await searchMusicTracks("upbeat corporate");
      assert.deepEqual(tracks, [{ id: "trk_1", name: "Astral 1", description: "upbeat corporate", previewUrl: "https://heygen-product.s3.amazonaws.com/m1.wav?X-Amz=1", durationSec: 30 }], "a track without a link to hear is left out");
      assert.match(calls[0].url, /\/v3\/audio\/sounds\?query=upbeat%20corporate&limit=12&type=music$/);
      const video = await finished("u1", { provider: "heygen", providerJobId: "hg_video", aspect: "1:1", durationSec: 70, videoUrl: "https://files.heygen.ai/old.mp4?sig=expired" });
      const job = await startMusic(musicRequestSchema.parse({ videoId: video.id, trackId: "trk_1", query: "upbeat corporate", volume: "high" }), "u1", { key: "music-key-hg" });
      assert.equal(calls.filter((c) => c.url.includes("/v3/audio/sounds")).length, 2, "the track's link is asked for again at the start");
      const post = calls.find((c) => c.url.endsWith("/v3/hyperframes/renders") && c.method === "POST")!;
      assert.equal(post.idem, job.id);
      const body = post.body as { project: { type: string; media_type: string; data: string }; format: string; resolution: string; fps: number; quality: string; aspect_ratio: string; title: string };
      assert.deepEqual([body.project.type, body.project.media_type, body.format, body.resolution, body.fps, body.quality, body.aspect_ratio, body.title], ["base64", "application/zip", "mp4", "1080p", 25, "high", "1:1", "Founder update (with music)"]);
      const files = unzipSync(Buffer.from(body.project.data, "base64"));
      assert.deepEqual(Object.keys(files), ["index.html"]);
      const html = strFromU8(files["index.html"]);
      assert.match(html, /src="https:\/\/files\.heygen\.ai\/fresh\.mp4\?sig=1"/, "the video's link is renewed before it is sent");
      assert.match(html, /data-width="1080" data-height="1080" data-duration="70"/);
      assert.equal((html.match(/<audio /g) ?? []).length, 3, "a 30-second track under 70 seconds plays three times");
      assert.match(html, /data-volume="0\.6"/);
      // A sound effect is found in HeyGen's sound-effect catalog, asked again at the start, and played from its moment.
      assert.deepEqual(await searchMusicTracks("whoosh", "effects"), [{ id: "sfx_1", name: "Whoosh 3", previewUrl: "https://heygen-product.s3.amazonaws.com/w.wav?X-Amz=2", durationSec: 1.5 }]);
      assert.match(calls.at(-1)!.url, /\/v3\/audio\/sounds\?query=whoosh&limit=12&type=sound_effects$/);
      const withEffect = await startMusic(musicRequestSchema.parse({ videoId: video.id, trackId: "trk_1", query: "upbeat corporate", effects: [{ trackId: "sfx_1", query: "whoosh", atSec: 10 }] }), "u1", { key: "music-key-hg-sfx" });
      const sfxPost = calls.filter((c) => c.url.endsWith("/v3/hyperframes/renders") && c.method === "POST").find((c) => c.idem === withEffect.id)!;
      const sfxHtml = strFromU8(unzipSync(Buffer.from((sfxPost.body as { project: { data: string } }).project.data, "base64"))["index.html"]);
      assert.match(sfxHtml, /<audio id="effect-1" src="https:\/\/heygen-product\.s3\.amazonaws\.com\/w\.wav\?X-Amz=2" data-start="10" data-duration="1\.5" data-media-start="0" data-volume="1"><\/audio>/);
      await deleteMusicJob(withEffect.id, "u1");
      // Rendering, then done; a failed render says HeyGen's reason; a refused start is the account's with the reason.
      forgetMusicChecks();
      assert.equal((await listMusicJobs("u1"))[0].status, "processing");
      render = { status: "completed", video_url: "https://files.heygen.ai/mixed.mp4?sig=2", duration: 70.1 };
      forgetMusicChecks();
      const [done] = await listMusicJobs("u1");
      assert.deepEqual([done.status, done.videoUrl, done.durationSec], ["completed", "https://files.heygen.ai/mixed.mp4?sig=2", 70.1]);
      // Deleting it deletes the render at HeyGen, a full copy of the footage there.
      await deleteMusicJob(job.id, "u1");
      assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v3/hyperframes/renders/hfr_1")));
      // A render that fails says HeyGen's reason; one HeyGen no longer has, or one finished without a video, fails too.
      const failing = await startMusic(musicRequestSchema.parse({ videoId: video.id, trackId: "trk_1", query: "upbeat corporate" }), "u1");
      render = { status: "failed", failure_message: "The composition could not load its media." };
      forgetMusicChecks();
      assert.deepEqual([(await listMusicJobs("u1"))[0].status, (await listMusicJobs("u1"))[0].error], ["failed", "The composition could not load its media."]);
      await getStore().put("music", { ...(await getStore().get<MusicJob>("music", failing.id))!, status: "processing" });
      render = "gone";
      forgetMusicChecks();
      assert.match((await listMusicJobs("u1"))[0].error!, /no longer available from HeyGen/);
      await getStore().put("music", { ...(await getStore().get<MusicJob>("music", failing.id))!, status: "processing" });
      render = { status: "completed", video_url: null };
      forgetMusicChecks();
      assert.equal((await listMusicJobs("u1"))[0].error, "HeyGen finished without the video");
      // Deleting the account deletes the renders left at HeyGen.
      const deletes = calls.filter((c) => c.method === "DELETE").length;
      await deleteOwnerData("u1");
      assert.equal(calls.filter((c) => c.method === "DELETE").length, deletes + 1);
      refuse = { status: 400, message: "The project is invalid." };
      const again = await finished("u1", { provider: "heygen", providerJobId: "hg_video", aspect: "1:1", durationSec: 70 });
      await assert.rejects(startMusic(musicRequestSchema.parse({ videoId: again.id, trackId: "trk_1", query: "upbeat corporate" }), "u1"), (e: unknown) => e instanceof ValidationError && /could not add music to that video: The project is invalid\./.test((e as Error).message));
      // A start counts against the account's searches before the catalog is asked again.
      let searched = 0;
      await assert.rejects(startMusic(musicRequestSchema.parse({ videoId: again.id, trackId: "missing", query: "upbeat corporate" }), "u1", { search: () => void searched++ }), /no longer offered/);
      assert.equal(searched, 1);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("is not offered by a renderer without it", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().backgroundMusic, false);
      await assert.rejects(searchMusicTracks("calm ambient"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
