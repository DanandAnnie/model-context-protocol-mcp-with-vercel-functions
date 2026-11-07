// Look packs (HeyGen Look Packs): a set of new looks for one of the account's photo avatars, each kept as a photo avatar
// of its own once it is ready. What is accepted, what HeyGen is asked, how the looks are followed, and that looks the
// studio made stay the account's own, also after the avatar, portrait, or account that made them is deleted.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import {
  MAX_LOOK_PACKS,
  createAvatar,
  deleteAvatar,
  deleteLookPack,
  deleteOwnerData,
  exportOwnerData,
  forgetLookPackChecks,
  getAvatar,
  listAvatars,
  listLookPacks,
  lookPackKeySchema,
  lookPackRequestSchema,
  publicLookPack,
  setLookPictureFetch,
  startLookPack,
} from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { getStore } from "../store";
import { STOCK_AVATARS } from "../stock";
import type { Avatar, LookPackJob } from "../types";

const PNG = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetLookPackChecks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setLookPictureFetch(undefined);
});

const mine = (owner: string, extra: Partial<Avatar> = {}) => createAvatar({ name: "Dana", imageUrl: PNG, gender: "female", ...extra } as never, owner);

describe("look packs", () => {
  it("takes one of the account's photo avatars, a known pack, and a frame", async () => {
    assert.throws(() => lookPackRequestSchema.parse({ avatarId: "av_1", pack: "pirate" }));
    assert.throws(() => lookPackRequestSchema.parse({ avatarId: "av_1", pack: "healthcare", aspect: "1:1" }));
    assert.equal(lookPackRequestSchema.parse({ avatarId: "av_1", pack: "healthcare" }).aspect, "16:9", "landscape unless asked");
    const dana = await mine("u1");
    await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "healthcare" }), "u2"), NotFoundError, "another account's avatar");
    await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: STOCK_AVATARS[0].id, pack: "healthcare" }), "u1"), NotFoundError, "a library presenter is the renderer's");
    const neutral = await mine("u1", { gender: "neutral" });
    await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: neutral.id, pack: "healthcare" }), "u1"), /women's or the men's/);
    assert.equal((await startLookPack(lookPackRequestSchema.parse({ avatarId: neutral.id, pack: "healthcare", gender: "male" }), "u1")).gender, "male");
  });

  it("makes five looks in demo mode, each kept once as a photo avatar of the account, named after the avatar and the pack", async () => {
    assert.equal(providerStatus().lookPacks, true);
    const dana = await mine("u1");
    await getStore().put("avatar", { ...dana, defaultVoiceId: "stock_voice_1" });
    const job = await startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "modern-corporate", aspect: "9:16" }), "u1");
    assert.match(job.id, /^lk_/);
    assert.deepEqual([job.status, job.looks.length, job.aspect, job.gender, job.avatarName], ["processing", 5, "9:16", "female", "Dana"]);
    assert.deepEqual(Object.keys(publicLookPack(job)).filter((k) => ["ownerId", "provider", "lookIds"].includes(k)), [], "the renderer and its look ids stay on the server");
    const [done] = await listLookPacks("u1");
    assert.equal(done.status, "completed");
    assert.ok(done.looks.every((l) => l.status === "completed" && l.avatarId));
    const made = await Promise.all(done.looks.map((l) => getAvatar(l.avatarId!, "u1")));
    assert.deepEqual(made.map((a) => a.name), [1, 2, 3, 4, 5].map((n) => `Dana · Modern corporate ${n}`));
    assert.ok(made.every((a) => a.source === "custom" && a.gender === "female" && a.defaultVoiceId === "stock_voice_1" && a.imageUrl.startsWith("data:image/svg+xml") && a.tags?.includes("Modern corporate")));
    assert.equal(new Set(made.map((a) => a.imageUrl)).size, 5, "each look is its own picture");
    // Asked again, nothing is made twice.
    forgetLookPackChecks();
    await listLookPacks("u1");
    assert.equal((await getStore().list<Avatar>("avatar", "u1")).length, 6);
    assert.deepEqual(await listLookPacks("u2"), [], "another account sees none");
    await assert.rejects(getAvatar(made[0].id, "u2"), NotFoundError, "nor renders with its presenters by id");
    // A rename made between checks is not undone by a later one.
    await getStore().put("avatar", { ...made[0], name: "Dana on call" });
    await getStore().put("lookpack", { ...done, status: "processing", looks: done.looks.map((l) => ({ status: "processing" as const })) });
    forgetLookPackChecks();
    await listLookPacks("u1");
    assert.equal((await getAvatar(made[0].id, "u1")).name, "Dana on call");
    // Forgetting the pack keeps its presenters.
    await assert.rejects(deleteLookPack(done.id, "u2"), NotFoundError);
    await deleteLookPack(done.id, "u1");
    assert.deepEqual(await listLookPacks("u1"), []);
    assert.equal((await getStore().list<Avatar>("avatar", "u1")).length, 6);
    await assert.rejects(deleteLookPack("../x", "u1"), /Unknown look pack/);
  });

  it("keeps the pack and number of each look when the avatar's name is long, and the cleaned and lip-synced marks on long titles", async () => {
    const { withSuffix } = await import("../text");
    const long = "Ms Bartholomew-Featherstonehaugh Wolfeschlegelsteinhausen the Third of Somewhere";
    const dana = await mine("u1", { name: long } as Partial<Avatar>);
    await startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "business-casual" }), "u1");
    const [done] = await listLookPacks("u1");
    const names = await Promise.all(done.looks.map(async (l) => (await getAvatar(l.avatarId!, "u1")).name));
    assert.equal(new Set(names).size, 5, "five names, told apart");
    assert.ok(names.every((n, i) => n.endsWith(` · Stylish business-casual ${i + 1}`) && [...n].length <= 80));
    assert.equal(withSuffix("Q3 webinar", " (cleaned)", 120), "Q3 webinar (cleaned)");
    assert.equal([...withSuffix("x".repeat(118), " (lip-synced)", 120)].length, 120);
    assert.ok(withSuffix("x".repeat(118), " (lip-synced)", 120).endsWith(" (lip-synced)"));
    assert.equal(withSuffix("🇫🇷".repeat(5), " 1", 4), "🇫🇷🇫🇷 1", "a flag is never split");
  });

  it("says a deleted photo avatar no longer exists", async () => {
    await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: "av_gone", pack: "fitness" }), "u1"), /no longer exists/);
  });

  it("returns the same look pack for a start retried with the same key, without asking the renderer again", async () => {
    const proto = MockAvatarProvider.prototype as unknown as { startLookPack: (...a: unknown[]) => Promise<{ lookIds: string[] }> };
    const real = proto.startLookPack;
    const keys: unknown[] = [];
    proto.startLookPack = async function (this: unknown, ...a: unknown[]) {
      keys.push((a[0] as { key: string }).key);
      return real.apply(this, a);
    };
    try {
      const dana = await mine("u1");
      const input = lookPackRequestSchema.parse({ avatarId: dana.id, pack: "fitness" });
      let admitted = 0;
      const admit = () => void admitted++;
      const first = await startLookPack(input, "u1", { key: "retry-key-1", admit });
      const again = await startLookPack(input, "u1", { key: "retry-key-1", admit });
      assert.equal(again.id, first.id);
      assert.deepEqual([keys.length, admitted], [1, 1], "a repeat neither asks the renderer nor counts against the limit");
      assert.equal(keys[0], first.id, "the renderer's idempotency key is the pack's id");
      await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "keynote" }), "u1", { key: "retry-key-1" }), ConflictError);
      await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "fitness", aspect: "9:16" }), "u1", { key: "retry-key-1" }), ConflictError);
      assert.throws(() => lookPackKeySchema.parse("short"), /8 to 100/);
      await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: "av_nope", pack: "fitness" }), "u1", { key: "retry-key-2", admit }), NotFoundError);
      assert.equal(admitted, 1, "a refused start is not admitted");
    } finally {
      proto.startLookPack = real;
    }
  });

  it("keeps at most the account's limit, and goes with the account, its looks staying hidden", async () => {
    const dana = await mine("u1");
    for (let i = 0; i < MAX_LOOK_PACKS; i++) {
      const at = new Date().toISOString();
      await getStore().put("lookpack", { id: `lk_old${i}`, ownerId: "u1", avatarId: dana.id, avatarName: "Dana", pack: "fitness", gender: "female", aspect: "16:9", provider: "mock", lookIds: [STOCK_AVATARS[i % 3].id], looks: [{ status: "failed" }], status: "failed", createdAt: at, updatedAt: at } satisfies LookPackJob);
    }
    await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "fitness" }), "u1"), ConflictError);
    const exported = (await exportOwnerData("u1")).lookpack;
    assert.equal(exported.length, MAX_LOOK_PACKS);
    assert.deepEqual(Object.keys(exported[0]).filter((k) => k === "provider" || k === "lookIds"), [], "the renderer and its look ids stay out of the export");
    assert.ok((await listAvatars("u2")).every((a) => a.id !== STOCK_AVATARS[0].id), "a pack's looks are hidden while the pack is kept");
    assert.equal((await deleteOwnerData("u1")).lookpack, MAX_LOOK_PACKS);
    assert.ok((await listAvatars("u2")).every((a) => ![0, 1, 2].some((i) => a.id === STOCK_AVATARS[i].id)), "and after the account that made them is deleted");
  });

  it("keeps a look the studio made hidden from every account after its avatar or its portrait is deleted", async () => {
    // Demo presenters stand in for the renderer's shared account, which lists every look made in it.
    const look = STOCK_AVATARS[0].id;
    const dana = await mine("u1");
    await getStore().put("avatar", { ...dana, providerAssetIds: { mock: look } });
    assert.equal((await listAvatars("u2")).some((a) => a.id === look), false);
    await deleteAvatar(dana.id, "u1");
    assert.equal((await listAvatars("u2")).some((a) => a.id === look), false, "deleting the photo avatar does not hand its look to everyone");
    await assert.rejects(getAvatar(look, "u2"), /not found/);
    const drawn = STOCK_AVATARS[1].id;
    await getStore().put("portrait", { id: "pt_drawn", ownerId: "u3", provider: "mock", providerJobId: drawn, status: "completed", createdAt: new Date().toISOString() });
    await deleteOwnerData("u3");
    assert.equal((await listAvatars("u2")).some((a) => a.id === drawn), false, "nor does deleting the account that drew it");
    assert.ok((await listAvatars("u2")).some((a) => a.id === STOCK_AVATARS[2].id), "the renderer's own library is still offered");
  });

  it("keeps a pack's looks hidden by their record alone, once the pack is forgotten and its presenters deleted", async () => {
    // Demo presenters stand in for looks in the renderer's shared account.
    const looks = [STOCK_AVATARS[0].id, STOCK_AVATARS[1].id];
    const proto = MockAvatarProvider.prototype as unknown as { startLookPack: (...a: unknown[]) => Promise<{ lookIds: string[] }>; portraitStatus: (id: string) => Promise<unknown> };
    const real = { start: proto.startLookPack, status: proto.portraitStatus };
    proto.startLookPack = async () => ({ lookIds: looks });
    proto.portraitStatus = async () => ({ status: "completed", imageUrl: PNG });
    try {
      const dana = await mine("u1");
      const job = await startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "keynote" }), "u1");
      const [done] = await listLookPacks("u1");
      await deleteLookPack(job.id, "u1");
      for (const l of done.looks) await deleteAvatar(l.avatarId!, "u1");
      assert.deepEqual(await getStore().list("lookpack"), []);
      assert.equal((await getStore().list<Avatar>("avatar")).some((a) => looks.includes(a.providerAssetIds?.mock ?? "")), false, "nothing but the record knows the looks now");
      const shared = (await listAvatars("u2")).map((a) => a.id);
      assert.ok(looks.every((l) => !shared.includes(l)));
      assert.ok(shared.includes(STOCK_AVATARS[2].id));
    } finally {
      proto.startLookPack = real.start;
      proto.portraitStatus = real.status;
    }
  });

  it("follows the other looks when one cannot be asked about, and ends a look the renderer no longer has", async () => {
    const proto = MockAvatarProvider.prototype as unknown as { startLookPack: (...a: unknown[]) => Promise<{ lookIds: string[] }>; portraitStatus: (id: string) => Promise<unknown> };
    const real = { start: proto.startLookPack, status: proto.portraitStatus };
    const name = Buffer.from("Dana").toString("base64url");
    proto.startLookPack = async () => ({ lookIds: ["look_gone", "look_down", `mockportrait_5_${name}`] });
    proto.portraitStatus = async function (this: unknown, id: string) {
      if (id === "look_gone") throw new Error("HeyGen GET https://api.heygen.com/v3/avatars/looks/look_gone failed: 404 not found");
      if (id === "look_down") throw new Error("HeyGen GET https://api.heygen.com/v3/avatars/looks/look_down failed: 503 busy");
      return real.status.call(this, id);
    };
    try {
      const dana = await mine("u1");
      await startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "fitness" }), "u1");
      const [job] = await listLookPacks("u1");
      assert.deepEqual(job.looks.map((l) => l.status), ["failed", "processing", "completed"], "one look's failed check does not hold up the rest");
      assert.match(job.looks[0].error!, /no longer has this look/);
      assert.equal(job.status, "processing", "a look still to be asked about keeps the pack going");
      assert.ok(job.looks[2].avatarId);
    } finally {
      proto.startLookPack = real.start;
      proto.portraitStatus = real.status;
    }
  });

  it("records a drawn presenter's look when it is drawn, and keeps it hidden after its job is cleared a day later", async () => {
    const { startPortrait } = await import("../services");
    const proto = MockAvatarProvider.prototype as unknown as { generatePortrait: (...a: unknown[]) => Promise<{ jobId: string }> };
    const real = proto.generatePortrait;
    const drawn = STOCK_AVATARS[0].id;
    proto.generatePortrait = async () => ({ jobId: drawn });
    try {
      const { jobId } = await startPortrait({ name: "Sam", prompt: "A friendly presenter in a navy blazer, studio light, smiling" }, "u1");
      const old = (await getStore().get<{ createdAt: string }>("portrait", jobId))!;
      await getStore().put("portrait", { ...old, id: jobId, createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
      proto.generatePortrait = async () => ({ jobId: STOCK_AVATARS[1].id });
      await startPortrait({ name: "Sam", prompt: "A friendly presenter in a grey suit, office light, smiling" }, "u1");
      assert.equal(await getStore().get("portrait", jobId), null, "the old job is cleared");
      assert.equal((await listAvatars("u2")).some((a) => a.id === drawn), false, "its drawn look is not handed to everyone");
    } finally {
      proto.generatePortrait = real;
    }
  });

  it("records a photo avatar's new HeyGen look as it is made, even when the avatar is deleted meanwhile; never a D-ID upload", async () => {
    const { prepareOnce } = await import("../services/videos");
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const dana = await mine("u1", { provider: "heygen" });
    const provider = new HeyGenAvatarProvider("key");
    (provider as unknown as { prepareAvatar: (a: Avatar) => Promise<Avatar> }).prepareAvatar = async (a: Avatar) => {
      await getStore().remove("avatar", a.id);
      return { ...a, providerAssetIds: { "heygen:look": "look_fresh", "heygen:pending": "" } };
    };
    await prepareOnce(provider, dana);
    assert.deepEqual((await getStore().list<{ lookId: string }>("madelook")).map((m) => m.lookId), ["look_fresh"]);
    // D-ID keeps the portrait it hosts under its own key: that is not a look, and is not kept once the avatar goes.
    const did = await mine("u1", { provider: "did" });
    await getStore().put("avatar", { ...did, providerAssetIds: { did: "https://d-id.example/portraits/dana.png" } });
    await deleteAvatar(did.id, "u1");
    assert.deepEqual((await getStore().list<{ lookId: string }>("madelook")).map((m) => m.lookId), ["look_fresh"]);
  });

  it("asks HeyGen with the prepared photo avatar's look and the pack's template, follows each look, and keeps its picture", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
    const looks: Record<string, Record<string, unknown>> = { look_a: { status: "processing" }, look_b: { status: "processing" } };
    let refuse: { status: number; message: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method ?? "GET", body, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/assets") return Response.json({ data: { asset_id: "asset_dana" } });
      if (url === "https://api.heygen.com/v3/avatars" && init?.method === "POST") return Response.json({ data: { avatar_item: { id: "look_dana", status: "processing" } } });
      if (url === "https://api.heygen.com/v3/avatars/looks/look_dana") return Response.json({ data: { status: "completed", preview_image_url: "https://files.heygen.ai/dana.png" } });
      if (url === "https://api.heygen.com/v3/avatars/looks" && init?.method === "POST") {
        if (refuse) return Response.json({ error: { code: "x", message: refuse.message } }, { status: refuse.status });
        return Response.json({ data: { group_id: "group_1", looks: [{ id: "look_a" }, { id: "look_b" }] } });
      }
      // The shared account lists every look made in it (the pack's too, finished), and one of HeyGen's own.
      if (url.includes("ownership=private")) return Response.json({ data: ["look_a", "look_b", "look_dana"].map((id) => ({ id, name: id, avatar_type: "photo_avatar", preview_image_url: `https://files.heygen.ai/${id}.png`, status: "completed" })), has_more: false });
      if (url.includes("ownership=public")) return Response.json({ data: [{ id: "look_stock", name: "Ava", avatar_type: "studio_avatar", preview_image_url: "https://files.heygen.ai/ava.png" }], has_more: false });
      const m = /\/v3\/avatars\/looks\/(look_[ab])$/.exec(url);
      if (m) return Response.json({ data: looks[m[1]] });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    // The finished looks' pictures are fetched through the public-address guard; here from a stub.
    setLookPictureFetch((async (url: string) => (String(url).endsWith(".png") ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), { headers: { "content-type": "image/png" } }) : new Response("no", { status: 404 }))) as never);
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const dana = await mine("u1", { provider: "heygen" });
      const proto = (await import("../providers/avatar/heygen")).HeyGenAvatarProvider.prototype as unknown as { sleep: () => Promise<void> };
      const realSleep = proto.sleep;
      proto.sleep = async () => {};
      let job: LookPackJob;
      try {
        job = await startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "healthcare", aspect: "9:16" }), "u1");
      } finally {
        proto.sleep = realSleep;
      }
      const post = calls.find((c) => c.url.endsWith("/v3/avatars/looks") && c.method === "POST")!;
      assert.deepEqual(post.body, { type: "look_pack", reference_look_id: "look_dana", template_id: "14f4070bd5a04eb6b1f82ae087cd0f30", aspect_ratio: "9:16" }, "the avatar is made a HeyGen photo avatar first, and its look restyled with the women's Healthcare pack");
      assert.equal(post.idem, job.id);
      assert.equal((await getStore().get<Avatar>("avatar", dana.id))!.providerAssetIds?.["heygen:look"], "look_dana", "the photo avatar keeps its look");
      // Both looks are the studio's from the start, never offered to another account.
      const shared = (await listAvatars("u2")).map((a) => a.id);
      assert.deepEqual(shared, ["look_stock"], "only HeyGen's own library is offered to another account");

      assert.equal((await listLookPacks("u1"))[0].status, "processing");
      looks.look_a = { status: "completed", preview_image_url: "https://93.184.216.34/look_a.png" };
      looks.look_b = { status: "failed", error: { message: "The face could not be found." } };
      forgetLookPackChecks();
      const [done] = await listLookPacks("u1");
      assert.deepEqual([done.status, done.looks[0].status, done.looks[1].status, done.looks[1].error], ["completed", "completed", "failed", "The face could not be found."]);
      const made = await getAvatar(done.looks[0].avatarId!, "u1");
      assert.deepEqual(made.providerAssetIds, { "heygen:look": "look_a", "heygen:pending": "" }, "it renders as the look, with nothing to upload");
      assert.match(made.imageUrl, /^data:image\/png;base64,/, "its picture is kept, as HeyGen's link expires");
      assert.equal(made.name, "Dana · Healthcare 1");

      // A refusal comes back with HeyGen's reason; a start still being sent is a conflict to retry.
      refuse = { status: 403, message: "This template belongs to another workspace." };
      await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "keynote" }), "u1"), (e: unknown) => e instanceof ValidationError && /could not make new looks of "Dana": This template belongs to another workspace\./.test((e as Error).message));
      refuse = { status: 409, message: "A request with this key is in progress." };
      await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "keynote" }), "u1"), ConflictError);
      refuse = null;
      // A photo avatar HeyGen is still preparing cannot be restyled yet.
      const pending = await mine("u1", { provider: "heygen" });
      await getStore().put("avatar", { ...pending, providerAssetIds: { "heygen:look": "look_dana", "heygen:pending": "1" } });
      looks.look_dana = { status: "processing" };
      calls.length = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => (String(input).endsWith("/look_dana") ? Response.json({ data: { status: "processing" } }) : new Response("unexpected", { status: 500 }))) as typeof fetch;
      await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: pending.id, pack: "keynote" }), "u1"), /still preparing "Dana"/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("is not offered by a renderer without it", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().lookPacks, false);
      const dana = await mine("u1");
      await assert.rejects(startLookPack(lookPackRequestSchema.parse({ avatarId: dana.id, pack: "fitness" }), "u1"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
