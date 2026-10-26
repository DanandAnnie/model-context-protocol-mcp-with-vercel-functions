// Uploaded background images: storage, validation, and how a render uses them.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import {
  MAX_BACKDROPS,
  createBackdrop,
  createBatch,
  createVideo,
  deleteBackdrop,
  exportOwnerData,
  getBackdropImage,
  listBackdrops,
  videoRequestSchema,
} from "../services";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { backdropIdOf, backdropPath, type Backdrop } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const dataUrl = (bytes: Uint8Array, type = "image/png") => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const sceneWith = (value: string) => ({ script: "Hello there.", background: { type: "image" as const, value } });
const request = (scenes: Array<ReturnType<typeof sceneWith>>) =>
  videoRequestSchema.parse({ title: "Slides", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes });

describe("background images", () => {
  it("keeps a PNG or JPEG with its bytes apart, typed by its content, and lists it without provider ids", async () => {
    const png = await createBackdrop({ name: "Office", image: dataUrl(PNG) });
    // A JPEG sent under the wrong type is stored as what it is.
    const jpeg = await createBackdrop({ name: "Product", image: dataUrl(JPEG, "image/png") });
    assert.deepEqual([png.mimeType, png.bytes, jpeg.mimeType], ["image/png", PNG.byteLength, "image/jpeg"]);
    assert.match(png.id, /^bd_/);
    assert.deepEqual(Array.from((await getBackdropImage(png.id)).bytes), Array.from(PNG));
    await getStore().put("backdrop", { ...(await getStore().get<Backdrop>("backdrop", png.id))!, providerAssetIds: { heygen: "img_1" } });
    const listed = await listBackdrops();
    assert.deepEqual(listed.map((b) => b.name).sort(), ["Office", "Product"]);
    assert.equal(listed.some((b) => "providerAssetIds" in b), false);
  });

  it("refuses what is not a PNG or JPEG, an oversized file, and more than the cap", async () => {
    await assert.rejects(createBackdrop({ name: "x", image: "data:text/plain;base64,aGk=" }), /must be an image/);
    await assert.rejects(createBackdrop({ name: "x", image: dataUrl(new Uint8Array([1, 2, 3, 4])) }), /not a picture/);
    await assert.rejects(createBackdrop({ name: "x", image: dataUrl(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), "image/gif") }), /not a picture/);
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    big.set(PNG);
    await assert.rejects(createBackdrop({ name: "x", image: dataUrl(big) }), /too large/);
    for (let i = 0; i < MAX_BACKDROPS; i++) await createBackdrop({ name: `b${i}`, image: dataUrl(PNG) });
    await assert.rejects(createBackdrop({ name: "one more", image: dataUrl(PNG) }), /At most 100/);
  });

  it("names a backdrop by its path only when the background is an image at that path", () => {
    assert.equal(backdropIdOf({ type: "image", value: backdropPath("bd_abc123") }), "bd_abc123");
    assert.equal(backdropIdOf({ type: "image", value: "https://cdn.example/bg.jpg" }), null);
    assert.equal(backdropIdOf({ type: "color", value: backdropPath("bd_abc123") }), null);
    assert.equal(backdropIdOf({ type: "image", value: `${backdropPath("bd_abc123")}/../x` }), null);
  });

  it("a render prepares each image once, even across scenes and renders, and keeps the asset id", async () => {
    const office = await createBackdrop({ name: "Office", image: dataUrl(PNG) });
    const proto = MockAvatarProvider.prototype as unknown as { prepareBackdrop?: (b: Backdrop, image: { bytes: Uint8Array }) => Promise<Backdrop> };
    const uploads: number[] = [];
    proto.prepareBackdrop = async (b, image) => {
      uploads.push(image.bytes.byteLength);
      return { ...b, providerAssetIds: { ...b.providerAssetIds, mock: `asset_${b.id}` } };
    };
    try {
      const req = request([sceneWith(backdropPath(office.id)), sceneWith(backdropPath(office.id))]);
      const first = await createVideo(req);
      assert.equal(first.status, "processing", first.error);
      await createVideo(req);
      assert.deepEqual(uploads, [PNG.byteLength], "uploaded once for two scenes and two renders");
      assert.equal((await getStore().get<Backdrop>("backdrop", office.id))?.providerAssetIds?.mock, `asset_${office.id}`);
    } finally {
      delete proto.prepareBackdrop;
    }
  });

  it("an image from another account or a deleted one is refused before anything renders", async () => {
    const theirs = await createBackdrop({ name: "Theirs", image: dataUrl(PNG) }, "user_other");
    await assert.rejects(createVideo(request([sceneWith(backdropPath(theirs.id))])), /Background image .* not found/);
    const mine = await createBackdrop({ name: "Mine", image: dataUrl(PNG) });
    await deleteBackdrop(mine.id);
    await assert.rejects(createVideo(request([sceneWith(backdropPath(mine.id))])), /Background image .* not found/);
    assert.equal(await getStore().get("backdropdata", `backdropdata_${mine.id}`), null, "the image bytes go with it");
    assert.equal((await getStore().list("video")).length, 0);
  });

  it("a batch behind an uploaded image, its own or the brand kit's, checks it before any row starts", async () => {
    const { brandKitSchema, saveBrandKit } = await import("../services");
    const base = { title: "Batch", scriptTemplate: "Hi {name}", csv: "name\nAmy\nBo", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect: "16:9" as const, resolution: "1080p" as const, captions: false, speed: 1 };
    const office = await createBackdrop({ name: "Office", image: dataUrl(PNG) });
    const ok = await createBatch({ ...base, background: { type: "image", value: backdropPath(office.id) } });
    assert.deepEqual(ok.videos.map((v) => v.status), ["processing", "processing"]);
    // With no background of its own, the batch takes the kit's: an uploaded image there is looked up too.
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5", defaultBackground: { type: "image", value: backdropPath(office.id) } }));
    const fromKit = await createBatch(base);
    assert.deepEqual(fromKit.videos.map((v) => [v.status, v.background.value]), [["processing", backdropPath(office.id)], ["processing", backdropPath(office.id)]]);
    // Gone without the delete that would tidy the kit (removed from the store directly), the kit's image is still
    // refused up front, not row by row.
    await getStore().remove("backdrop", office.id);
    await assert.rejects(createBatch({ ...base, background: { type: "image", value: backdropPath(office.id) } }), /Background image .* not found/);
    await assert.rejects(createBatch(base), /Background image .* not found/);
  });

  it("the export lists images without provider ids or bytes, and deleting the account removes both rows", async () => {
    const { deleteOwnerData } = await import("../services");
    const b = await createBackdrop({ name: "Export me", image: dataUrl(PNG) });
    await getStore().put("backdrop", { ...(await getStore().get<Backdrop>("backdrop", b.id))!, providerAssetIds: { heygen: "img_1" } });
    const out = await exportOwnerData();
    assert.deepEqual((out.backdrop as Array<Record<string, unknown>>).map((x) => [x.name, "providerAssetIds" in x]), [["Export me", false]]);
    assert.equal("backdropdata" in out, false);
    const counts = await deleteOwnerData();
    assert.equal(counts.backdrop, 1);
    assert.equal(await getStore().get("backdropdata", `backdropdata_${b.id}`), null);
  });
});

describe("background images kept with a template, the brand kit, and the store", () => {
  it("an image background is a public URL or an uploaded image exactly, nothing in between", () => {
    const parse = (value: string) => videoRequestSchema.safeParse({ title: "t", script: "Hi", avatarId: "a", voiceId: "v", background: { type: "image", value } }).success;
    assert.equal(parse("https://cdn.example/bg.jpg"), true);
    assert.equal(parse(backdropPath("bd_abc123")), true);
    for (const value of [`${backdropPath("bd_abc123")}/`, `${backdropPath("bd_abc123")}?v=1`, "/api/clips/clip_1", "bg.jpg", "data:image/png;base64,AAAA"]) assert.equal(parse(value), false, value);
  });

  it("a template or the brand kit naming an image that is missing or another account's is refused when saved", async () => {
    const { brandKitSchema, createTemplate, saveBrandKit, templateInputSchema } = await import("../services");
    const theirs = await createBackdrop({ name: "Theirs", image: dataUrl(PNG) }, "user_other");
    const mine = await createBackdrop({ name: "Mine", image: dataUrl(PNG) });
    const template = (id: string) => templateInputSchema.parse({ title: "Deck", scenes: [{ script: "Hi", background: { type: "image", value: backdropPath(id) } }], avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id });
    await assert.rejects(createTemplate(template(theirs.id)), /Background image .* not found/);
    assert.equal((await createTemplate(template(mine.id))).scenes[0].background.value, backdropPath(mine.id));
    const kit = (id: string) => brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5", defaultBackground: { type: "image", value: backdropPath(id) } });
    await assert.rejects(saveBrandKit(kit(theirs.id)), /Background image .* not found/);
    assert.equal((await saveBrandKit(kit(mine.id))).defaultBackground?.value, backdropPath(mine.id));
  });

  it("deleting an image takes it off the owner's templates and brand kit, so they still render", async () => {
    const { brandKitSchema, createTemplate, getBrandKit, getTemplate, saveBrandKit, templateInputSchema } = await import("../services");
    const office = await createBackdrop({ name: "Office", image: dataUrl(PNG) });
    const keep = await createBackdrop({ name: "Keep", image: dataUrl(PNG) });
    const tpl = await createTemplate(
      templateInputSchema.parse({
        title: "Deck",
        scenes: [{ script: "One", background: { type: "image", value: backdropPath(office.id) } }, { script: "Two", background: { type: "image", value: backdropPath(keep.id) } }],
        avatarId: STOCK_AVATARS[0].id,
        voiceId: STOCK_VOICES[0].id,
      }),
    );
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5", defaultBackground: { type: "image", value: backdropPath(office.id) } }));
    // Another account's template naming the same path is not touched (it could never render it anyway).
    await deleteBackdrop(office.id);
    assert.deepEqual((await getTemplate(tpl.id)).scenes.map((sc) => sc.background), [{ type: "color", value: "#f1f5f9" }, { type: "image", value: backdropPath(keep.id) }]);
    assert.equal((await getBrandKit())?.defaultBackground, undefined);
    assert.equal((await getBrandKit())?.name, "Acme", "the rest of the kit stays");
    // A batch with no background of its own now renders on the kit's colour instead of failing.
    const batch = await createBatch({ title: "B", scriptTemplate: "Hi {name}", csv: "name\nAmy", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect: "16:9", resolution: "1080p", captions: false, speed: 1 });
    assert.equal(batch.videos[0].status, "processing");
  });

  it("saving a video as a template gives a scene whose image was deleted a plain background", async () => {
    const { createTemplate, templateInputSchema } = await import("../services");
    const office = await createBackdrop({ name: "Office", image: dataUrl(PNG) });
    const video = await createVideo(request([sceneWith(backdropPath(office.id)), sceneWith("https://cdn.example/bg.jpg")]));
    await deleteBackdrop(office.id);
    const tpl = await createTemplate(templateInputSchema.parse({ fromVideoId: video.id }));
    assert.deepEqual(tpl.scenes.map((sc) => sc.background), [{ type: "color", value: "#f1f5f9" }, { type: "image", value: "https://cdn.example/bg.jpg" }]);
  });

  it("an upload whose listed row cannot be written takes its bytes back out", async () => {
    const store = getStore();
    const put = store.put.bind(store);
    store.put = (async (kind: Parameters<typeof put>[0], item: { id: string }) => {
      if (kind === "backdrop") throw new Error("store down");
      return put(kind, item);
    }) as typeof store.put;
    try {
      await assert.rejects(createBackdrop({ name: "Lost", image: dataUrl(PNG) }), /store down/);
    } finally {
      store.put = put;
    }
    assert.deepEqual(await store.list("backdropdata"), [], "no image is left without a listed row");
  });

  it("recording an asset id for an image deleted meanwhile does not bring it back", async () => {
    const { saveBackdropAssetIds } = await import("../services");
    const b = await createBackdrop({ name: "Gone soon", image: dataUrl(PNG) });
    const store = getStore();
    const get = store.get.bind(store);
    // The delete lands between the read and the write (once: the delete reads the row too).
    let deleted = false;
    store.get = (async (kind: Parameters<typeof get>[0], id: string) => {
      const found = await get(kind, id);
      if (kind === "backdrop" && !deleted) {
        deleted = true;
        await deleteBackdrop(b.id);
      }
      return found;
    }) as typeof store.get;
    try {
      await saveBackdropAssetIds(b, { heygen: "img_late" });
    } finally {
      store.get = get;
    }
    assert.equal(await store.get("backdrop", b.id), null);
    assert.deepEqual(await listBackdrops(), []);
  });
});

describe("background images at the renderer", () => {
  it("HeyGen names an uploaded image by its asset id and an image URL as before", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    let sent: { video_inputs: Array<{ background: Record<string, unknown> }> } | null = null;
    client.generateVideo = async (body) => {
      sent = body as typeof sent;
      return { video_id: "hg_1" };
    };
    const uploads: string[] = [];
    client.uploadAsset = async (_bytes, mime) => {
      uploads.push(mime as string);
      return "img_new";
    };
    const ava = { ...STOCK_AVATARS[0], id: "ava_hg", provider: "heygen", source: "provider" as const };
    const emma = { ...STOCK_VOICES[0], id: "emma_hg", provider: "heygen" };
    const office: Backdrop = { id: "bd_office", name: "Office", mimeType: "image/png", bytes: 12, createdAt: "", providerAssetIds: { heygen: "img_1" } };
    const req = request([sceneWith(backdropPath(office.id)), sceneWith("https://cdn.example/bg.jpg")]);
    await heygen.createVideo(req, ava, emma, { avatars: { [ava.id]: ava }, voices: { [emma.id]: emma }, backdrops: { [office.id]: office } });
    assert.deepEqual(sent!.video_inputs.map((i) => i.background), [
      { type: "image", image_asset_id: "img_1" },
      { type: "image", url: "https://cdn.example/bg.jpg" },
    ]);
    await assert.rejects(heygen.createVideo(req, ava, emma, { avatars: {}, voices: {}, backdrops: {} }), /not been uploaded to HeyGen/);
    const fresh = await heygen.prepareBackdrop({ ...office, providerAssetIds: {} }, { bytes: PNG, mimeType: "image/png" });
    assert.equal(fresh.providerAssetIds?.heygen, "img_new");
    await heygen.prepareBackdrop(office, { bytes: PNG, mimeType: "image/png" });
    assert.deepEqual(uploads, ["image/png"], "an image already uploaded is not sent again");
  });
});
