// Cinematic shots: a shot the renderer directs from a description with one to three of the account's presenters, made
// as a library video that a retry sends again, that a client key starts once, and that is not resized, subtitled,
// captioned, copied, or saved as a template here; and the request HeyGen's Cinematic Avatar gets.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addSubtitles, cinematicSchema, createTemplate, deleteVideo, getAvatar, queryVideos, rememberMadeLooks, resizeVideo, retryVideo, saveCaptionCues, startCinematic, videoQuerySchema } from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { shareBodyFor } from "../share-body";
import { providerStatus } from "../providers";
import { HEYGEN_LOOK_KEY } from "../providers/avatar/heygen";
import { getStore } from "../store";
import type { Avatar, Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const SHOT = { prompt: "Walks through a sunlit office toward the camera, gesturing at a whiteboard; handheld.", avatarIds: ["stock_1"] };

describe("cinematic shots", () => {
  it("checks the request: a description, one to three presenters each once, a length of 4 to 15 seconds or HeyGen's", () => {
    const ok = cinematicSchema.parse(SHOT);
    assert.deepEqual([ok.aspect, ok.resolution, ok.duration, ok.enhancePrompt], ["16:9", "1080p", "auto", false]);
    assert.equal(cinematicSchema.safeParse({ ...SHOT, prompt: "Walks" }).success, false, "a description is a sentence or more");
    assert.equal(cinematicSchema.safeParse({ ...SHOT, avatarIds: [] }).success, false);
    assert.equal(cinematicSchema.safeParse({ ...SHOT, avatarIds: ["a", "b", "c", "d"] }).success, false, "at most three presenters");
    assert.equal(cinematicSchema.safeParse({ ...SHOT, avatarIds: ["a", "a"] }).success, false, "each presenter once");
    assert.equal(cinematicSchema.safeParse({ ...SHOT, duration: 3 }).success, false);
    assert.equal(cinematicSchema.safeParse({ ...SHOT, duration: 16 }).success, false);
    assert.equal(cinematicSchema.parse({ ...SHOT, duration: 15 }).duration, 15);
    assert.equal(cinematicSchema.safeParse({ ...SHOT, aspect: "4:5" }).success, false, "HeyGen directs 16:9, 9:16, and 1:1 only");
  });

  it("makes the shot as a library video with no script, captions, or voice, named after its presenters", async () => {
    assert.equal(providerStatus().cinematicShots, true);
    const [a, b] = await Promise.all([getAvatar("stock_1", "u1"), getAvatar("stock_2", "u1")]);
    const video = await startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["stock_1", "stock_2"], aspect: "9:16", duration: 6, enhancePrompt: true }), "u1");
    assert.equal(video.status, "processing");
    assert.deepEqual([video.script, video.captions, video.aspect, video.avatarId, video.avatarName], ["", false, "9:16", "stock_1", `${a.name}, ${b.name}`]);
    assert.deepEqual(video.cinematic, { prompt: SHOT.prompt, avatarIds: ["stock_1", "stock_2"], avatarNames: [a.name, b.name], durationSec: 6, enhancePrompt: true });
    assert.equal(video.title, SHOT.prompt.slice(0, 80).replace(/\s+\S*$/, "") + "…", "untitled, it is named after the description's first words");
    assert.match(video.providerJobId ?? "", /_6$/, "the demo renderer makes a shot as long as asked");
    const auto = await startCinematic(cinematicSchema.parse({ ...SHOT, title: "Office" }), "u1");
    assert.deepEqual([auto.title, auto.cinematic?.durationSec], ["Office", undefined]);
    assert.match(auto.providerJobId ?? "", /_8$/, "a length left to the renderer is 8 seconds in the demo");
  });

  it("features only the account's own presenters", async () => {
    const theirs: Avatar = { id: "av_theirs", name: "Theirs", imageUrl: "https://93.184.216.34/p.png", source: "custom", provider: "mock", ownerId: "u2", createdAt: new Date().toISOString() };
    await getStore().put("avatar", theirs);
    await assert.rejects(startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["stock_1", "av_theirs"] }), "u1"), NotFoundError);
    await assert.rejects(startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["look_nobody_has"] }), "u1"), NotFoundError);
    assert.deepEqual(await getStore().list<Video>("video", "u1"), [], "nothing is stored or counted for a refused shot");
    const mine = await startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["av_theirs"] }), "u2");
    assert.equal(mine.avatarName, "Theirs");
  });

  it("is retried as the same shot, and is not resized, subtitled, captioned, copied, or saved as a template", async () => {
    const video = await startCinematic(cinematicSchema.parse({ ...SHOT, aspect: "1:1" }), "u1");
    await assert.rejects(resizeVideo(video.id, { aspects: ["16:9"] }, "u1"), /directed for its own shape/);
    await assert.rejects(createTemplate({ fromVideoId: video.id }, "u1"), /no script to save as a template/);
    await assert.rejects(addSubtitles(video.id, "Spanish", "u1", async () => "x"), /no script to subtitle/);
    await assert.rejects(saveCaptionCues(video.id, { cues: [{ startMs: 0, endMs: 1000, text: "Hi" }] }, "u1"), /no captions to edit/);
    const failed: Video = { ...video, id: "vid_shot_failed", status: "failed", error: "boom", providerJobId: undefined };
    await getStore().put("video", failed);
    const retried = await retryVideo(failed.id, "u1");
    assert.deepEqual([retried.status, retried.aspect, retried.script], ["processing", "1:1", ""]);
    assert.deepEqual(retried.cinematic, video.cinematic);
  });

  it("starts a shot once for a client key, and says when the key was used for another shot", async () => {
    const first = await startCinematic(cinematicSchema.parse(SHOT), "u1", { key: "shot-key-1" });
    const again = await startCinematic(cinematicSchema.parse(SHOT), "u1", { key: "shot-key-1" });
    assert.equal(again.id, first.id);
    assert.equal((await getStore().list<Video>("video", "u1")).length, 1);
    await assert.rejects(startCinematic(cinematicSchema.parse({ ...SHOT, prompt: `${SHOT.prompt} At dusk.` }), "u1", { key: "shot-key-1" }), ConflictError);
    await assert.rejects(startCinematic(cinematicSchema.parse({ ...SHOT, duration: 6 }), "u1", { key: "shot-key-1" }), ConflictError, "every setting of the shot is compared");
    await assert.rejects(startCinematic(cinematicSchema.parse({ ...SHOT, title: "Another title" }), "u1", { key: "shot-key-1" }), ConflictError);
    const theirs = await startCinematic(cinematicSchema.parse(SHOT), "u2", { key: "shot-key-1" });
    assert.notEqual(theirs.id, first.id, "another account's key is its own");
    await deleteVideo(first.id, "u1");
    await assert.rejects(startCinematic(cinematicSchema.parse(SHOT), "u1", { key: "shot-key-1" }), /in the trash; send a new key/);
  });

  it("is found by its description, shows no transcript when shared, and is named after its presenters as they are now", async () => {
    const video = await startCinematic(cinematicSchema.parse({ ...SHOT, title: "Office" }), "u1");
    const found = await queryVideos("u1", videoQuerySchema.parse({ q: "whiteboard" }));
    assert.deepEqual(found.videos.map((v) => v.id), [video.id]);
    await getStore().put("video", { ...video, status: "completed", videoUrl: "https://93.184.216.34/v.mp4" });
    const body = shareBodyFor((await getStore().get<Video>("video", video.id))!, null) as unknown as Record<string, unknown>;
    assert.equal("transcripts" in body, false, "a shot has no script to read along with");
    assert.equal("script" in body, false);
    // A retry names the presenters as they are when it starts.
    const mine: Avatar = { id: "av_mine", name: "Rae", imageUrl: "https://93.184.216.34/r.png", source: "custom", provider: "mock", ownerId: "u1", createdAt: new Date().toISOString() };
    await getStore().put("avatar", mine);
    const shot = await startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["av_mine"] }), "u1");
    await getStore().put("avatar", { ...mine, name: "Rae Lin" });
    await getStore().put("video", { ...shot, id: "vid_shot_renamed", status: "failed", providerJobId: undefined });
    const retried = await retryVideo("vid_shot_renamed", "u1");
    assert.deepEqual([retried.avatarName, retried.cinematic?.avatarNames], ["Rae Lin", ["Rae Lin"]]);
  });

  it("is refused by a renderer that does not direct shots", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      await assert.rejects(startCinematic(cinematicSchema.parse(SHOT), "u1"), (e: unknown) => e instanceof ValidationError && /not available with the did renderer/.test((e as Error).message));
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });

  it("asks HeyGen for a Cinematic Avatar video with the presenters' looks and the studio's video id as its key", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; idem: string | null }> = [];
    const realFetch = globalThis.fetch;
    let refuse = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url.startsWith("https://api.heygen.com/v3/avatars/looks?ownership=public")) return Response.json({ data: [{ id: "look_lib", name: "Library Lena", preview_image_url: "https://r.heygen.ai/l.png" }] });
      // The shared key's own looks include one made for another account (its photo avatar) and one the studio recorded.
      if (url.startsWith("https://api.heygen.com/v3/avatars/looks?ownership=private")) return Response.json({ data: [{ id: "look_u2", name: "Their photo", avatar_type: "photo_avatar" }, { id: "look_made", name: "Made here", avatar_type: "photo_avatar" }] });
      if (url === "https://api.heygen.com/v3/videos" && init?.method === "POST") {
        if (refuse) return Response.json({ error: { code: "invalid_parameter", message: "prompt is not allowed" } }, { status: 400 });
        return Response.json({ data: { video_id: "hg_cine_1", status: "pending" } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      // Another account's look, passed straight as a presenter, reads as not found, as does one the studio made.
      await getStore().put("avatar", { id: "av_u2", name: "Theirs", imageUrl: "https://93.184.216.34/t.png", source: "custom", provider: "heygen", ownerId: "u2", providerAssetIds: { [HEYGEN_LOOK_KEY]: "look_u2" }, createdAt: new Date().toISOString() } satisfies Avatar);
      await rememberMadeLooks(["look_made"]);
      await assert.rejects(startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["look_u2"] }), "u1"), NotFoundError);
      await assert.rejects(startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["look_made"] }), "u1"), NotFoundError);
      assert.equal(calls.filter((c) => c.method === "POST").length, 0, "HeyGen is not asked");
      const photo: Avatar = { id: "av_photo", name: "Dana", imageUrl: "https://93.184.216.34/d.png", source: "custom", provider: "heygen", ownerId: "u1", providerAssetIds: { [HEYGEN_LOOK_KEY]: "look_dana" }, createdAt: new Date().toISOString() };
      await getStore().put("avatar", photo);
      const video = await startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["av_photo", "look_lib"], aspect: "9:16", resolution: "720p", duration: 6, enhancePrompt: true, title: "Office walk" }), "u1", { key: "shot-key-hg" });
      const post = calls.find((c) => c.method === "POST")!;
      assert.deepEqual(
        post.body,
        { type: "cinematic_avatar", prompt: SHOT.prompt, avatar_id: ["look_dana", "look_lib"], aspect_ratio: "9:16", resolution: "720p", duration: 6, enhance_prompt: true, title: "Office walk" },
        "the photo avatar's HeyGen look and the library look, and no callback_url, which HeyGen refuses for these",
      );
      assert.equal(post.idem, video.id, "a start repeated after a lost answer is replayed at HeyGen, not directed twice");
      assert.deepEqual([video.providerJobId, video.status, video.avatarName], ["hg_cine_1", "processing", "Dana, Library Lena"]);
      await startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["look_lib"] }), "u1");
      const auto = calls.filter((c) => c.method === "POST").at(-1)!;
      assert.deepEqual([auto.body?.auto_duration, "duration" in (auto.body ?? {}), "enhance_prompt" in (auto.body ?? {}), auto.body?.resolution, auto.idem], [true, false, false, "1080p", null]);
      // A shot HeyGen refuses is stored as failed with its reason and not counted.
      refuse = true;
      const failed = await startCinematic(cinematicSchema.parse({ ...SHOT, avatarIds: ["look_lib"] }), "u1");
      assert.equal(failed.status, "failed");
      assert.match(failed.error ?? "", /prompt is not allowed/);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });
});
