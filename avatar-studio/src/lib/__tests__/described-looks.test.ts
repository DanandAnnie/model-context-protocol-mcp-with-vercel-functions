// Looks from a description (HeyGen prompt to avatar with the avatar's own look as the reference): one new look of a
// photo avatar, its outfit and setting described in words and guided by up to three pictures, kept as a photo avatar
// once it is ready. What is accepted, what HeyGen is asked, retries, and what stays on the server.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createAvatar, exportOwnerData, forgetLookPackChecks, getAvatar, listLookPacks, lookPackRequestSchema, publicLookPack, setLookPictureFetch, startLookPack } from "../services";
import { ConflictError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { getStore } from "../store";
import type { Avatar, LookPackJob } from "../types";

const PORTRAIT = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
const png = (...extra: number[]) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]).toString("base64")}`;
const jpeg = (...extra: number[]) => `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, ...extra]).toString("base64")}`;
const PROMPT = "A navy blazer over a white shirt, in a bright office with plants, soft window light";

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetLookPackChecks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setLookPictureFetch(undefined);
});

const mine = (owner: string, extra: Partial<Avatar> = {}) => createAvatar({ name: "Dana", imageUrl: PORTRAIT, gender: "female", ...extra } as never, owner);
const described = (avatarId: string, extra: Record<string, unknown> = {}) => lookPackRequestSchema.parse({ avatarId, pack: "described", prompt: PROMPT, ...extra });

describe("looks from a description", () => {
  it("takes a description of 10 to 1,000 characters, a frame, and up to three pictures; packs are asked as before", () => {
    assert.throws(() => lookPackRequestSchema.parse({ avatarId: "av_1", pack: "described" }), "a description is needed");
    assert.throws(() => lookPackRequestSchema.parse({ avatarId: "av_1", pack: "described", prompt: "blazer" }), /few words/);
    assert.throws(() => lookPackRequestSchema.parse({ avatarId: "av_1", pack: "described", prompt: "x".repeat(1001) }), /at most 1000/);
    assert.throws(() => described("av_1", { aspect: "1:1" }), "only the frames offered");
    assert.throws(() => described("av_1", { references: [png(), png(), png(), png()] }), /at most 3 pictures/);
    const ok = described("av_1", { prompt: `  ${PROMPT}  ` });
    assert.deepEqual([ok.pack, ok.aspect, ok.pack === "described" && ok.prompt, ok.pack === "described" && ok.references], ["described", "4:5", PROMPT, []], "portrait 4:5 unless asked, trimmed");
    assert.equal(lookPackRequestSchema.parse({ avatarId: "av_1", pack: "healthcare" }).aspect, "16:9", "a pack is unchanged");
    assert.throws(() => lookPackRequestSchema.parse({ avatarId: "av_1", pack: "healthcare", aspect: "4:5" }), "a pack keeps its two frames");
  });

  it("draws one look in demo mode, kept as a photo avatar named after the avatar, with no women's or men's choice", async () => {
    assert.equal(providerStatus().describedLooks, true);
    const sam = await mine("u1", { name: "Sam", gender: "neutral" });
    await getStore().put("avatar", { ...sam, defaultVoiceId: "stock_voice_1" });
    const job = await startLookPack(described(sam.id, { aspect: "16:9", references: [png(1), jpeg(2)] }), "u1");
    assert.deepEqual([job.pack, job.looks.length, job.aspect, job.gender, job.prompt, job.references], ["described", 1, "16:9", undefined, PROMPT, 2]);
    assert.ok(job.referenceDigest, "the pictures are known by their digest");
    const view = publicLookPack(job);
    assert.equal("referenceDigest" in view, false, "the digest stays on the server");
    assert.equal(JSON.stringify(view).includes("base64"), false, "the pictures are not kept");
    const [done] = await listLookPacks("u1");
    assert.equal(done.status, "completed");
    const made = await getAvatar(done.looks[0].avatarId!, "u1");
    assert.deepEqual([made.name, made.gender, made.defaultVoiceId, made.source], ["Sam · Described look", "neutral", "stock_voice_1", "custom"], "it keeps the avatar's gender and voice");
    assert.ok(made.tags?.includes("Described look"));
    const exported = JSON.stringify(await exportOwnerData("u1"));
    assert.equal(exported.includes(job.referenceDigest!), false, "nor goes with an export");
  });

  it("refuses pictures that are not PNG or JPEG, or larger than 1 MB, before the renderer is asked", async () => {
    const dana = await mine("u1");
    await assert.rejects(startLookPack(described(dana.id, { references: ["https://example.com/coat.png"] }), "u1"), (e: unknown) => e instanceof ValidationError && /The picture must be an image file/.test((e as Error).message));
    await assert.rejects(startLookPack(described(dana.id, { references: [png(), `data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`] }), "u1"), /Picture 2 is not a PNG or JPEG/);
    const big = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)]).toString("base64")}`;
    assert.throws(() => described(dana.id, { references: [big] }), /larger than 1 MB/, "far too large to send at all");
    const justOver = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024 - 2)]).toString("base64")}`;
    // Just over is let through the request check, and refused once decoded.
    await assert.rejects(startLookPack(described(dana.id, { references: [justOver] }), "u1"), /larger than 1 MB/);
    assert.deepEqual(await listLookPacks("u1"), []);
  });

  it("returns the same look for a retried start with the same key, and refuses the key for another description or pictures", async () => {
    const dana = await mine("u1");
    const first = await startLookPack(described(dana.id, { references: [png(1)] }), "u1", { key: "key-described-1" });
    const again = await startLookPack(described(dana.id, { references: [png(1)] }), "u1", { key: "key-described-1" });
    assert.equal(again.id, first.id);
    assert.equal((await getStore().list("lookpack", "u1")).length, 1);
    await assert.rejects(startLookPack(described(dana.id, { prompt: `${PROMPT}, smiling`, references: [png(1)] }), "u1", { key: "key-described-1" }), ConflictError);
    await assert.rejects(startLookPack(described(dana.id, { references: [png(2)] }), "u1", { key: "key-described-1" }), ConflictError, "other pictures are another start");
    await assert.rejects(startLookPack(described(dana.id), "u1", { key: "key-described-1" }), ConflictError, "so is no picture");
    await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "keynote" }), "u1", { key: "key-described-1" }), ConflictError, "and a pack");
  });

  it("asks HeyGen to restyle the photo avatar's look with the description and the uploaded pictures, and follows the look", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
    let assets = 0;
    let look: Record<string, unknown> = { status: "processing" };
    let refuse: { status: number; message: string; code?: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method ?? "GET", body, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/assets") return Response.json({ data: { asset_id: `asset_${++assets}` } });
      if (url === "https://api.heygen.com/v3/avatars" && init?.method === "POST") {
        if (body?.type === "photo") return Response.json({ data: { avatar_item: { id: "look_dana", status: "processing" } } });
        if (refuse) return Response.json({ error: { code: refuse.code ?? "invalid_parameter", message: refuse.message } }, { status: refuse.status });
        return Response.json({ data: { look_id: "look_new", status: "processing" } });
      }
      if (url === "https://api.heygen.com/v3/avatars/looks/look_dana") return Response.json({ data: { status: "completed", preview_image_url: "https://files.heygen.ai/dana.png" } });
      if (url === "https://api.heygen.com/v3/avatars/looks/look_new") return Response.json({ data: look });
      if (url.includes("ownership=")) return Response.json({ data: [], has_more: false });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    setLookPictureFetch((async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]), { headers: { "content-type": "image/png" } })) as never);
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    const proto = (await import("../providers/avatar/heygen")).HeyGenAvatarProvider.prototype as unknown as { sleep: () => Promise<void> };
    const realSleep = proto.sleep;
    proto.sleep = async () => {};
    try {
      const dana = await mine("u1", { provider: "heygen" });
      const job: LookPackJob = await startLookPack(described(dana.id, { aspect: "9:16", references: [png(1), jpeg(2)] }), "u1", { key: "key-heygen-1" });
      const uploads = calls.filter((c) => c.url.endsWith("/v3/assets"));
      assert.equal(uploads.length, 1, "only the portrait is uploaded; the pictures go with the request");
      const posts = () => calls.filter((c) => c.url.endsWith("/v3/avatars") && (c.body as { type?: string })?.type === "prompt");
      const post = posts()[0];
      const b64 = (url: string) => url.slice(url.indexOf(",") + 1);
      assert.deepEqual(post.body, {
        type: "prompt",
        name: "Dana",
        prompt: PROMPT,
        aspect_ratio: "9:16",
        avatar_id: "look_dana",
        reference_images: [
          { type: "base64", content: b64(png(1)) },
          { type: "base64", content: b64(jpeg(2)) },
        ],
      });
      assert.equal(post.idem, job.id, "a retried start replays HeyGen's first answer");
      // A start whose answer was lost (never stored) is sent again with the same key and the very same body, so HeyGen
      // can give back the look it already drew instead of refusing the key.
      await getStore().remove("lookpack", job.id);
      const retried = await startLookPack(described(dana.id, { aspect: "9:16", references: [png(1), jpeg(2)] }), "u1", { key: "key-heygen-1" });
      assert.equal(retried.id, job.id);
      assert.deepEqual([posts()[1].body, posts()[1].idem], [post.body, post.idem]);

      assert.equal((await listLookPacks("u1"))[0].status, "processing");
      look = { status: "completed", preview_image_url: "https://93.184.216.34/look_new.png" };
      forgetLookPackChecks();
      const [done] = await listLookPacks("u1");
      assert.equal(done.status, "completed");
      const made = await getAvatar(done.looks[0].avatarId!, "u1");
      assert.deepEqual([made.name, made.providerAssetIds], ["Dana · Described look", { "heygen:look": "look_new", "heygen:pending": "" }]);
      assert.match(made.imageUrl, /^data:image\/png;base64,/);

      // A failed look says why; a description HeyGen will not draw comes back with HeyGen's reason.
      await startLookPack(described(dana.id, { prompt: `${PROMPT}, again` }), "u1");
      look = { status: "failed", error: { code: "moderation_failed", message: "The description was not allowed." } };
      forgetLookPackChecks();
      const failed = (await listLookPacks("u1")).find((j) => j.prompt?.endsWith("again"))!;
      assert.deepEqual([failed.status, failed.looks[0].error], ["failed", "The description was not allowed."]);
      refuse = { status: 400, message: "The referenced avatar has no usable image." };
      await assert.rejects(startLookPack(described(dana.id, { prompt: `${PROMPT}, once more` }), "u1"), (e: unknown) => e instanceof ValidationError && /could not draw that look of "Dana": The referenced avatar has no usable image\./.test((e as Error).message));
      refuse = { status: 409, message: "A request with this key is in progress." };
      await assert.rejects(startLookPack(described(dana.id, { prompt: `${PROMPT}, once more` }), "u1"), ConflictError);
      // HeyGen's `conflict` (the key was used with another body) is a refusal to start again, not a wait.
      refuse = { status: 409, message: "Idempotency key reused with a different request.", code: "conflict" };
      await assert.rejects(startLookPack(described(dana.id, { prompt: `${PROMPT}, once more` }), "u1"), (e: unknown) => e instanceof ValidationError && /already asked for with other details/.test((e as Error).message));
    } finally {
      proto.sleep = realSleep;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("is not offered by a renderer without it", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().describedLooks, false);
      const dana = await mine("u1");
      await assert.rejects(startLookPack(described(dana.id), "u1"), /Looks from a description are not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
