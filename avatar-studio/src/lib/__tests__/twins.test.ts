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
  listVoices,
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
import type { Avatar, TwinJob, Voice } from "../types";
import { forgetMemo } from "../cache";

const FOOTAGE = "https://93.184.216.34/dana-footage.mp4";
const clipMs = MockAvatarProvider as unknown as { CLIP_MS: number };
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetTwinChecks();
  forgetMemo();
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
      assert.deepEqual(Object.keys(publicTwin(job)).filter((k) => ["ownerId", "provider", "lookId", "groupId", "voiceId", "imageUrl"].includes(k)), [], "the renderer, its look, character, and voice stay on the server");
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
    assert.deepEqual(Object.keys(exported[0]).filter((k) => ["provider", "lookId", "groupId", "voiceId", "imageUrl", "consentUrl"].includes(k)), []);
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

/**
 * HeyGen as the tests need it: each start makes look_N, group_N, and voice_N (`fail` makes the next start's answer get
 * lost, `refuse` refuses it); looks and characters answer from `looks` and `groups`; voices are listed and deleted.
 */
function heygenStub() {
  const state = {
    starts: 0,
    posts: [] as Array<{ idem: string | null }>,
    deleted: [] as string[],
    fail: 0,
    refuse: null as null | { status: number; message: string },
    looks: {} as Record<string, Record<string, unknown>>,
    groups: {} as Record<string, Record<string, unknown> | 404>,
    listed: [] as Array<Record<string, unknown>>,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "https://api.heygen.com/v3/avatars" && method === "POST") {
      state.posts.push({ idem: new Headers(init?.headers).get("idempotency-key") });
      if (state.refuse) return Response.json({ error: { code: "x", message: state.refuse.message } }, { status: state.refuse.status });
      // Each key is answered with the twin it first made, as HeyGen replays an idempotency key.
      const idem = new Headers(init?.headers).get("idempotency-key")!;
      const n = (state as unknown as { byKey: Map<string, number> }).byKey.get(idem) ?? ++state.starts;
      (state as unknown as { byKey: Map<string, number> }).byKey.set(idem, n);
      if (state.fail > 0) {
        state.fail -= 1;
        throw new TypeError("fetch failed");
      }
      return Response.json({ data: { avatar_item: { id: `look_${n}`, default_voice_id: `voice_${n}` }, avatar_group: { id: `group_${n}` } } });
    }
    const lookId = /\/v3\/avatars\/looks\/(look_\d+)$/.exec(url)?.[1];
    if (lookId) return Response.json({ data: state.looks[lookId] ?? { status: "processing" } });
    const groupId = /\/v3\/avatars\/(group_\d+)$/.exec(url)?.[1];
    if (groupId) {
      const group = state.groups[groupId] ?? { consent_status: null };
      return group === 404 ? Response.json({ error: { code: "not_found", message: "Avatar group not found" } }, { status: 404 }) : Response.json({ data: group });
    }
    const voiceId = /\/v3\/voices\/([^/?]+)$/.exec(url)?.[1];
    if (voiceId && method === "DELETE") {
      state.deleted.push(voiceId);
      return Response.json({ data: { voice_id: voiceId } });
    }
    if (url.includes("/v3/voices?type=private")) return Response.json({ data: [1, 2, 3].map((n) => ({ voice_id: `voice_${n}`, name: `Clone ${n}` })).concat([{ voice_id: "operator_voice", name: "Operator" }]), has_more: false });
    if (url.includes("/v3/voices?type=public")) return Response.json({ data: [{ voice_id: "public_voice", name: "Nadine" }], has_more: false });
    if (url.includes("/v3/avatars/looks?ownership=")) return Response.json({ data: url.includes("private") ? state.listed : [], has_more: false });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  (state as unknown as { byKey: Map<string, number> }).byKey = new Map();
  setTwinPictureFetch((async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), { headers: { "content-type": "image/png" } })) as never);
  return state;
}

async function inHeygen(fn: () => Promise<void>) {
  const { config } = await import("../config");
  const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
  Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
  try {
    await fn();
  } finally {
    Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
  }
}

const ids = (voices: Voice[]) => voices.map((v) => v.id);
const old = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("digital twins with HeyGen: voices, lost answers, and the shared library", () => {
  it("keeps the voice cloned from the footage the account's own, out of every other list, and deletes an unused one", () =>
    inHeygen(async () => {
      const hg = heygenStub();
      const dana = await startTwin(input(), "u1");
      assert.equal(ids(await listVoices("u2")).includes("voice_1"), false, "the clone is never offered to another account, even while it trains");
      assert.ok(ids(await listVoices("u2")).includes("operator_voice"), "the operator's own HeyGen voices are listed as before");
      // Trained, and a workspace HeyGen lets skip consent has it given already: no link is needed.
      hg.looks.look_1 = { status: "completed", preview_image_url: "https://93.184.216.34/twin.png" };
      hg.groups.group_1 = { consent_status: "accepted" };
      const [twin] = await listTwins("u1");
      assert.deepEqual([twin.status, twin.consent], ["completed", "accepted"]);
      assert.equal((await getAvatar(twin.avatarId!, "u1")).defaultVoiceId, "voice_1", "the presenter opens with its own voice");
      const mine = (await listVoices("u1")).find((v) => v.id === "voice_1")!;
      assert.deepEqual([mine.name, mine.source, mine.tags], ["Dana Ruiz (twin)", "custom", ["digital twin"]]);
      assert.equal(ids(await listVoices("u2")).includes("voice_1"), false);
      // A twin forgotten before it became anything takes its clone with it; one that did keeps its voice.
      const lee = await startTwin(input({ name: "Lee" }), "u1");
      await deleteTwin(lee.id, "u1");
      assert.deepEqual(hg.deleted, ["voice_2"]);
      await deleteTwin(dana.id, "u1");
      assert.deepEqual(hg.deleted, ["voice_2"], "the account's voice stays");
      assert.ok(ids(await listVoices("u1")).includes("voice_1"));
      assert.equal(ids(await listVoices("u2")).some((v) => v === "voice_1" || v === "voice_2"), false, "nor after the twins are forgotten");
      // Deleting the account deletes the voice it kept, and a twin's unused clone.
      await startTwin(input({ name: "Kim" }), "u1");
      await deleteOwnerData("u1");
      assert.deepEqual(hg.deleted.slice().sort(), ["voice_1", "voice_2", "voice_3"]);
      assert.equal(ids(await listVoices("u2")).some((v) => /^voice_/.test(v)), false);
    }));

  it("keeps the twin before HeyGen is asked, so an answer lost on the way back is asked for again with the same key", () =>
    inHeygen(async () => {
      const hg = heygenStub();
      hg.fail = 1;
      await assert.rejects(startTwin(input(), "u1", { key: "lost-key-1" }), /fetch failed/);
      const [kept] = await getStore().list<TwinJob>("twin", "u1");
      assert.deepEqual([kept.lookId, kept.status], ["", "processing"]);
      // A retry at once is told to wait; the first request may still be answered.
      await assert.rejects(startTwin(input(), "u1", { key: "lost-key-1" }), /still being sent/);
      await assert.rejects(requestTwinConsent(kept.id, "u1"), /still being sent/);
      await getStore().put("twin", { ...kept, createdAt: old(3 * 60_000) });
      await startTwin(input(), "u1", { key: "lost-key-1" });
      const recovered = (await getStore().get<TwinJob>("twin", kept.id))!;
      assert.deepEqual([recovered.lookId, recovered.groupId, recovered.voiceId], ["look_1", "group_1", "voice_1"]);
      assert.deepEqual(hg.posts.map((p) => p.idem), [kept.id, kept.id], "asked again with the same key, so HeyGen answers with the twin it made");
      assert.equal(hg.starts, 1);
      // Without a client key the next check asks again; a start HeyGen never answered within its day is given up.
      hg.fail = 1;
      await assert.rejects(startTwin(input({ name: "Lee" }), "u1"), /fetch failed/);
      const lee = (await getStore().list<TwinJob>("twin", "u1")).find((t) => t.name === "Lee")!;
      await getStore().put("twin", { ...lee, createdAt: old(3 * 60_000) });
      forgetTwinChecks();
      await listTwins("u1");
      assert.equal((await getStore().get<TwinJob>("twin", lee.id))!.lookId, "look_2");
      assert.equal(ids(await listVoices("u2")).includes("voice_2"), false);
      hg.fail = 1;
      await assert.rejects(startTwin(input({ name: "Kim" }), "u1"), /fetch failed/);
      const kim = (await getStore().list<TwinJob>("twin", "u1")).find((t) => t.name === "Kim")!;
      await getStore().put("twin", { ...kim, createdAt: old(25 * 60 * 60_000) });
      forgetTwinChecks();
      const gaveUp = (await listTwins("u1")).find((t) => t.id === kim.id)!;
      assert.deepEqual([gaveUp.status, gaveUp.error], ["failed", "The renderer never confirmed this twin; train it again"]);
      // A refusal made nothing, so nothing is kept.
      hg.refuse = { status: 400, message: "The footage must be at least 15 seconds long." };
      await assert.rejects(startTwin(input({ name: "Short" }), "u1"), ValidationError);
      assert.equal((await getStore().list<TwinJob>("twin", "u1")).some((t) => t.name === "Short"), false);
    }));

  it("never lists a digital twin from HeyGen's account to anyone, ends a twin HeyGen lost, and hides the link from viewers", () =>
    inHeygen(async () => {
      const hg = heygenStub();
      hg.listed = [
        { id: "look_stranger", name: "Someone", avatar_type: "digital_twin", preview_image_url: "https://93.184.216.34/a.png", status: "completed" },
        { id: "look_studio", name: "Studio presenter", avatar_type: "studio_avatar", preview_image_url: "https://93.184.216.34/b.png", status: "completed" },
      ];
      const shown = (await listAvatars("u2")).map((a) => a.id);
      assert.deepEqual([shown.includes("look_stranger"), shown.includes("look_studio")], [false, true], "a twin the studio does not know of is a real person all the same");
      const job = await startTwin(input(), "u1");
      const asked = await requestTwinConsent(job.id, "u1").catch(() => null);
      assert.equal(asked, null, "HeyGen's consent call is not stubbed here");
      await getStore().put("twin", { ...(await getStore().get<TwinJob>("twin", job.id))!, consent: "pending", consentUrl: "https://heygen.com/consent/abc", consentUrlAt: new Date().toISOString() });
      const stored = (await getStore().get<TwinJob>("twin", job.id))!;
      assert.equal(publicTwin(stored).consentUrl, "https://heygen.com/consent/abc");
      assert.equal(publicTwin(stored, Date.now(), false).consentUrl, undefined, "a viewer of the workspace is not handed the person's link");
      hg.groups.group_1 = 404;
      forgetTwinChecks();
      const [gone] = await listTwins("u1");
      assert.deepEqual([gone.status, gone.error], ["failed", "HeyGen no longer has this twin"]);
    }));
});
