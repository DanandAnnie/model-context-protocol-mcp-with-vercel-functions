// The voice changer: instant voices made from one of the account's audio clips with the speaker's agreement, and
// recordings spoken again in one of them; each account's own, retried by key, followed while the renderer works, deleted
// at the renderer with the voice or the account; and the HeyGen requests behind them.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import {
  MAX_INSTANT_VOICES,
  createClip,
  createInstantVoice,
  deleteInstantVoice,
  deleteOwnerData,
  deleteVoiceChange,
  exportOwnerData,
  forgetVoiceChangerChecks,
  instantVoiceSchema,
  listInstantVoices,
  listVoiceChanges,
  publicInstantVoice,
  publicVoiceChange,
  startVoiceChange,
  voiceChangeSchema,
} from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { getStore } from "../store";
import type { InstantVoice, VoiceChange } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetVoiceChangerChecks();
});

/** A silent one-second 16-bit mono WAV, as the editor saves clips. */
function wavDataUrl(): string {
  const rate = 8000;
  const size = rate * 2;
  const v = new DataView(new ArrayBuffer(44 + size));
  const put = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + size, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, size, true);
  return `data:audio/wav;base64,${Buffer.from(v.buffer).toString("base64")}`;
}

const clipMs = MockAvatarProvider as unknown as { CLIP_MS: number };
const clip = (owner: string, name = "Take") => createClip({ name, audio: wavDataUrl() }, owner);
const ready = async (owner: string, name = "Narrator") => {
  const sample = await clip(owner, "Sample");
  const voice = await createInstantVoice(instantVoiceSchema.parse({ name, clipId: sample.id, agreed: true }), owner);
  await getStore().put("instantvoice", { ...(await getStore().get<InstantVoice>("instantvoice", voice.id))!, status: "completed" });
  return voice;
};

describe("voice changer", () => {
  it("checks the requests: a name, a recording, and the speaker's agreement", () => {
    assert.equal(instantVoiceSchema.safeParse({ name: "N", clipId: "c" }).success, false, "the agreement is required");
    assert.throws(() => instantVoiceSchema.parse({ name: "N", clipId: "c", agreed: false }), /speaker agreed/);
    assert.throws(() => instantVoiceSchema.parse({ clipId: "c", agreed: true }), /Name the voice/);
    assert.throws(() => instantVoiceSchema.parse({ name: "x".repeat(61), clipId: "c", agreed: true }), /60 characters/);
    assert.throws(() => voiceChangeSchema.parse({ voiceId: "vo_x", clipId: "c" }), /Choose one of your instant voices/);
    assert.equal(voiceChangeSchema.parse({ voiceId: "iv_x", clipId: "c" }).removeNoise, false);
  });

  it("makes a voice, follows it until ready, speaks a recording in it, and deletes both", async () => {
    assert.equal(providerStatus().voiceChanger, true);
    const saved = clipMs.CLIP_MS;
    clipMs.CLIP_MS = 0;
    try {
      const sample = await clip("u1", "Sample");
      const voice = await createInstantVoice(instantVoiceSchema.parse({ name: "Narrator", clipId: sample.id, agreed: true }), "u1");
      assert.equal(voice.status, "processing");
      for (const key of ["ownerId", "provider", "providerVoiceId"]) assert.equal(key in publicInstantVoice(voice), false);
      const [listed] = await listInstantVoices("u1");
      assert.equal(listed.status, "completed");
      const take = await clip("u1", "Line 4");
      const change = await startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id, removeNoise: true }), "u1");
      assert.deepEqual([change.status, change.title, change.voiceName, change.removeNoise, change.durationSec], ["completed", "Line 4 in Narrator", "Narrator", true, take.durationSec]);
      assert.match(change.audioUrl ?? "", /\/demo\/revoiced\.mp3$/);
      for (const key of ["ownerId", "provider", "providerVoiceId", "providerAudio"]) assert.equal(key in publicVoiceChange(change), false);
      assert.deepEqual((await listVoiceChanges("u1")).map((c) => c.id), [change.id]);
      assert.deepEqual(await listVoiceChanges("u2"), [], "another account sees none of them");
      await assert.rejects(deleteVoiceChange(change.id, "u2"), NotFoundError);
      await deleteInstantVoice(voice.id, "u1");
      assert.deepEqual(await listInstantVoices("u1"), []);
      assert.equal((await listVoiceChanges("u1")).length, 1, "a recording already spoken stays");
      await deleteVoiceChange(change.id, "u1");
      assert.deepEqual(await listVoiceChanges("u1"), []);
    } finally {
      clipMs.CLIP_MS = saved;
    }
  });

  it("refuses what is not the account's, a voice not ready, a name already used, and past the cap", async () => {
    const theirs = await ready("u2");
    const mine = await clip("u1");
    await assert.rejects(startVoiceChange(voiceChangeSchema.parse({ voiceId: theirs.id, clipId: mine.id }), "u1"), (e: unknown) => e instanceof ValidationError && /no longer available/.test((e as Error).message));
    const theirClip = await clip("u2");
    await assert.rejects(createInstantVoice(instantVoiceSchema.parse({ name: "Copy", clipId: theirClip.id, agreed: true }), "u1"), /audio clip is no longer available/);
    const own = await ready("u1");
    await assert.rejects(startVoiceChange(voiceChangeSchema.parse({ voiceId: own.id, clipId: theirClip.id }), "u1"), /audio clip is no longer available/);
    await assert.rejects(createInstantVoice(instantVoiceSchema.parse({ name: " narrator ", clipId: mine.id, agreed: true }), "u1"), (e: unknown) => e instanceof ConflictError && /already have a voice named/.test((e as Error).message));
    await ready("u2", "Later");
    const making = await createInstantVoice(instantVoiceSchema.parse({ name: "Later", clipId: mine.id, agreed: true }), "u1");
    await assert.rejects(startVoiceChange(voiceChangeSchema.parse({ voiceId: making.id, clipId: mine.id }), "u1"), /still being made/);
    assert.deepEqual(await listVoiceChanges("u1"), [], "nothing is kept for a refused start");
    for (let i = (await listInstantVoices("u1")).length; i < MAX_INSTANT_VOICES; i++) await createInstantVoice(instantVoiceSchema.parse({ name: `V${i}`, clipId: mine.id, agreed: true }), "u1");
    await assert.rejects(createInstantVoice(instantVoiceSchema.parse({ name: "One more", clipId: mine.id, agreed: true }), "u1"), ConflictError);
  });

  it("starts a voice and a recording once for a client key, and says when the key was used for another", async () => {
    const sample = await clip("u1");
    let admitted = 0;
    const admit = () => void admitted++;
    const first = await createInstantVoice(instantVoiceSchema.parse({ name: "Narrator", clipId: sample.id, agreed: true }), "u1", { key: "voice-key-1", admit });
    const again = await createInstantVoice(instantVoiceSchema.parse({ name: "Narrator", clipId: sample.id, agreed: true }), "u1", { key: "voice-key-1", admit });
    assert.deepEqual([again.id, admitted], [first.id, 1]);
    await assert.rejects(createInstantVoice(instantVoiceSchema.parse({ name: "Other", clipId: sample.id, agreed: true }), "u1", { key: "voice-key-1" }), ConflictError);
    const voice = await ready("u1", "Reader");
    const take = await clip("u1");
    const change = await startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id }), "u1", { key: "change-key-1", admit });
    const replay = await startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id }), "u1", { key: "change-key-1", admit });
    assert.deepEqual([replay.id, admitted], [change.id, 2]);
    await assert.rejects(startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id, removeNoise: true }), "u1", { key: "change-key-1" }), ConflictError);
  });

  it("goes with the account, deleted at the renderer, and is exported without the renderer's ids", async () => {
    const voice = await ready("u1");
    const take = await clip("u1");
    await startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id }), "u1");
    const out = (await exportOwnerData("u1")) as unknown as Record<string, Array<Record<string, unknown>>>;
    assert.equal(out.instantvoice.length, 1);
    assert.equal(out.voicechange.length, 1);
    for (const row of [...out.instantvoice, ...out.voicechange]) for (const key of ["provider", "providerVoiceId", "providerAudio"]) assert.equal(key in row, false);
    const proto = MockAvatarProvider.prototype as unknown as { deleteInstantVoice: (id: string) => Promise<void> };
    const real = proto.deleteInstantVoice;
    const deleted: string[] = [];
    proto.deleteInstantVoice = async (id: string) => void deleted.push(id);
    try {
      await deleteOwnerData("u1");
    } finally {
      proto.deleteInstantVoice = real;
    }
    assert.deepEqual(deleted, [voice.providerVoiceId], "the person's voice is deleted at the renderer");
    assert.deepEqual(await getStore().list("instantvoice", "u1"), []);
    assert.deepEqual(await getStore().list("voicechange", "u1"), []);
  });

  it("asks HeyGen for an instant voice and speaks a recording in it, following one not done in time", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; idem: string | null }> = [];
    const realFetch = globalThis.fetch;
    let voiceState = "PENDING";
    let sts: "slow" | "busy" | "done" | "refuse" | "error" = "slow";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, method: init?.method ?? "GET", body, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/assets") return Response.json({ data: { asset_id: "asset_take" } });
      if (url === "https://api.heygen.com/v3/models/audio/voices" && init?.method === "POST") return Response.json({ data: { voice_id: "hv_1" } }, { status: 202 });
      if (url === "https://api.heygen.com/v3/models/audio/voices/hv_1" && !init?.method) return Response.json({ data: { voice_id: "hv_1", status: voiceState, failure_reason: voiceState === "FAILED" ? "PREPROCESSING_FAILED" : null } });
      if (url === "https://api.heygen.com/v3/models/audio/voices/hv_gone") return Response.json({ error: { code: "voice_not_found" } }, { status: 404 });
      if (url === "https://api.heygen.com/v3/models/audio/voices/hv_1" && init?.method === "DELETE") return Response.json({ data: {} });
      if (url === "https://api.heygen.com/v3/models/audio/sts") {
        if (sts === "slow") {
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          throw err;
        }
        if (sts === "busy") return Response.json({ error: { code: "request_in_progress" } }, { status: 409 });
        if (sts === "refuse") return Response.json({ error: { code: "invalid_parameter", message: "audio could not be read", param: "audio" } }, { status: 400 });
        if (sts === "error") return Response.json({ error: { code: "internal_error" } }, { status: 502 });
        return Response.json({ data: { audio_url: "https://files.heygen.ai/generated/out.wav", duration: 1.02 } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const sample = await clip("u1", "Sample");
      const voice = await createInstantVoice(instantVoiceSchema.parse({ name: "Narrator", clipId: sample.id, agreed: true }), "u1", { key: "voice-key-hg" });
      const create = calls.find((c) => c.url.endsWith("/v3/models/audio/voices") && c.method === "POST")!;
      assert.equal(create.idem, voice.id);
      assert.match(String(create.body?.name), /^Narrator ·st_[0-9a-f]{12}$/, "marked, so HeyGen's voice listings never offer it to another account");
      assert.deepEqual({ ...create.body, name: "…" }, { mode: "instant", name: "…", audio: [{ type: "asset_id", asset_id: "asset_take" }], remove_background_noise: true });
      assert.equal((await getStore().list<{ voiceId: string }>("madevoice")).some((m) => m.voiceId === "hv_1"), true);
      // A start whose answer was lost, retried with the same key, sends the same request, so HeyGen replays its answer.
      await getStore().remove("instantvoice", voice.id);
      await createInstantVoice(instantVoiceSchema.parse({ name: "Narrator", clipId: sample.id, agreed: true }), "u1", { key: "voice-key-hg" });
      const creates = calls.filter((c) => c.url.endsWith("/v3/models/audio/voices") && c.method === "POST");
      assert.deepEqual(creates.map((c) => [c.body?.name, c.idem]), [[create.body?.name, voice.id], [create.body?.name, voice.id]]);
      assert.equal((await listInstantVoices("u1"))[0].status, "processing");
      voiceState = "ACTIVE";
      forgetVoiceChangerChecks();
      assert.equal((await listInstantVoices("u1"))[0].status, "completed");
      // A conversion not done in time is kept running and asked for again with the same key.
      const take = await clip("u1", "Line 4");
      const change = await startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id }), "u1");
      assert.equal(change.status, "processing");
      const first = calls.filter((c) => c.url.endsWith("/sts"));
      assert.deepEqual(first.at(-1)!.body, { voice_id: "hv_1", audio: { type: "asset_id", asset_id: "asset_take" } });
      assert.equal(first.at(-1)!.idem, change.id);
      sts = "busy";
      forgetVoiceChangerChecks();
      assert.equal((await listVoiceChanges("u1"))[0].status, "processing", "still running at HeyGen");
      sts = "done";
      forgetVoiceChangerChecks();
      const [done] = await listVoiceChanges("u1");
      assert.deepEqual([done.status, done.audioUrl, done.durationSec], ["completed", "https://files.heygen.ai/generated/out.wav", 1.02]);
      assert.deepEqual(new Set(calls.filter((c) => c.url.endsWith("/sts")).map((c) => c.idem)), new Set([change.id]), "every ask used the same key, so it was paid for once");
      const asked = calls.length;
      forgetVoiceChangerChecks();
      await listVoiceChanges("u1");
      assert.equal(calls.length, asked, "a finished one is never asked again");
      // A server error or a dropped connection may still be running: kept and followed with the same key.
      sts = "error";
      const failedStart = await startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id, removeNoise: true }), "u1");
      assert.equal(failedStart.status, "processing");
      assert.deepEqual(calls.filter((c) => c.url.endsWith("/sts")).at(-1)!.body, { voice_id: "hv_1", audio: { type: "asset_id", asset_id: "asset_take" }, remove_background_noise: true });
      // Long unanswered (the page was closed), it is still asked once under its key, and HeyGen's finished answer kept.
      await getStore().put<VoiceChange>("voicechange", { ...(await getStore().get<VoiceChange>("voicechange", failedStart.id))!, createdAt: new Date(Date.now() - 40 * 60 * 1000).toISOString() });
      sts = "done";
      forgetVoiceChangerChecks();
      const late = (await listVoiceChanges("u1")).find((c) => c.id === failedStart.id)!;
      assert.equal(late.status, "completed");
      assert.deepEqual(calls.filter((c) => c.url.endsWith("/sts")).at(-1)!.body, { voice_id: "hv_1", audio: { type: "asset_id", asset_id: "asset_take" }, remove_background_noise: true }, "the same body as the start, so not paid twice");
      await deleteVoiceChange(failedStart.id, "u1");
      // A recording HeyGen refuses is a 400 with its reason, and nothing is kept.
      sts = "refuse";
      await assert.rejects(startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id }), "u1"), (e: unknown) => e instanceof ValidationError && /audio could not be read/.test((e as Error).message));
      assert.equal((await listVoiceChanges("u1")).length, 1);
      // A voice HeyGen could not make says why; one it no longer has has failed.
      voiceState = "FAILED";
      await getStore().put("instantvoice", { ...(await getStore().get<InstantVoice>("instantvoice", voice.id))!, status: "processing" });
      forgetVoiceChangerChecks();
      assert.match((await listInstantVoices("u1"))[0].error ?? "", /did not pass HeyGen's checks/);
      await getStore().put<InstantVoice>("instantvoice", { ...voice, id: "iv_gone", providerVoiceId: "hv_gone", status: "processing", createdAt: new Date(0).toISOString() });
      forgetVoiceChangerChecks();
      assert.match((await listInstantVoices("u1")).find((v) => v.id === "iv_gone")!.error ?? "", /no longer has this voice/);
      await deleteInstantVoice(voice.id, "u1");
      assert.equal(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v3/models/audio/voices/hv_1")), true);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("gives up on a conversion still running after half an hour, and never asks once the renderer's key has expired", async () => {
    const voice = await ready("u1");
    const take = await clip("u1");
    const change = await startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id }), "u1");
    const proto = MockAvatarProvider.prototype as unknown as { changeVoice: (...a: unknown[]) => Promise<unknown> };
    const real = proto.changeVoice;
    let asked = 0;
    proto.changeVoice = async () => (asked++, { status: "processing" });
    try {
      await getStore().put<VoiceChange>("voicechange", { ...change, status: "processing", audioUrl: undefined, createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() });
      const [old] = await listVoiceChanges("u1");
      assert.deepEqual([old.status, old.error, asked], ["failed", "The renderer did not finish speaking this recording; try again", 1]);
      await getStore().put<VoiceChange>("voicechange", { ...change, status: "processing", audioUrl: undefined, createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
      forgetVoiceChangerChecks();
      assert.equal((await listVoiceChanges("u1"))[0].status, "failed");
      assert.equal(asked, 1, "a day old, it would be spoken and paid for again, so it is not asked");
    } finally {
      proto.changeVoice = real;
    }
  });

  it("keeps the account when the renderer would not delete one of its voices", async () => {
    const voice = await ready("u1");
    const proto = MockAvatarProvider.prototype as unknown as { deleteInstantVoice: (id: string) => Promise<void> };
    const real = proto.deleteInstantVoice;
    proto.deleteInstantVoice = async () => {
      throw new Error("HeyGen DELETE failed: 500 {}");
    };
    try {
      await assert.rejects(deleteOwnerData("u1"), (e: unknown) => e instanceof ConflictError && /would not delete the voice "Narrator"/.test((e as Error).message));
      await assert.rejects(deleteInstantVoice(voice.id, "u1"), ConflictError);
    } finally {
      proto.deleteInstantVoice = real;
    }
    assert.equal((await listInstantVoices("u1")).length, 1, "the voice is kept to try again");
    assert.equal((await getStore().list("clip", "u1")).length, 1, "and so is the rest of the account");
  });
});
