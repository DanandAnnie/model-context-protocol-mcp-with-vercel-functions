// Digital twins (HeyGen digital twin): a presenter trained from footage of a real person, usable once the person has
// recorded their consent. What is accepted, what HeyGen is asked, how training and consent are followed, and that the
// twin's look stays the account's own.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import {
  MAX_TWINS,
  deleteOwnerData,
  deleteTwin,
  exportOwnerData,
  forgetTwinChecks,
  getAvatar,
  listAvatars,
  listTwins,
  publicTwin,
  requestTwinConsent,
  setTwinPictureFetch,
  startTwin,
  twinKeySchema,
  twinRequestSchema,
} from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { getStore } from "../store";
import type { Avatar, TwinJob } from "../types";

const FOOTAGE = "https://93.184.216.34/dana-footage.mp4";
const clipMs = MockAvatarProvider as unknown as { CLIP_MS: number };
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetTwinChecks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setTwinPictureFetch(undefined);
});

const input = (extra: Record<string, unknown> = {}) => twinRequestSchema.parse({ name: "Dana Ruiz", footageUrl: FOOTAGE, agreed: true, ...extra });

describe("digital twins", () => {
  it("takes a name, a public https link to the footage, and the account's word that the person agreed", async () => {
    assert.throws(() => twinRequestSchema.parse({ name: "Dana", footageUrl: FOOTAGE }), /Confirm that the person in the footage agreed/);
    assert.throws(() => twinRequestSchema.parse({ name: "Dana", footageUrl: FOOTAGE, agreed: false }), /Confirm/);
    assert.throws(() => twinRequestSchema.parse({ name: " ", footageUrl: FOOTAGE, agreed: true }), /Give the twin a name/);
    await assert.rejects(startTwin(input({ footageUrl: "http://93.184.216.34/a.mp4" }), "u1"), /public https link to the footage/);
    await assert.rejects(startTwin(input({ footageUrl: "https://127.0.0.1/a.mp4" }), "u1"), ValidationError);
  });

  it("trains in demo mode, waits for the person's consent, then is a presenter of the account only", async () => {
    assert.equal(providerStatus().digitalTwins, true);
    const saved = clipMs.CLIP_MS;
    try {
      const job = await startTwin(input({ gender: "female" }), "u1");
      assert.match(job.id, /^tw_/);
      assert.deepEqual([job.status, job.training, job.consent], ["processing", "processing", "not_requested"]);
      assert.deepEqual(Object.keys(publicTwin(job)).filter((k) => ["ownerId", "provider", "lookId", "groupId", "imageUrl"].includes(k)), [], "the renderer, its look, and its character stay on the server");
      // Trained, but not a presenter before consent is given.
      let [twin] = await listTwins("u1");
      assert.deepEqual([twin.training, twin.consent, twin.status, twin.avatarId], ["completed", "not_requested", "processing", undefined]);
      assert.equal((await listAvatars("u1")).some((a) => a.name === "Dana Ruiz"), false);
      clipMs.CLIP_MS = 60_000;
      const asked = await requestTwinConsent(job.id, "u1");
      assert.deepEqual([asked.consent, asked.consentUrl], ["pending", "/demo-consent"]);
      assert.equal((await requestTwinConsent(job.id, "u1")).consentUrlAt, asked.consentUrlAt, "a link still valid is handed back as it is");
      forgetTwinChecks();
      assert.equal((await listTwins("u1"))[0].consent, "pending");
      clipMs.CLIP_MS = 0;
      forgetTwinChecks();
      [twin] = await listTwins("u1");
      assert.deepEqual([twin.consent, twin.status], ["accepted", "completed"]);
      const avatar = await getAvatar(twin.avatarId!, "u1");
      assert.deepEqual([avatar.name, avatar.source, avatar.gender, avatar.tags], ["Dana Ruiz", "custom", "female", ["digital twin"]]);
      assert.match(avatar.imageUrl, /^data:image\/svg\+xml/);
      await assert.rejects(requestTwinConsent(job.id, "u1"), /already given/);
      // Another account sees neither the twin nor its presenter.
      assert.deepEqual(await listTwins("u2"), []);
      await assert.rejects(getAvatar(twin.avatarId!, "u2"), NotFoundError);
      await assert.rejects(requestTwinConsent(job.id, "u2"), NotFoundError);
      await assert.rejects(deleteTwin(job.id, "u2"), NotFoundError);
      // Asked again, nothing is made twice; forgetting the twin keeps its presenter.
      forgetTwinChecks();
      await listTwins("u1");
      assert.equal((await getStore().list<Avatar>("avatar", "u1")).length, 1);
      await deleteTwin(job.id, "u1");
      assert.deepEqual(await listTwins("u1"), []);
      assert.ok(await getStore().get("avatar", twin.avatarId!));
      await assert.rejects(deleteTwin("../x", "u1"), /Unknown digital twin/);
    } finally {
      clipMs.CLIP_MS = saved;
    }
  });

  it("offers a new consent link once the last is a day old, and none for a twin that could not be trained", async () => {
    const job = await startTwin(input(), "u1");
    const asked = await requestTwinConsent(job.id, "u1");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await getStore().put("twin", { ...(await getStore().get<TwinJob>("twin", job.id))!, consentUrlAt: old });
    const stale = (await getStore().get<TwinJob>("twin", job.id))!;
    const shown = publicTwin(stale);
    assert.equal(shown.consentUrl, undefined, "an expired link is not offered");
    assert.equal(shown.consentLinkExpired, true);
    const renewed = await requestTwinConsent(job.id, "u1");
    assert.notEqual(renewed.consentUrlAt, old);
    assert.ok(Date.parse(renewed.consentUrlAt!) >= Date.parse(asked.consentUrlAt!));
    await getStore().put("twin", { ...renewed, status: "failed", training: "failed", error: "Two people are in frame." });
    await assert.rejects(requestTwinConsent(job.id, "u1"), /could not be trained: Two people are in frame\./);
  });

  it("returns the same twin for a start retried with the same key, without asking the renderer again", async () => {
    const proto = MockAvatarProvider.prototype as unknown as { startTwin: (...a: unknown[]) => Promise<{ lookId: string; groupId: string }> };
    const real = proto.startTwin;
    const keys: unknown[] = [];
    proto.startTwin = async function (this: unknown, ...a: unknown[]) {
      keys.push((a[0] as { key: string }).key);
      return real.apply(this, a);
    };
    try {
      let admitted = 0;
      const admit = () => void admitted++;
      const first = await startTwin(input(), "u1", { key: "twin-key-1", admit });
      const again = await startTwin(input(), "u1", { key: "twin-key-1", admit });
      assert.equal(again.id, first.id);
      assert.deepEqual([keys.length, admitted], [1, 1]);
      assert.equal(keys[0], first.id, "the renderer's idempotency key is the twin's id");
      await assert.rejects(startTwin(input({ footageUrl: "https://93.184.216.34/other.mp4" }), "u1", { key: "twin-key-1" }), ConflictError);
      assert.throws(() => twinKeySchema.parse("short"), /8 to 100/);
    } finally {
      proto.startTwin = real;
    }
  });

  it("keeps at most the account's limit, goes with the account, and its look stays hidden from other accounts", async () => {
    const { STOCK_AVATARS } = await import("../stock");
    const look = STOCK_AVATARS[0].id;
    for (let i = 0; i < MAX_TWINS; i++) {
      const at = new Date().toISOString();
      await getStore().put("twin", { id: `tw_old${i}`, ownerId: "u1", name: "Old", footageUrl: FOOTAGE, provider: "mock", lookId: look, groupId: "g", training: "failed", consent: "not_requested", status: "failed", createdAt: at, updatedAt: at } satisfies TwinJob);
    }
    await assert.rejects(startTwin(input(), "u1"), ConflictError);
    assert.equal((await listAvatars("u2")).some((a) => a.id === look), false, "a twin's look is never offered to another account");
    const exported = (await exportOwnerData("u1")).twin;
    assert.equal(exported.length, MAX_TWINS);
    assert.deepEqual(Object.keys(exported[0]).filter((k) => ["provider", "lookId", "groupId", "imageUrl"].includes(k)), []);
    assert.equal((await deleteOwnerData("u1")).twin, MAX_TWINS);
    assert.equal((await listAvatars("u2")).some((a) => a.id === look), false, "nor after the account is deleted");
  });

  it("asks HeyGen to train the twin and to start consent with keys, follows both, and maps refusals", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
    let look: Record<string, unknown> = { status: "processing" };
    let group: Record<string, unknown> = { consent_status: null };
    let refuse: { status: number; message: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method ?? "GET", body, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/avatars" && init?.method === "POST") {
        if (refuse) return Response.json({ error: { code: "x", message: refuse.message } }, { status: refuse.status });
        return Response.json({ data: { avatar_item: { id: "look_twin", default_voice_id: "voice_twin" }, avatar_group: { id: "group_twin" } } });
      }
      if (url === "https://api.heygen.com/v3/avatars/group_twin/consent" && init?.method === "POST") return Response.json({ data: { url: "https://heygen.com/consent/abc", avatar_group: { id: "group_twin", consent_status: "pending" } } });
      if (url === "https://api.heygen.com/v3/avatars/group_twin") return Response.json({ data: group });
      if (url === "https://api.heygen.com/v3/avatars/looks/look_twin") return Response.json({ data: look });
      if (url.includes("/v3/avatars/looks?ownership=")) return Response.json({ data: [{ id: "look_twin", name: "Dana Ruiz", avatar_type: "digital_twin", preview_image_url: "https://93.184.216.34/twin.png", status: "completed" }], has_more: false });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    setTwinPictureFetch((async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), { headers: { "content-type": "image/png" } })) as never);
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const job = await startTwin(input(), "u1");
      const post = calls.find((c) => c.url.endsWith("/v3/avatars") && c.method === "POST")!;
      assert.deepEqual(post.body, { type: "digital_twin", name: "Dana Ruiz", file: { type: "url", url: FOOTAGE } });
      assert.equal(post.idem, job.id);
      assert.equal((await listAvatars("u2")).some((a) => a.id === "look_twin"), false, "the twin's look is never listed to another account");
      const asked = await requestTwinConsent(job.id, "u1");
      assert.deepEqual([asked.consent, asked.consentUrl], ["pending", "https://heygen.com/consent/abc"]);
      assert.match(calls.find((c) => c.url.endsWith("/consent"))!.idem!, new RegExp(`^${job.id}\\.\\d+$`));
      // Training finishes; consent is still pending, then refused with a reason, then given.
      look = { status: "completed", preview_image_url: "https://93.184.216.34/twin.png" };
      forgetTwinChecks();
      let [twin] = await listTwins("u1");
      assert.deepEqual([twin.training, twin.consent, twin.status], ["completed", "pending", "processing"]);
      group = { consent_status: "rejected", status: "failed", error: { message: "Please make sure your consent video is under 35s." } };
      forgetTwinChecks();
      [twin] = await listTwins("u1");
      assert.deepEqual([twin.consent, twin.error], ["rejected", "Please make sure your consent video is under 35s."]);
      group = { consent_status: "accepted" };
      forgetTwinChecks();
      [twin] = await listTwins("u1");
      assert.equal(twin.status, "completed");
      const avatar = await getAvatar(twin.avatarId!, "u1");
      assert.deepEqual(avatar.providerAssetIds, { "heygen:look": "look_twin", "heygen:pending": "" }, "it renders as the trained look");
      assert.match(avatar.imageUrl, /^data:image\/png;base64,/);
      // Footage HeyGen will not train is a refusal with its reason; a start still being sent is a conflict to retry.
      refuse = { status: 400, message: "The footage must be at least 15 seconds long." };
      await assert.rejects(startTwin(input({ name: "Short" }), "u1"), (e: unknown) => e instanceof ValidationError && /could not train a twin from that footage: The footage must be at least 15 seconds long\./.test((e as Error).message));
      refuse = { status: 409, message: "in progress" };
      await assert.rejects(startTwin(input({ name: "Again" }), "u1"), ConflictError);
      // Training that fails ends the twin with HeyGen's reason.
      refuse = null;
      const bad = await startTwin(input({ name: "Bad footage" }), "u1");
      await getStore().put("twin", { ...(await getStore().get<TwinJob>("twin", bad.id))!, lookId: "look_twin" });
      look = { status: "failed", error: { message: "More than one person was found in the footage." } };
      forgetTwinChecks();
      const failed = (await listTwins("u1")).find((t) => t.id === bad.id)!;
      assert.deepEqual([failed.status, failed.training, failed.error], ["failed", "failed", "More than one person was found in the footage."]);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("is not offered by a renderer without it", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().digitalTwins, false);
      await assert.rejects(startTwin(input(), "u1"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
