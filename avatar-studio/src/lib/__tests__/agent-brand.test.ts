// The account's HeyGen brand kit: imported from its website (POST /v3/brand-kits), read back while HeyGen reads the
// page, sent as brand_kit_id on the account's own directed videos only, and deleted at HeyGen once nothing uses it.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { agentBrandUrl, agentKitFor, deleteOwnerData, directAgentVideo, retryVideo, getAgentBrand, importAgentBrand, removeAgentBrand, saveBrandKit, brandKitSchema, brandKitFile, videoAgentSchema } from "../services";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { HeyGenAvatarProvider } from "../providers/avatar/heygen";
import { ConflictError, ValidationError } from "../errors";
import type { AgentBrandKit, Video } from "../types";

const proto = MockAvatarProvider.prototype as unknown as Record<string, unknown>;
const saved = { importBrandKit: proto.importBrandKit, brandKitDetails: proto.brandKitDetails, deleteBrandKit: proto.deleteBrandKit };
let deleted: string[] = [];

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  deleted = [];
  proto.deleteBrandKit = async (id: string) => void deleted.push(id);
});
afterEach(() => Object.assign(proto, saved));

const ASK = { prompt: "A one-minute welcome for new customers of our dental clinic.", mode: "direct" as const };
/** Ages the account's unused kits past their grace and their last look, as if time had passed. */
async function age(owner: string) {
  const long = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  for (const k of await kits(owner)) if (!k.current) await getStore().put("agentbrand", { ...k, retiredAt: long, ...(k.sweptAt ? { sweptAt: long } : {}) });
}
const kits = async (owner: string) => (await getStore().list<AgentBrandKit>("agentbrand", owner)).filter((k) => k.ownerId === owner);

describe("HeyGen brand kits for directed videos", () => {
  it("are offered with a renderer that directs videos and imports kits", () => {
    assert.equal(providerStatus().agentBrandKits, true);
  });

  it("send HeyGen a public http(s) page only, as https when no scheme is given", () => {
    assert.equal(agentBrandUrl("acme.com"), "https://acme.com/");
    assert.equal(agentBrandUrl("http://www.acme.com/about#team"), "http://www.acme.com/about");
    for (const bad of ["ftp://acme.com", "https://user:pw@acme.com", "localhost", "http://10.0.0.1", "https://[::1]/", "https://printer.local", "not a url at all"]) {
      assert.throws(() => agentBrandUrl(bad), ValidationError, bad);
    }
  });

  it("are imported named for the brand, read back while HeyGen reads the page, and kept apart from the Brand page's kit", async () => {
    await saveBrandKit(brandKitSchema.parse({ name: "Acme Dental", primaryColor: "#112233" }), "a1");
    let sent: { url: string; name?: string } | null = null;
    proto.importBrandKit = async (input: { url: string; name?: string }) => ((sent = input), { kitId: "kit_1" });
    let reads = 0;
    proto.brandKitDetails = async () => (++reads, { status: "completed", name: "Acme", colors: ["#1d4ed8", "#f59e0b"], logoUrl: "https://cdn.example.com/logo.png", fonts: ["Inter"] });
    const kit = await importAgentBrand({ url: "acme.com" }, "a1");
    assert.deepEqual(sent, { url: "https://acme.com/", name: "Acme Dental" });
    assert.deepEqual([kit.status, kit.kitId, kit.current], ["loading", "kit_1", true]);
    // Asked again only once two seconds have passed since the last check.
    assert.equal((await getAgentBrand("a1"))?.status, "loading");
    assert.equal(reads, 0);
    await getStore().put("agentbrand", { ...kit, checkedAt: new Date(Date.now() - 5000).toISOString() });
    const ready = await getAgentBrand("a1");
    assert.deepEqual([ready?.status, ready?.name, ready?.colors, ready?.logoUrl, ready?.fonts], ["completed", "Acme", ["#1d4ed8", "#f59e0b"], "https://cdn.example.com/logo.png", ["Inter"]]);
    assert.equal(reads, 1);
    assert.equal(await getAgentBrand("a2"), null, "another account has none");
    // Saving the Brand page's kit leaves it alone, and the kit file never carries it.
    await saveBrandKit(brandKitSchema.parse({ name: "Acme Dental", primaryColor: "#445566" }), "a1");
    assert.equal((await getAgentBrand("a1"))?.kitId, "kit_1");
    assert.doesNotMatch(JSON.stringify(brandKitFile((await getStore().get("brand", "brand_a1"))!)), /kit_1/);
  });

  it("say when HeyGen stopped early or no longer has the kit, which is then not sent", async () => {
    proto.importBrandKit = async () => ({ kitId: "kit_gone" });
    const kit = await importAgentBrand({ url: "acme.com" }, "a1");
    await getStore().put("agentbrand", { ...kit, checkedAt: new Date(0).toISOString() });
    proto.brandKitDetails = async () => null;
    const gone = await getAgentBrand("a1");
    assert.deepEqual([gone?.status, gone?.missing], ["error", true]);
    assert.match(gone?.error ?? "", /no longer has this brand kit; import it again/);
    assert.equal(await agentKitFor("a1"), null);
    // Trouble asking HeyGen leaves the kit as it was.
    proto.brandKitDetails = async () => {
      throw new Error("HeyGen GET failed: 503");
    };
    const again = await importAgentBrand({ url: "acme.com" }, "a1");
    await getStore().put("agentbrand", { ...again, checkedAt: new Date(0).toISOString() });
    assert.equal((await getAgentBrand("a1"))?.status, "loading");
  });

  it("dress the account's own directed videos only, whatever the request names", async () => {
    proto.importBrandKit = async () => ({ kitId: "kit_mine" });
    await importAgentBrand({ url: "acme.com" }, "a1");
    const mine = await directAgentVideo(videoAgentSchema.parse(ASK), "a1");
    assert.deepEqual([mine.directed?.brandKitId, mine.directed?.brandKitName], ["kit_mine", "acme.com"]);
    const theirs = await directAgentVideo(videoAgentSchema.parse(ASK), "a2");
    assert.equal(theirs.directed?.brandKitId, undefined);
    assert.equal(theirs.directed?.brandKitName, undefined);
    // A retry is dressed in the kit as it is now, not the one its request carried.
    const at = new Date().toISOString();
    const failed: Video = { ...mine, id: "vid_failed_kit", status: "failed", error: "boom", directed: { ...mine.directed!, brandKitId: "kit_someone_else", brandKitName: "Other" }, createdAt: at, updatedAt: at };
    await getStore().put("video", failed);
    const retried = await retryVideo(failed.id, "a1");
    assert.deepEqual([retried.directed?.brandKitId, retried.directed?.brandKitName], ["kit_mine", "acme.com"]);
    await removeAgentBrand("a1");
    const plain = await retryVideo((await getStore().put("video", { ...failed, id: "vid_failed_kit2" })).id, "a1");
    assert.equal(plain.directed?.brandKitId, undefined, "and in none once it is removed");
  });

  it("delete a replaced or removed kit at HeyGen once its grace has passed and no video of the account names it", async () => {
    let n = 0;
    proto.importBrandKit = async () => ({ kitId: `kit_${++n}` });
    await importAgentBrand({ url: "acme.com" }, "a1");
    await importAgentBrand({ url: "acme.com/b" }, "a1");
    // Kept for a while after it is replaced, so a video that read it just before is not left with a deleted kit.
    assert.deepEqual(deleted, []);
    assert.deepEqual((await kits("a1")).map((k) => [k.kitId, !!k.current]).sort(), [["kit_1", false], ["kit_2", true]]);
    await age("a1");
    assert.equal((await getAgentBrand("a1"))?.kitId, "kit_2", "a read sweeps it once its grace has passed");
    assert.deepEqual(deleted, ["kit_1"]);
    assert.deepEqual((await kits("a1")).map((k) => [k.kitId, !!k.current]), [["kit_2", true]]);
    // A video it dressed keeps the second, since that video's HeyGen session goes on using it.
    await directAgentVideo(videoAgentSchema.parse(ASK), "a1");
    await removeAgentBrand("a1");
    await age("a1");
    assert.equal(await getAgentBrand("a1"), null);
    assert.deepEqual(deleted, ["kit_1"]);
    const kept = await kits("a1");
    assert.deepEqual(kept.map((k) => [k.kitId, !!k.current, !!k.sweptAt]), [["kit_2", false, true]]);
    // Looked at again an hour on, once that video is gone.
    for (const v of await getStore().list<Video>("video", "a1")) await getStore().remove("video", v.id);
    await getAgentBrand("a1");
    assert.deepEqual(deleted, ["kit_1"], "not again within the hour");
    await age("a1");
    await getAgentBrand("a1");
    assert.deepEqual(deleted, ["kit_1", "kit_2"]);
    assert.deepEqual(await kits("a1"), []);
    // A kit HeyGen cannot delete just now is kept and tried again.
    proto.deleteBrandKit = async () => {
      throw new Error("HeyGen DELETE failed: 503");
    };
    await importAgentBrand({ url: "acme.com/c" }, "a1");
    await removeAgentBrand("a1");
    await age("a1");
    await getAgentBrand("a1");
    assert.equal((await kits("a1")).length, 1);
  });

  it("are one import at HeyGen when a call that timed out is made again, and a new one once the kit in use changed", async () => {
    const keys: string[] = [];
    proto.importBrandKit = async (_input: unknown, key: string) => {
      keys.push(key);
      if (keys.length === 1) throw new Error("The operation was aborted due to timeout");
      return { kitId: "kit_once" };
    };
    await assert.rejects(importAgentBrand({ url: "acme.com" }, "a1"), /timeout/);
    const kit = await importAgentBrand({ url: "https://acme.com/" }, "a1");
    assert.equal(keys[1], keys[0], "the same key, so HeyGen gives back the kit the first call made");
    assert.equal(kit.kitId, "kit_once");
    await importAgentBrand({ url: "acme.com" }, "a2");
    assert.notEqual(keys[2], keys[0], "another account's import is its own");
    // With the kit in use changed, the same page is a new import, and the kit HeyGen gives back is kept, not deleted.
    proto.importBrandKit = async (_input: unknown, key: string) => (keys.push(key), { kitId: "kit_once" });
    await importAgentBrand({ url: "acme.com" }, "a1");
    assert.notEqual(keys[3], keys[1]);
    await removeAgentBrand("a1");
    await importAgentBrand({ url: "acme.com" }, "a1");
    await age("a1");
    await getAgentBrand("a1");
    assert.deepEqual(deleted, []);
    assert.deepEqual((await kits("a1")).map((k) => [k.kitId, !!k.current]), [["kit_once", true]]);
  });

  it("are not used by another renderer, and are deleted at the renderer that made them", async () => {
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    const theirs: AgentBrandKit = { id: "agentbrand_hg", ownerId: "a1", current: true, provider: "heygen", url: "https://acme.com/", kitId: "bk_real", status: "completed", checkedAt: at, createdAt: at, updatedAt: at };
    await getStore().put("agentbrand", theirs);
    assert.equal(await getAgentBrand("a1"), null);
    assert.equal(await agentKitFor("a1"), null);
    const video = await directAgentVideo(videoAgentSchema.parse(ASK), "a1");
    assert.equal(video.directed?.brandKitId, undefined);
  });

  it("time out a kit HeyGen never finishes reading, and do not bring back one removed while HeyGen is asked", async () => {
    proto.importBrandKit = async () => ({ kitId: "kit_slow" });
    const kit = await importAgentBrand({ url: "acme.com" }, "a1");
    proto.brandKitDetails = async () => ({ status: "loading", colors: [], fonts: [] });
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    await getStore().put("agentbrand", { ...kit, createdAt: old, checkedAt: old });
    const late = await getAgentBrand("a1");
    assert.deepEqual([late?.status, late?.missing], ["error", undefined]);
    assert.equal((await agentKitFor("a1"))?.kitId, "kit_slow", "still used, with what HeyGen found");
    // Removed while HeyGen is being asked: the answer is not written over the removal.
    proto.importBrandKit = async () => ({ kitId: "kit_raced" });
    const raced = await importAgentBrand({ url: "acme.com/raced" }, "a1");
    // Last written over two seconds ago, as a kit asked about again always is.
    await getStore().put("agentbrand", { ...raced, checkedAt: old, updatedAt: old });
    proto.brandKitDetails = async () => (await removeAgentBrand("a1"), { status: "completed", colors: ["#111111"], fonts: [] });
    assert.equal(await getAgentBrand("a1"), null);
    assert.equal((await kits("a1")).find((k) => k.kitId === "kit_raced")?.current, undefined);
  });

  it("go with the account: every kit it had is deleted at HeyGen, or the account is kept", async () => {
    let n = 0;
    proto.importBrandKit = async () => ({ kitId: `kit_${++n}` });
    await importAgentBrand({ url: "acme.com" }, "a1");
    await directAgentVideo(videoAgentSchema.parse(ASK), "a1");
    await importAgentBrand({ url: "acme.com/new" }, "a1");
    await deleteOwnerData("a1");
    assert.deepEqual(deleted.sort(), ["kit_1", "kit_2"]);
    assert.deepEqual(await kits("a1"), []);
    // A kit the renderer will not delete keeps the account, so its id is not lost.
    proto.deleteBrandKit = async () => {
      throw new Error("HeyGen DELETE failed: 503");
    };
    await importAgentBrand({ url: "acme.com/again" }, "a3");
    await assert.rejects(deleteOwnerData("a3"), ConflictError);
    assert.equal((await kits("a3")).length, 1);
  });
});

describe("HeyGen's brand kit calls", () => {
  type Client = Record<string, (...a: unknown[]) => Promise<unknown>>;
  const heygen = () => {
    const p = new HeyGenAvatarProvider("key");
    return { p, client: (p as unknown as { client: Client }).client };
  };

  it("import with a key, saying a page HeyGen cannot read and a workspace that may not make kits", async () => {
    const { p, client } = heygen();
    let call: unknown[] = [];
    client.createBrandKit = async (...a) => ((call = a), { brand_kit_id: "bk_1", status: "loading" });
    assert.deepEqual(await p.importBrandKit({ url: "https://acme.com/", name: "Acme" }, "key_1"), { kitId: "bk_1" });
    assert.deepEqual(call, [{ url: "https://acme.com/", name: "Acme" }, "key_1"]);
    client.createBrandKit = async () => {
      throw new Error('HeyGen POST https://api.heygen.com/v3/brand-kits failed: 400 {"error":{"code":"invalid_parameter","message":"URL is not supported"}}');
    };
    await assert.rejects(p.importBrandKit({ url: "https://acme.com/" }, "k"), /HeyGen could not import that page: URL is not supported/);
    client.createBrandKit = async () => {
      throw new Error('HeyGen POST https://api.heygen.com/v3/brand-kits failed: 403 {"error":{"code":"forbidden"}}');
    };
    await assert.rejects(p.importBrandKit({ url: "https://acme.com/" }, "k"), /does not allow creating brand kits/);
  });

  it("read colours by role first, the primary logo by https, and fonts by role, null once HeyGen has none", async () => {
    const { p, client } = heygen();
    client.brandKit = async () => ({
      brand_kit_id: "bk_1",
      name: " Acme ",
      status: "completed",
      colors: ["#FFFFFF", "#1D4ED8", "red", "#123"],
      color_roles: { primary: "#1d4ed8", accent: "#F59E0B", secondary: null },
      logos: [
        { logo_id: "l1", url: "http://cdn.example.com/a.png" },
        { logo_id: "l2", url: "https://cdn.example.com/b.png" },
        { logo_id: "l3", url: "https://cdn.example.com/c.png" },
      ],
      logo_roles: { primary: "l3" },
      fonts: [
        { font_id: "f1", name: "Merriweather" },
        { font_id: "f2", name: "Inter" },
      ],
      font_roles: { title_text: { font_id: "f2" }, body_text: { font_id: "f_deleted" } },
    });
    assert.deepEqual(await p.brandKitDetails("bk_1"), { status: "completed", name: "Acme", colors: ["#1d4ed8", "#f59e0b", "#ffffff"], logoUrl: "https://cdn.example.com/c.png", fonts: ["Inter", "Merriweather"] });
    client.brandKit = async () => ({ status: "queued", logos: [{ logo_id: "l1", url: "http://x.example.com/a.png" }] });
    assert.deepEqual(await p.brandKitDetails("bk_1"), { status: "loading", colors: [], fonts: [] });
    client.brandKit = async () => {
      throw new Error('HeyGen GET https://api.heygen.com/v3/brand-kits/bk_1 failed: 404 {"error":{"code":"resource_not_found"}}');
    };
    assert.equal(await p.brandKitDetails("bk_1"), null);
    client.deleteBrandKit = async () => {
      throw new Error("HeyGen DELETE https://api.heygen.com/v3/brand-kits/bk_1 failed: 404 {}");
    };
    await p.deleteBrandKit("bk_1");
  });

  it("send brand_kit_id on a directed video that has one, and say a kit HeyGen no longer has", async () => {
    const { p, client } = heygen();
    let body: Record<string, unknown> = {};
    client.createVideoAgent = async (b) => ((body = b as Record<string, unknown>), { session_id: "s1" });
    const directed = { brief: "Hi", prompt: "Hi", orientation: "landscape" as const, lengthSec: 60, language: "English" };
    const req = { title: "T", script: "", avatarId: "", voiceId: "", aspect: "16:9", resolution: "1080p", background: { type: "color", value: "#000000" }, captions: false, speed: 1 } as const;
    await p.startDirected({ ...req, directed: { ...directed, brandKitId: "bk_1", brandKitName: "Acme" } } as never, null, null, "vid_1");
    assert.equal(body.brand_kit_id, "bk_1");
    await p.startDirected({ ...req, directed } as never, null, null, "vid_2");
    assert.equal("brand_kit_id" in body, false);
    client.createVideoAgent = async () => {
      throw new Error('HeyGen POST https://api.heygen.com/v3/video-agents failed: 400 {"error":{"code":"invalid_parameter","message":"brand_kit_id not found"}}');
    };
    await assert.rejects(p.startDirected({ ...req, directed: { ...directed, brandKitId: "bk_1" } } as never, null, null, "vid_3"), /no longer has your HeyGen brand kit; import it again on the Brand page/);
  });
});
