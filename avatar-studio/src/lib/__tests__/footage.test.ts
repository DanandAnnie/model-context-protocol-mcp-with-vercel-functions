// Generated clips (HeyGen Video): a short shot from a description, from a picture as its first frame, or featuring
// pictures the description names, kept to watch, download, or loop as a scene's video background. What is accepted,
// what HeyGen is asked, how clips are followed, and how a render loops one with a fresh link.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createVideo, deleteFootage, exportOwnerData, footageForRender, footageLink, footageRequestSchema, forgetFootageChecks, listFootage, publicFootage, startFootage, videoRequestSchema } from "../services";
import { ConflictError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { getStore } from "../store";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { footageIdOf, footagePath, type FootageJob } from "../types";

const PROMPT = "A slow push-in on a sunlit kitchen; steam rises from a coffee cup";
const png = (...extra: number[]) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]).toString("base64")}`;
const ask = (extra: Record<string, unknown> = {}) => footageRequestSchema.parse({ prompt: PROMPT, ...extra });

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetFootageChecks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Makes a stored clip look finished, its link last checked `ageMs` ago. */
async function finished(job: FootageJob, ageMs = 0): Promise<FootageJob> {
  const at = new Date(Date.now() - ageMs).toISOString();
  return getStore().put("footage", { ...job, status: "completed" as const, videoUrl: "https://files.heygen.ai/old.mp4", checkedAt: at, updatedAt: at });
}

describe("generated clips", () => {
  it("take a description of 10 to 2,000 characters, 5 to 30 seconds, a frame or a picture, and a quality", () => {
    assert.throws(() => footageRequestSchema.parse({ prompt: "kitchen" }), /few words/);
    assert.throws(() => ask({ prompt: "x".repeat(2001) }), /at most 2000/);
    assert.throws(() => ask({ durationSec: 4 }), /at least 5 seconds/);
    assert.throws(() => ask({ durationSec: 31 }), /at most 30 seconds/);
    assert.throws(() => ask({ durationSec: "10" }), /number of seconds/);
    assert.equal(ask({ durationSec: 30 }).durationSec, 30, "a clip from a description runs up to 30 seconds");
    assert.equal(ask({ durationSec: 30, image: png() }).durationSec, 30, "so does one from a first frame");
    // Featuring pictures, or the description followed exactly, keeps HeyGen to 15 seconds.
    assert.throws(() => ask({ durationSec: 16, exact: true }), /at most 15 seconds/);
    assert.ok(ask({ durationSec: 15, exact: true }));
    assert.throws(() => ask({ durationSec: 7.5 }), /whole number of seconds/);
    // The first message (the one the page shows) never offers 30 seconds to a clip that is held to 15.
    for (const extra of [{ durationSec: 40, references: [png()] }, { durationSec: 31, exact: true }, { durationSec: 3, exact: true }, { durationSec: 12.5, exact: true }]) {
      const first = footageRequestSchema.safeParse({ prompt: PROMPT, ...extra }).error?.issues[0]?.message ?? "";
      assert.ok(first && !/5 to 30|from 5 to/.test(first) && (!/30/.test(first) || /15 when/.test(first)), `${JSON.stringify(extra)}: ${first}`);
    }
    // A seed is HeyGen's unsigned 32-bit number.
    assert.equal(ask({ seed: 0 }).seed, 0);
    assert.equal(ask({ seed: 4_294_967_295 }).seed, 4_294_967_295);
    assert.throws(() => ask({ seed: 4_294_967_296 }), /at most 4294967295/);
    assert.throws(() => ask({ seed: -1 }), /0 or more/);
    assert.throws(() => ask({ seed: 1.5 }), /whole number/);
    assert.throws(() => ask({ aspect: "4:3" }));
    assert.throws(() => ask({ quality: "2k" }));
    assert.throws(() => ask({ image: png(), aspect: "16:9" }), /picture's shape/);
    assert.throws(() => ask({ aspect: "1:1", quality: "hd" }), /landscape or portrait/);
    assert.ok(ask({ image: png(), quality: "hd" }), "a picture sets the shape, so HD is fine");
    assert.throws(() => ask({ mode: "text_to_video" }), /mode/, "unknown fields are refused");
    const plain = ask();
    assert.deepEqual([plain.durationSec, plain.aspect, plain.quality], [5, undefined, "standard"]);
  });

  it("are made in demo mode, followed until ready, named after the description, and kept private", async () => {
    assert.equal(providerStatus().generatedFootage, true);
    const job = await startFootage(ask({ durationSec: 8, aspect: "9:16" }), "u1");
    assert.match(job.id, /^ft_/);
    assert.deepEqual([job.status, job.durationSec, job.aspect, job.quality, job.title], ["processing", 8, "9:16", "standard", "A slow push-in on a sunlit kitchen; steam rises from a…"]);
    const view = publicFootage(job);
    assert.deepEqual(["ownerId", "provider", "providerJobId", "imageDigest"].filter((k) => k in view), [], "the renderer and its job stay on the server");
    assert.equal((await listFootage("u1"))[0].status, "processing", "the demo takes a few seconds");
    await getStore().put("footage", { ...job, providerJobId: `mockft_${Date.now() - 10_000}_8` });
    forgetFootageChecks();
    const [done] = await listFootage("u1");
    assert.equal(done.status, "completed");
    assert.match(done.videoUrl!, /\/demo\//);
    assert.equal(done.durationSec, 8, "the length asked for is kept");
    assert.deepEqual(await listFootage("u2"), [], "another account sees none");
    await assert.rejects(footageLink(job.id, "u2"), /not found/i);
    const exported = JSON.stringify(await exportOwnerData("u1"));
    assert.ok(exported.includes(job.id));
    assert.equal(exported.includes("mockft_"), false, "the renderer's job id is not exported");
  });

  it("start from a picture, checked to be a PNG or JPEG of at most 3 MB", async () => {
    await assert.rejects(startFootage(ask({ image: "https://example.com/a.png" }), "u1"), /must be an image file/);
    await assert.rejects(startFootage(ask({ image: `data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}` }), "u1"), /not a PNG or JPEG/);
    const job = await startFootage(ask({ image: png(1, 2) }), "u1");
    assert.deepEqual([job.fromPicture, job.aspect, "imageDigest" in publicFootage(job)], [true, undefined, false]);
  });

  it("return the same clip for a start retried with the same key, and refuse the key for another clip", async () => {
    const first = await startFootage(ask({ image: png(1) }), "u1", { key: "key-footage-1" });
    const again = await startFootage(ask({ image: png(1) }), "u1", { key: "key-footage-1" });
    assert.equal(again.id, first.id);
    await assert.rejects(startFootage(ask({ image: png(2) }), "u1", { key: "key-footage-1" }), ConflictError, "another picture");
    await assert.rejects(startFootage(ask({ durationSec: 6, image: png(1) }), "u1", { key: "key-footage-1" }), ConflictError, "another length");
    await assert.rejects(startFootage(ask(), "u1", { key: "key-footage-1" }), ConflictError, "no picture");
    await assert.rejects(startFootage(ask({ image: png(1), title: "Paper boat in the rain" }), "u1", { key: "key-footage-1" }), ConflictError, "another title");
  });

  it("give a render a fresh link, renewing an old one, and refuse one not ready or deleted", async () => {
    const job = await startFootage(ask(), "u1");
    await assert.rejects(footageForRender(job.id, "u1"), /not ready yet/);
    await finished(job);
    assert.equal((await footageForRender(job.id, "u1")).videoUrl, "https://files.heygen.ai/old.mp4", "a recent link is used as it is");
    // An old link is asked for again (the demo renderer hands back its sample clip).
    await getStore().put("footage", { ...(await finished(job, 60 * 60 * 1000)), providerJobId: `mockft_${Date.now() - 10_000}_5` });
    forgetFootageChecks();
    assert.match((await footageForRender(job.id, "u1")).videoUrl, /\/demo\//);
    await deleteFootage(job.id, "u1");
    await assert.rejects(footageForRender(job.id, "u1"), (e: unknown) => e instanceof ValidationError && /was deleted/.test((e as Error).message));
    // A malformed id reads as not found, like an unknown one, without telling the id's shape.
    await assert.rejects(footageLink("not-a-clip", "u1"), (e: unknown) => (e as Error).message === "Clip not found");
  });

  it("are asked about when a render needs one still being made, without waiting for a listing", async () => {
    const job = await startFootage(ask(), "u1");
    await getStore().put("footage", { ...job, providerJobId: `mockft_${Date.now() - 10_000}_5` });
    forgetFootageChecks();
    assert.match((await footageForRender(job.id, "u1")).videoUrl, /\/demo\//, "the clip HeyGen finished meanwhile is found ready");
    assert.equal((await getStore().get<FootageJob>("footage", job.id))!.status, "completed", "and stored as such");
  });

  it("leave the brand kit and templates when deleted, which then render with a plain background", async () => {
    const { saveBrandKit, getBrandKit, createTemplate, getTemplate, brandKitSchema } = await import("../services");
    const job = await finished(await startFootage(ask(), "u1"));
    const loop = { type: "video" as const, value: footagePath(job.id) };
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#112233", defaultBackground: loop }), "u1");
    const tpl = await createTemplate({ title: "Kitchen tour", scenes: [{ script: "Welcome in.", background: loop, hidePresenter: true }] } as never, "u1");
    // A kit or template may only name a clip of the account that exists.
    await assert.rejects(saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#112233", defaultBackground: loop }), "u2"), /not found/i);
    await assert.rejects(saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#112233", defaultBackground: { type: "video", value: footagePath("ft_nope") } }), "u1"), /not found/i);
    await assert.rejects(createTemplate({ title: "Other", scenes: [{ script: "Hi.", background: loop }] } as never, "u2"), /not found/i);
    await deleteFootage(job.id, "u1");
    assert.equal((await getBrandKit("u1"))!.defaultBackground, undefined, "the kit falls back to its plain background");
    const after = await getTemplate(tpl.id, "u1");
    assert.equal(after.scenes[0].background.type, "color");
    assert.equal(after.scenes[0].hidePresenter, undefined, "the presenter comes back, as a colour cannot stand in for it");
  });

  it("are not looked up for a renderer that shows its own background", async () => {
    const { rendersFootage } = await import("../services");
    const { DidAvatarProvider } = await import("../providers/avatar/did");
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const { MockAvatarProvider } = await import("../providers/avatar/mock");
    // A D-ID render never loops the clip, so one gone or not ready does not refuse it.
    assert.equal(rendersFootage(new DidAvatarProvider("did_key")), false);
    assert.equal(rendersFootage(new HeyGenAvatarProvider("key")), true);
    assert.equal(rendersFootage(new MockAvatarProvider()), true);
  });

  it("loop as a scene's video background by their fixed address, and only a finished clip of the account", async () => {
    assert.equal(footageIdOf({ type: "video", value: footagePath("ft_abc") }), "ft_abc");
    assert.equal(footageIdOf({ type: "image", value: footagePath("ft_abc") }), null);
    assert.equal(videoRequestSchema.safeParse({ title: "T", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Hi.", background: { type: "video", value: "/api/footage/ft_x/clip" } }).success, true);
    assert.equal(videoRequestSchema.safeParse({ title: "T", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Hi.", background: { type: "video", value: "/api/other/thing" } }).success, false, "any other path is refused");
    const job = await finished(await startFootage(ask(), "u1"));
    const req = (owner: string) => createVideo(videoRequestSchema.parse({ title: "Kitchen", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Welcome in.", background: { type: "video", value: footagePath(job.id) } }), owner);
    const video = await req("u1");
    assert.equal(video.status, "processing");
    assert.deepEqual(video.background, { type: "video", value: footagePath(job.id) }, "the fixed address is kept, not the expiring link");
    await assert.rejects(req("u2"), "another account's clip is not found");
    // A refusal says which scene loops the clip.
    const multi = videoRequestSchema.parse({ title: "Tour", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes: [{ script: "One.", background: { type: "color", value: "#101820" } }, { script: "Two.", background: { type: "video", value: footagePath("ft_gone") } }] });
    await assert.rejects(createVideo(multi, "u1"), (e: unknown) => e instanceof ValidationError && /^Scene 2: A scene loops a generated clip that was deleted/.test((e as Error).message));
  });

  it("feature up to three pictures named in the description, in the first one's shape unless a frame is chosen", async () => {
    // What is accepted: one to three pictures, not with a first frame, HD only in a chosen landscape or portrait frame.
    assert.throws(() => ask({ references: [] }), /Add a picture/);
    assert.throws(() => ask({ references: [png(1), png(2), png(3), png(4)] }), /at most 3 pictures/);
    assert.throws(() => ask({ image: png(1), references: [png(2)] }), /not both/);
    assert.throws(() => ask({ references: [png(1)], quality: "hd" }), /landscape or portrait/, "the first picture's shape is standard only");
    assert.throws(() => ask({ references: [png(1)], aspect: "1:1", quality: "hd" }), /landscape or portrait/);
    assert.ok(ask({ references: [png(1)], aspect: "9:16", quality: "hd" }));
    assert.throws(() => ask({ references: [`data:image/png;base64,${"A".repeat(1_300_000)}`] }), /The picture to feature must be at most 900 KB/);
    assert.throws(() => ask({ prompt: "The shoe in <Picture 1> on the track in <Picture 2>", references: [png(1), `data:image/png;base64,${"A".repeat(1_300_000)}`] }), /Picture 2 must be at most 900 KB/);
    // Labels with no pictures featured name nothing either, with a first frame or with none.
    assert.throws(() => ask({ prompt: "The shoe in <Picture 1> on a marble desk" }), /names <Picture 1>, but no picture is featured/);
    assert.throws(() => ask({ prompt: "The shoe in <Picture 1> on a marble desk", image: png(1) }), /no picture is featured/);
    assert.throws(() => ask({ durationSec: 16, references: [png(1)] }), /features pictures, or follows the description exactly, is at most 15 seconds/);
    // An oversized picture is still refused when another field is wrong too.
    const both = footageRequestSchema.safeParse({ prompt: PROMPT, durationSec: 5.5, references: [`data:image/png;base64,${"A".repeat(1_300_000)}`] });
    assert.equal(both.success, false);
    assert.ok(both.error!.issues.some((i) => /900 KB/.test(i.message)), "the size is reported alongside the length");
    assert.throws(() => ask({ aspect: "adaptive" }), /leave it out for a clip from pictures to follow the first one/);
    // A label must name a picture that is sent: HeyGen does not rewrite them.
    assert.throws(() => ask({ prompt: "The shoe in <Picture 1> on the track in <Picture 2>", references: [png(1)] }), /names <Picture 2>, but one picture is featured/);
    assert.throws(() => ask({ prompt: "A slow shot of <Picture 4> and <Picture 3>", references: [png(1), png(2)] }), /names <Picture 3>, <Picture 4>, but 2 pictures are featured/);
    assert.ok(ask({ prompt: "The shoe in <Picture 1> on the track in <Picture 2>", references: [png(1), png(2)] }));
    await assert.rejects(startFootage(ask({ references: [png(1), "https://example.com/b.png"] }), "u1"), /Picture 2 must be an image file/);
    await assert.rejects(startFootage(ask({ references: [`data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`] }), "u1"), /The picture to feature is not a PNG or JPEG/);

    // Stored with how many it features and no frame of its own; the pictures themselves are not kept or shown.
    const job = await startFootage(ask({ references: [png(1), png(2)] }), "u1", { key: "key-refs-1" });
    assert.deepEqual([job.references, job.aspect, job.fromPicture], [2, undefined, undefined]);
    assert.equal(JSON.stringify(publicFootage(job)).includes("base64"), false);
    assert.equal("imageDigest" in publicFootage(job), false);
    assert.equal((await startFootage(ask({ references: [png(1), png(2)] }), "u1", { key: "key-refs-1" })).id, job.id, "the same start returns the same clip");
    await assert.rejects(startFootage(ask({ references: [png(2), png(1)] }), "u1", { key: "key-refs-1" }), ConflictError, "the order names the pictures, so another order is another clip");
    await assert.rejects(startFootage(ask({ references: [png(1)] }), "u1", { key: "key-refs-1" }), ConflictError);
    await assert.rejects(startFootage(ask({ image: png(1) }), "u1", { key: "key-refs-1" }), ConflictError, "a first frame is not a picture to feature");

    // HeyGen gets reference_to_video with each picture inline, in order, and `adaptive` unless a frame was chosen.
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.heygen.com/v3/models/videos" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ data: { status: "pending", video_id: `vid_ref_${bodies.length}` } }, { status: 202 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]).toString("base64")}`;
      const prompt = "A runner laces up the shoe in <Picture 1> on the track in <Picture 2>, then sets off";
      await startFootage(ask({ prompt, references: [png(5), jpeg], durationSec: 6 }), "u1");
      assert.deepEqual(bodies[0], {
        model: "heygen-video-1",
        mode: "reference_to_video",
        prompt,
        duration: 6,
        resolution: "768p",
        aspect_ratio: "adaptive",
        reference_images: [
          { type: "base64", media_type: "image/png", data: png(5).slice(png(5).indexOf(",") + 1) },
          { type: "base64", media_type: "image/jpeg", data: jpeg.slice(jpeg.indexOf(",") + 1) },
        ],
      });
      await startFootage(ask({ prompt, references: [png(5), jpeg], aspect: "16:9", quality: "hd" }), "u1");
      assert.deepEqual([bodies[1].mode, bodies[1].aspect_ratio, bodies[1].resolution], ["reference_to_video", "16:9", "1080p"]);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("keep their take's seed, to make the same take again with a change, and can follow the description exactly", async () => {
    // The demo reports a seed once the clip is made, like HeyGen; one asked for is kept.
    const job = await startFootage(ask({ seed: 42, exact: true }), "u1", { key: "key-seed-1" });
    assert.deepEqual([job.seed, job.exact, job.takeSeed], [42, true, undefined]);
    await getStore().put("footage", { ...job, providerJobId: `mockft_${Date.now() - 10_000}_5_42` });
    forgetFootageChecks();
    const [done] = await listFootage("u1");
    assert.deepEqual([done.status, done.takeSeed, publicFootage(done).takeSeed], ["completed", 42, 42]);
    // Retried with the same key: the same seed and wording return the same clip; another is another clip.
    assert.equal((await startFootage(ask({ seed: 42, exact: true }), "u1", { key: "key-seed-1" })).id, job.id, "the seed reported later does not change what the start is compared on");
    await assert.rejects(startFootage(ask({ seed: 43, exact: true }), "u1", { key: "key-seed-1" }), ConflictError);
    await assert.rejects(startFootage(ask({ seed: 42 }), "u1", { key: "key-seed-1" }), ConflictError, "exact wording is part of the start");

    // HeyGen gets the seed and prompt enhancement turned off, and reports the seed it used.
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.heygen.com/v3/models/videos" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ data: { status: "pending", video_id: "vid_seed" } }, { status: 202 });
      }
      if (url.startsWith("https://api.heygen.com/v3/models/videos/vid_seed")) return Response.json({ data: { status: "completed", video_url: "https://resource2.heygen.ai/v/seed.mp4", duration: 20, width: 1344, height: 768, seed: 987654 } });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      await startFootage(ask({ durationSec: 12, seed: 7, exact: true }), "u2");
      assert.deepEqual(bodies[0], { model: "heygen-video-1", mode: "text_to_video", prompt: PROMPT, duration: 12, resolution: "768p", aspect_ratio: "16:9", prompt_enhancement: "disabled", seed: 7 });
      const long = await startFootage(ask({ durationSec: 20 }), "u2");
      assert.deepEqual([bodies[1].duration, "prompt_enhancement" in bodies[1], "seed" in bodies[1]], [20, false, false], "without them HeyGen enhances the description and picks a seed");
      forgetFootageChecks();
      const made = (await listFootage("u2")).find((f) => f.id === long.id)!;
      assert.deepEqual([made.status, made.takeSeed, made.seed], ["completed", 987654, undefined]);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("ask HeyGen Video with the description or the picture, follow the clip, and say why one is refused", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; idem: string | null }> = [];
    let clip: Record<string, unknown> = { status: "pending" };
    let refuse: { status: number; message: string; code?: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method ?? "GET", body, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/models/videos" && init?.method === "POST") {
        if (refuse) return Response.json({ error: { code: refuse.code ?? "invalid_parameter", message: refuse.message } }, { status: refuse.status });
        return Response.json({ data: { status: "pending", video_id: `vid_${calls.length}` } }, { status: 202 });
      }
      if (url.startsWith("https://api.heygen.com/v3/models/videos/vid_gone")) return Response.json({ error: { code: "not_found", message: "No such video" } }, { status: 404 });
      if (url.startsWith("https://api.heygen.com/v3/models/videos/")) return Response.json({ data: clip });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const text = await startFootage(ask({ durationSec: 8, aspect: "9:16", quality: "hd" }), "u1", { key: "key-heygen-ft" });
      assert.deepEqual(calls[0].body, { model: "heygen-video-1", mode: "text_to_video", prompt: PROMPT, duration: 8, resolution: "1080p", aspect_ratio: "9:16" });
      assert.equal(calls[0].idem, text.id);
      await startFootage(ask({ image: png(7) }), "u1");
      const b64 = png(7).slice(png(7).indexOf(",") + 1);
      assert.deepEqual(calls[1].body, { model: "heygen-video-1", mode: "image_to_video", prompt: PROMPT, duration: 5, resolution: "768p", image: { type: "base64", media_type: "image/png", data: b64 } }, "a picture sets the shape, and goes as HeyGen's inline asset: no frame is sent");

      // Followed until HeyGen has it, then kept with its link and size.
      assert.equal((await listFootage("u1")).find((f) => f.id === text.id)!.status, "processing");
      clip = { status: "completed", video_url: "https://resource2.heygen.ai/videos/clip.mp4", duration: 8, width: 768, height: 1344 };
      forgetFootageChecks();
      const done = (await listFootage("u1")).find((f) => f.id === text.id)!;
      assert.deepEqual([done.status, done.videoUrl, done.width, done.height], ["completed", "https://resource2.heygen.ai/videos/clip.mp4", 768, 1344]);
      clip = { status: "failed", failure_code: "generation_failed", failure_message: "The prompt was refused." };
      await getStore().put("footage", { ...done, status: "processing" as const });
      forgetFootageChecks();
      const failed = (await listFootage("u1")).find((f) => f.id === text.id)!;
      assert.deepEqual([failed.status, failed.error], ["failed", "The prompt was refused."]);
      await getStore().put("footage", { ...failed, status: "processing" as const, providerJobId: "vid_gone" });
      forgetFootageChecks();
      assert.match((await listFootage("u1")).find((f) => f.id === text.id)!.error!, /no longer has this clip/);

      // Refusals carry HeyGen's reason; a start still in progress is a conflict to retry; a key taken with other details is not.
      refuse = { status: 400, message: "Insufficient credits." };
      await assert.rejects(startFootage(ask({ prompt: `${PROMPT}, again` }), "u1"), (e: unknown) => e instanceof ValidationError && /could not make that clip: Insufficient credits\./.test((e as Error).message));
      refuse = { status: 409, message: "A request with this key is in progress." };
      await assert.rejects(startFootage(ask({ prompt: `${PROMPT}, again` }), "u1"), ConflictError);
      refuse = { status: 409, message: "Idempotency key reused with a different request.", code: "conflict" };
      await assert.rejects(startFootage(ask({ prompt: `${PROMPT}, again` }), "u1"), /already asked for with other details/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("loop on HeyGen from the link the render looked up, not the stored address", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    let sent: { scenes: Array<Record<string, unknown>> } | null = null;
    client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    const ava = { ...STOCK_AVATARS[0], id: "ava_hg", provider: "heygen", source: "provider" as const };
    const emma = { ...STOCK_VOICES[0], id: "emma_hg", provider: "heygen" };
    const req = videoRequestSchema.parse({ title: "Kitchen", avatarId: ava.id, voiceId: emma.id, script: "Welcome in.", background: { type: "video", value: footagePath("ft_kitchen") } });
    await assert.rejects(heygen.createVideo(req, ava, emma, { avatars: { [ava.id]: ava }, voices: { [emma.id]: emma } }), /has not been looked up/);
    await heygen.createVideo(req, ava, emma, { avatars: { [ava.id]: ava }, voices: { [emma.id]: emma }, footage: { ft_kitchen: { videoUrl: "https://resource2.heygen.ai/videos/fresh.mp4" } } });
    assert.deepEqual((sent!.scenes[0] as { input: { background: unknown } }).input.background, { type: "video", source: { type: "url", url: "https://resource2.heygen.ai/videos/fresh.mp4" } });
  });

  it("are not offered by a renderer without them", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().generatedFootage, false);
      await assert.rejects(startFootage(ask(), "u1"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
