// Fixing spoken lines in a finished video in place (HeyGen's video edit, POST /v3/videos/{id}): which videos and scenes
// can be fixed, what HeyGen is asked, how the stored video follows, and that a fix is counted once.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { brandKitSchema, fixVideoLines, lineFixSchema, rendersThisMonth, saveBrandKit, updateVideo, videoPatchSchema } from "../services";
import { LINE_FIX_UNCONFIRMED_MS, applyAvatarWebhook, getVideo, settleLineFix } from "../services/videos";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { getStore } from "../store";
import { lineFixProblem, spokenLines } from "../line-fixes";
import type { Video } from "../types";
import { forgetMemo } from "../cache";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetMemo();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const started = Date.now() - 60_000;
/** A finished three-scene video: a spoken scene, a scene playing a recording, and one more spoken scene with a pause. */
function finished(extra: Partial<Video> = {}): Video {
  const now = new Date().toISOString();
  return {
    id: "vid_fix1",
    ownerId: "u1",
    title: "Quarterly update",
    script: "Hello and welcome.",
    avatarId: STOCK_AVATARS[0].id,
    voiceId: STOCK_VOICES[0].id,
    aspect: "16:9",
    background: { type: "color", value: "#f1f5f9" },
    captions: false,
    speed: 1,
    scenes: [
      { script: "Hello and welcome.", background: { type: "color", value: "#f1f5f9" }, name: "Opening" },
      { script: "What the recording says.", audioId: "clip_1", background: { type: "color", value: "#f1f5f9" } },
      { script: "Revenue grew ten percent. [pause] Thanks for watching.", background: { type: "color", value: "#f1f5f9" } },
    ],
    status: "completed",
    provider: "mock",
    providerJobId: `mock_${started}_30`,
    videoUrl: "/demo/sample.mp4",
    createdAt: now,
    updatedAt: now,
    ...extra,
  } as Video;
}

const fix = (scenes: Array<{ scene: number; from: string; script: string }>) => lineFixSchema.parse({ scenes });

describe("fixing a line in a finished video", () => {
  it("knows which videos and scenes can be fixed", () => {
    const v = finished();
    assert.equal(lineFixProblem(v), null);
    assert.deepEqual(
      spokenLines(v).map((l) => [l.scene, l.spoken]),
      [
        [1, true],
        [2, false],
        [3, true],
      ],
      "a scene playing a recording has no line to fix",
    );
    assert.match(lineFixProblem(finished({ status: "processing" }))!, /once the video is ready/);
    assert.match(lineFixProblem(finished({ provider: "did" }))!, /did renderer/);
    assert.match(lineFixProblem(finished({ deletedAt: new Date().toISOString() }))!, /trash/);
    assert.match(lineFixProblem(finished({ transparent: true }))!, /transparent/);
    assert.match(lineFixProblem(finished({ directed: { brief: "b", prompt: "b", orientation: "landscape", lengthSec: 60, language: "English" } } as Partial<Video>))!, /Edit scenes/);
    assert.match(lineFixProblem(finished({ scenes: [{ script: "[pause 2s]", background: { type: "color", value: "#fff" } }] } as Partial<Video>))!, /no spoken lines/);
    // A one-scene video keeps its words on the video itself.
    assert.deepEqual(spokenLines({ script: "Just this." }), [{ scene: 1, script: "Just this.", spoken: true }]);
  });

  it("takes up to ten scenes, each once", () => {
    assert.throws(() => fix([]), /at least one scene/);
    assert.throws(() => fix([{ scene: 1, from: "a", script: "b" }, { scene: 1, from: "a", script: "c" }]), /each scene once/);
    assert.throws(() => fix(Array.from({ length: 11 }, (_, i) => ({ scene: i + 1, from: "a", script: "b" }))), /at most 10 scenes/);
    assert.throws(() => fix([{ scene: 1, from: "a", script: "  " }]), /new words/);
  });

  it("in demo mode, reserves the fix, re-renders the video in place, sets aside what spoke the old words, and counts one render", async () => {
    await getStore().put("video", finished({ captionCues: [{ startMs: 0, endMs: 1000, text: "Old words" }], subtitles: { Spanish: "Hola" }, review: { status: "approved", requestedById: "u1", requestedAt: new Date().toISOString() }, views: 7 } as Partial<Video>));
    const usage = async () => (await getStore().get<{ count: number }>("usage", `usage_u1_${new Date().toISOString().slice(0, 7)}`))?.count ?? 0;
    const body = fix([{ scene: 3, from: "Revenue grew ten percent. [pause] Thanks for watching.", script: "Revenue grew fifteen percent. [pause] Thanks for watching." }]);
    const { video: next, sent } = await fixVideoLines("vid_fix1", body, "u1");
    assert.equal(sent, true);
    assert.equal(next.id, "vid_fix1", "the same video");
    assert.equal(next.status, "processing");
    assert.notEqual(next.providerJobId, `mock_${started}_30`, "the demo renderer renders it again");
    assert.equal(next.scenes![2].script, "Revenue grew fifteen percent. [pause] Thanks for watching.");
    assert.equal(next.scenes![0].script, "Hello and welcome.", "other scenes keep their words");
    assert.equal(next.script, "Hello and welcome.\n\nWhat the recording says.\n\nRevenue grew fifteen percent. [pause] Thanks for watching.", "the video's script follows its scenes");
    assert.deepEqual([next.lineFix!.scenes, next.lineFix!.count, next.lineFix!.pending!.sent], [[3], 1, true]);
    // What spoke the old words is set aside until the new render is ready; an approval is taken off; counts are kept.
    for (const gone of ["videoUrl", "durationSec", "captionCues", "subtitles", "review"] as const) assert.equal(next[gone], undefined, `${gone} is set aside`);
    assert.equal(next.views, 7);
    assert.equal(next.lineFix!.pending!.before.videoUrl, "/demo/sample.mp4");
    assert.equal(await usage(), 1, "counted as a render");
    assert.equal(next.lineFix!.pending!.countedIn, new Date().toISOString().slice(0, 7));
    // The same request again (a retry) is answered with the video as it is, not sent or counted again, even listing a scene it leaves as it was.
    const again = await fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hello and welcome.", script: "Hello and welcome." }, ...body.scenes]), "u1");
    assert.deepEqual([again.sent, again.video.providerJobId], [false, next.providerJobId]);
    assert.equal(await usage(), 1);
    // Another fix waits for this one.
    await assert.rejects(fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hello and welcome.", script: "Hi." }]), "u1"), /still being made/);
    assert.ok((await rendersThisMonth("u1")) >= 1);
  });

  it("sends one fix for two requests sent at once", async () => {
    await getStore().put("video", finished());
    const body = fix([{ scene: 1, from: "Hello and welcome.", script: "Hello, and welcome back." }]);
    const results = await Promise.all([fixVideoLines("vid_fix1", body, "u1"), fixVideoLines("vid_fix1", body, "u1")]);
    assert.deepEqual(results.map((r) => r.sent).sort(), [false, true]);
    assert.equal((await getStore().get<{ count: number }>("usage", `usage_u1_${new Date().toISOString().slice(0, 7)}`))?.count, 1);
  });

  it("refuses what cannot be fixed: words changed meanwhile, a recording, only pauses, no change, too many words, another account's video", async () => {
    await getStore().put("video", finished());
    await assert.rejects(fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hi.", script: "Hello there." }]), "u1"), (e: unknown) => e instanceof ConflictError && /changed since they were read/.test((e as Error).message));
    await assert.rejects(fixVideoLines("vid_fix1", fix([{ scene: 2, from: "What the recording says.", script: "New words." }]), "u1"), /plays a recording, or holds a pause/);
    await assert.rejects(fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hello and welcome.", script: "[pause 2s]" }]), "u1"), /needs words to speak/);
    await assert.rejects(fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hello and welcome.", script: "Hello and welcome." }]), "u1"), /Change the words of at least one scene/);
    await assert.rejects(fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hello and welcome.", script: "word ".repeat(999).trim() }]), "u1"), /together are at most 5,000 characters/);
    await assert.rejects(fixVideoLines("vid_fix1", fix([{ scene: 9, from: "x", script: "y" }]), "u1"), /no scene 9/);
    await assert.rejects(fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hello and welcome.", script: "Hi." }]), "u2"), NotFoundError);
    await getStore().put("video", finished({ status: "processing" }));
    await assert.rejects(fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hello and welcome.", script: "Hi." }]), "u1"), (e: unknown) => e instanceof ValidationError && /once the video is ready/.test((e as Error).message));
    assert.equal((await getStore().get<Video>("video", "vid_fix1"))!.scenes![0].script, "Hello and welcome.");
  });

  it("keeps a fix that an owner edit, read before it, writes back after it", async () => {
    await getStore().put("video", finished());
    // A share password is hashed before the edit is written, so the fix lands in between.
    const [edited, fixed] = await Promise.all([updateVideo("vid_fix1", videoPatchSchema.parse({ sharePassword: "correct horse" }), "u1"), fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hello and welcome.", script: "Hi there." }]), "u1")]);
    assert.equal(fixed.sent, true);
    const stored = (await getStore().get<Video>("video", "vid_fix1"))!;
    assert.deepEqual([stored.status, stored.scenes![0].script, stored.lineFix?.pending?.sent, stored.providerJobId, stored.shareLocked], ["processing", "Hi there.", true, fixed.video.providerJobId, true]);
    assert.equal(edited.shareLocked, true);
  });

  it("takes only a completion after the fix was sent as the fix's, and undoes a fix whose render failed", () => {
    const sentAt = Date.parse("2026-11-06T12:00:30.500Z");
    const before = finished();
    const pendingFix = (sent = true): Video => ({
      ...before,
      status: "processing",
      videoUrl: undefined,
      scenes: before.scenes!.map((sc, i) => (i === 0 ? { ...sc, script: "Hi." } : sc)),
      lineFix: { at: new Date(sentAt).toISOString(), scenes: [1], count: 1, key: "lf_k", pending: { editVersion: "ev", edits: [], attempts: 1, ...(sent ? { sent: true as const } : {}), countedIn: "2026-11", before: { scenes: before.scenes, script: before.script, videoUrl: before.videoUrl } } },
    });
    const current = pendingFix();
    const completed = { ...current, status: "completed" as const, videoUrl: "https://files.heygen.ai/new.mp4", durationSec: 31 };
    // The earlier render's completion (before the fix was sent) is not the fix's: nothing is written.
    assert.equal(settleLineFix(current, completed, "2026-11-06T11:58:00.000Z", sentAt + 5000), current);
    // One in the same second, or later, is.
    const done = settleLineFix(current, completed, "2026-11-06T12:00:30.000Z", sentAt + 5000);
    assert.deepEqual([done.status, done.videoUrl, done.lineFix!.pending, done.lineFix!.count], ["completed", "https://files.heygen.ai/new.mp4", undefined, 1]);
    // Undated: taken only a minute after the fix.
    assert.equal(settleLineFix(current, completed, undefined, sentAt + 5000), current);
    assert.equal(settleLineFix(current, completed, undefined, sentAt + 61_000).status, "completed");
    // A render that fails leaves the video as it was, with the reason, and the fix not counted among the video's fixes.
    const failed = settleLineFix(current, { ...current, status: "failed", error: "Avatar III scenes cannot be edited" });
    assert.deepEqual([failed.status, failed.videoUrl, failed.scenes![0].script, failed.lineFix!.error, failed.lineFix!.count, failed.lineFix!.pending], ["completed", before.videoUrl, "Hello and welcome.", "Avatar III scenes cannot be edited", 0, undefined]);
    // A fix HeyGen never confirmed, whose render never came, is given up on after ten minutes.
    const unsent = pendingFix(false);
    const old = { ...unsent, status: "completed" as const, videoUrl: before.videoUrl };
    assert.equal(settleLineFix(unsent, old, "2026-11-06T11:58:00.000Z", sentAt + 60_000), unsent);
    const gaveUp = settleLineFix(unsent, old, "2026-11-06T11:58:00.000Z", sentAt + LINE_FIX_UNCONFIRMED_MS + 1);
    assert.deepEqual([gaveUp.status, gaveUp.scenes![0].script], ["completed", "Hello and welcome."]);
    assert.match(gaveUp.lineFix!.error!, /never confirmed/);
  });

  it("asks HeyGen for the scenes, then edits the lines named with the edit version, pauses as breaks, and the brand's pronunciations", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
    let edit: Response | (() => Response) = () => Response.json({ data: { video_id: "hg_v1", status: "pending", version_id: "ver_2" } });
    // The video as HeyGen reports it: its earlier render, finished a while ago, until the fix's render starts.
    let status: Record<string, unknown> = { status: "completed", video_url: "https://files.heygen.ai/old.mp4", duration: 30, completed_at: Math.floor(Date.now() / 1000) - 3600 };
    let scenes = {
      video_id: "hg_v1",
      edit_version: "ev_1",
      scenes: [
        { id: "sc_1", script: [{ id: "ln_1", type: "text", text: "Hello and welcome." }] },
        { id: "sc_2", script: [{ id: "au_2", type: "audio" }] },
        { id: "sc_3", script: [{ id: "ln_3", type: "text", text: "Revenue grew." }] },
      ],
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, idem: new Headers(init?.headers).get("idempotency-key") });
      // The voices' languages are read for the pronunciations; nothing else of HeyGen's lists matters here.
      if (/\/voices(\?|$)|\/avatars\/looks\?/.test(url)) return Response.json({ data: [], has_more: false });
      if (url === "https://api.heygen.com/v3/videos/hg_v1/scenes") return Response.json({ data: scenes });
      if (url === "https://api.heygen.com/v3/videos/hg_v1" && method === "POST") return typeof edit === "function" ? edit() : edit;
      if (url === "https://api.heygen.com/v3/videos/hg_v1") return Response.json({ data: status });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#112233", pronunciations: [{ word: "Acme", sayAs: "Ack-mee" }] }), "u1");
      await getStore().put("video", finished({ provider: "heygen", providerJobId: "hg_v1" }));
      const { video: next } = await fixVideoLines("vid_fix1", fix([{ scene: 3, from: "Revenue grew ten percent. [pause] Thanks for watching.", script: "Acme revenue grew. [pause 1.5s] Thanks." }]), "u1");
      const post = calls.find((c) => c.method === "POST")!;
      assert.deepEqual(post.body, { edit_version: "ev_1", scenes: [{ id: "sc_3", script: [{ id: "ln_3", type: "text", text: 'Ack-mee revenue grew. <break time="1.5s"/> Thanks.' }] }] });
      assert.match(post.idem!, /^lf_[A-Za-z0-9_-]{40}$/);
      assert.equal(next.providerJobId, "hg_v1", "HeyGen renders the same video again");
      assert.equal(next.scenes![2].script, "Acme revenue grew. [pause 1.5s] Thanks.", "the stored words keep the spelling");
      // HeyGen still answers with the earlier render, finished: neither a check nor a late webhook for it ends the fix.
      assert.equal((await getVideo("vid_fix1", "u1")).status, "processing");
      assert.equal((await applyAvatarWebhook("heygen", { event_type: "avatar_video.success", event_data: { video_id: "hg_v1", url: "https://files.heygen.ai/old.mp4" } }))!.status, "processing");
      status = { status: "processing" };
      assert.equal((await getVideo("vid_fix1", "u1")).status, "processing");
      // The fix's render, finished after it was sent: the video is ready again, with its new length.
      status = { status: "completed", video_url: "https://files.heygen.ai/new.mp4", duration: 31.5, completed_at: Math.floor(Date.now() / 1000) + 1 };
      const ready = await getVideo("vid_fix1", "u1");
      assert.deepEqual([ready.status, ready.videoUrl, ready.durationSec, ready.lineFix!.pending, ready.lineFix!.count], ["completed", "https://files.heygen.ai/new.mp4", 31.5, undefined, 1]);
      // An answer lost on the way back keeps the fix reserved; sending it again sends the same key and body.
      edit = () => new Response("upstream timeout", { status: 500 });
      const lost = fix([{ scene: 1, from: "Hello and welcome.", script: "Hello again." }]);
      await assert.rejects(fixVideoLines("vid_fix1", lost, "u1"), /did not confirm the fix; send it again/);
      const reserved = (await getStore().get<Video>("video", "vid_fix1"))!;
      assert.deepEqual([reserved.status, reserved.scenes![0].script, reserved.lineFix!.pending!.sent], ["processing", "Hello again.", undefined]);
      edit = () => Response.json({ data: { video_id: "hg_v1", status: "pending", version_id: "ver_3" } });
      const resent = await fixVideoLines("vid_fix1", lost, "u1");
      assert.equal(resent.sent, true);
      const posts = calls.filter((c) => c.method === "POST");
      assert.deepEqual(posts.at(-1), { ...posts.at(-2)!, url: posts.at(-1)!.url }, "the same key and body");
      assert.equal(resent.video.lineFix!.pending!.sent, true);
      // Its render fails: the video is as it was, the reason noted, the render given back.
      const used = async () => (await getStore().get<{ count: number }>("usage", `usage_u1_${new Date().toISOString().slice(0, 7)}`))?.count ?? 0;
      const before = await used();
      status = { status: "failed", failure_message: "The avatar needs consent before it can render" };
      const undone = await getVideo("vid_fix1", "u1");
      assert.deepEqual([undone.status, undone.scenes![0].script, undone.videoUrl, undone.lineFix!.error], ["completed", "Hello and welcome.", "https://files.heygen.ai/new.mp4", "The avatar needs consent before it can render"]);
      assert.equal(await used(), before - 1);
      // Two resends at once of a fix whose answer was lost send it once and count it once.
      edit = () => new Response("upstream timeout", { status: 500 });
      const twice = fix([{ scene: 1, from: "Hello and welcome.", script: "Hello, everyone." }]);
      await assert.rejects(fixVideoLines("vid_fix1", twice, "u1"), /send it again/);
      edit = () => Response.json({ data: { video_id: "hg_v1", status: "pending" } });
      const postsBefore = calls.filter((c) => c.method === "POST").length;
      const usedBefore = await used();
      const both = await Promise.all([fixVideoLines("vid_fix1", twice, "u1"), fixVideoLines("vid_fix1", twice, "u1")]);
      assert.deepEqual(both.map((b) => b.sent).sort(), [false, true]);
      assert.equal(calls.filter((c) => c.method === "POST").length, postsBefore + 1, "sent once");
      assert.equal(await used(), usedBefore + 1, "counted once");
      // That fix fails too: given back as well, though it is the video's second failed fix.
      status = { status: "failed", failure_message: "The avatar needs consent before it can render" };
      const again = await getVideo("vid_fix1", "u1");
      assert.deepEqual([again.status, again.scenes![0].script], ["completed", "Hello and welcome."]);
      assert.equal(await used(), usedBefore, "the second failed fix is given back too");
      // HeyGen's answers mapped: the version moved on, the video still rendering, an edit it will not make.
      await getStore().put("video", finished({ provider: "heygen", providerJobId: "hg_v1" }));
      const ask = () => fixVideoLines("vid_fix1", fix([{ scene: 1, from: "Hello and welcome.", script: "Hi there." }]), "u1");
      edit = Response.json({ error: { code: "stale_edit_version", message: "stale" } }, { status: 409 });
      await assert.rejects(ask(), (e: unknown) => e instanceof ConflictError && /changed at HeyGen/.test((e as Error).message));
      edit = Response.json({ error: { code: "resource_not_ready", message: "rendering" } }, { status: 409 });
      await assert.rejects(ask(), /still rendering this video/);
      edit = Response.json({ error: { code: "edit_not_supported", message: "Avatar III scenes cannot be edited", param: "scenes.0" } }, { status: 400 });
      await assert.rejects(ask(), (e: unknown) => e instanceof ValidationError && /could not fix those lines: Avatar III scenes cannot be edited/.test((e as Error).message));
      const refused = (await getStore().get<Video>("video", "vid_fix1"))!;
      assert.deepEqual([refused.status, refused.scenes![0].script, refused.lineFix, refused.videoUrl], ["completed", "Hello and welcome.", undefined, "/demo/sample.mp4"], "a refused fix leaves the video as it was, without a trace");
      // HeyGen holding other scenes than the studio sent, or a scene without one line, is not guessed at.
      scenes = { ...scenes, scenes: scenes.scenes.slice(0, 2) };
      await assert.rejects(ask(), /no longer matches its scenes here/);
      scenes = { ...scenes, scenes: [{ id: "sc_1", script: [] }, scenes.scenes[1], { id: "sc_3", script: [] }] };
      await assert.rejects(ask(), /without one spoken line/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });
});
