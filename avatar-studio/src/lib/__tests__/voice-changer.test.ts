// The voice changer: instant voices made from one of the account's audio clips with the speaker's agreement, and
// recordings and text spoken in one of them; each account's own, retried by key, followed while the renderer works, deleted
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
  startVoiceSpeech,
  voiceChangeSchema,
  voiceSpeechSchema,
} from "../services";
import { ConflictError, NotFoundError, UpstreamError, ValidationError } from "../errors";
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
    // One that failed is never offered, so its name may be used again.
    await getStore().put<InstantVoice>("instantvoice", { ...(await getStore().get<InstantVoice>("instantvoice", own.id))!, status: "failed" });
    assert.equal((await createInstantVoice(instantVoiceSchema.parse({ name: "Narrator", clipId: mine.id, agreed: true }), "u1")).name, "Narrator");
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

  it("makes a voice set in a picture of the speaker's setting, sent to HeyGen inline and kept by name", async () => {
    const { createBackdrop } = await import("../services");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const street = await createBackdrop({ name: "Busy street", image: `data:image/png;base64,${Buffer.from(png).toString("base64")}` }, "u1");
    const theirs = await createBackdrop({ name: "Their room", image: `data:image/png;base64,${Buffer.from(png).toString("base64")}` }, "u2");
    assert.throws(() => instantVoiceSchema.parse({ name: "N", clipId: "clip_1", agreed: true, settingPictureId: "not-a-picture" }), /Choose one of your pictures/);
    // The demo renderer keeps the setting with the voice too.
    const sample = await clip("u1", "Sample");
    const demo = await createInstantVoice(instantVoiceSchema.parse({ name: "Street", clipId: sample.id, agreed: true, settingPictureId: street.id }), "u1", { key: "voice-set" });
    assert.deepEqual([demo.settingPictureId, demo.settingPictureName], [street.id, "Busy street"]);
    assert.equal(publicInstantVoice(demo).settingPictureName, "Busy street");
    // The same key with another setting is another voice.
    await assert.rejects(createInstantVoice(instantVoiceSchema.parse({ name: "Street", clipId: sample.id, agreed: true }), "u1", { key: "voice-set" }), ConflictError);
    // Another account's picture, or one deleted since, is refused by name, before anything is asked of the renderer.
    await assert.rejects(createInstantVoice(instantVoiceSchema.parse({ name: "Room", clipId: sample.id, agreed: true, settingPictureId: theirs.id }), "u1"), /picture is no longer available/);

    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const realFetch = globalThis.fetch;
    let refuse = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url === "https://api.heygen.com/v3/assets") return Response.json({ data: { asset_id: "asset_take" } });
      if (url === "https://api.heygen.com/v3/models/audio/voices" && init?.method === "POST") {
        if (refuse) return Response.json({ error: { code: "invalid_parameter", message: "image could not be read", param: "image" } }, { status: 400 });
        return Response.json({ data: { voice_id: "hv_set" } }, { status: 202 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const voice = await createInstantVoice(instantVoiceSchema.parse({ name: "On the street", clipId: sample.id, agreed: true, settingPictureId: street.id }), "u1");
      const create = calls.find((c) => c.url.endsWith("/v3/models/audio/voices") && c.method === "POST")!;
      assert.deepEqual(create.body?.image, { type: "base64", media_type: "image/png", data: Buffer.from(png).toString("base64") });
      assert.equal("gender" in create.body! || "age" in create.body!, false, "HeyGen refuses gender or age with a picture");
      assert.equal(voice.settingPictureName, "Busy street");
      // Without a picture, none is sent.
      await createInstantVoice(instantVoiceSchema.parse({ name: "Plain", clipId: sample.id, agreed: true }), "u1");
      assert.equal("image" in calls.filter((c) => c.url.endsWith("/v3/models/audio/voices") && c.method === "POST").at(-1)!.body!, false);
      // A refusal names the picture as something to change.
      refuse = true;
      await assert.rejects(createInstantVoice(instantVoiceSchema.parse({ name: "Refused", clipId: sample.id, agreed: true, settingPictureId: street.id }), "u1"), /could not make a voice from that recording and picture: image could not be read/);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
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

  it("speaks text in one of the account's voices, once for a client key, kept with its recordings", async () => {
    assert.throws(() => voiceSpeechSchema.parse({ voiceId: "iv_x", text: "   " }), /Write the text/);
    assert.throws(() => voiceSpeechSchema.parse({ voiceId: "iv_x", text: "x".repeat(2001) }), /2,000 characters/);
    const voice = await ready("u1");
    let admitted = 0;
    const admit = () => void admitted++;
    const text = "Welcome to the team. Here is what your first week looks like, day by day.";
    const spoken = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text }), "u1", { key: "speech-key-1", admit });
    assert.deepEqual([spoken.status, spoken.title, spoken.text, spoken.clipId, spoken.voiceName], ["completed", "Welcome to the team. Here is what your… in Narrator", text, undefined, "Narrator"]);
    assert.match(spoken.audioUrl ?? "", /\/demo\/revoiced\.mp3$/);
    assert.equal(spoken.durationSec, 6, "the demo's length is the text's at about two and a half words a second");
    for (const key of ["ownerId", "provider", "providerVoiceId", "providerAudio"]) assert.equal(key in publicVoiceChange(spoken), false);
    const again = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text }), "u1", { key: "speech-key-1", admit });
    assert.deepEqual([again.id, admitted], [spoken.id, 1]);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Other words" }), "u1", { key: "speech-key-1" }), ConflictError);
    // A key used for text is not a recording's, nor the other way round.
    const take = await clip("u1");
    await assert.rejects(startVoiceChange(voiceChangeSchema.parse({ voiceId: voice.id, clipId: take.id }), "u1", { key: "speech-key-1" }), ConflictError);
    assert.deepEqual((await listVoiceChanges("u1")).map((c) => c.id), [spoken.id]);
    // Refused like a recording: another account's voice, one not ready, a short title kept as given.
    const theirs = await ready("u2", "Theirs");
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: theirs.id, text }), "u1"), /no longer available/);
    const titled = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Hi.", title: "Greeting" }), "u1");
    assert.equal(titled.title, "Greeting");
    // A title is cut at a word, by characters as a reader counts them, and punctuation alone is kept.
    const long = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: `${"👋🏽".repeat(39)} hi there` }), "u1");
    assert.equal(long.title, `${"👋🏽".repeat(39)}… in Narrator`);
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Hi there!" }), "u1")).title, "Hi there in Narrator", "a whole text loses its closing punctuation");
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: 'Say "wait…"' }), "u1")).title, "Say \"wait in Narrator", "an ellipsis or closing quote too, so it is not taken for a cut");
    const dashes = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "-".repeat(50) }), "u1");
    assert.equal(dashes.title, `${"-".repeat(40)}… in Narrator`);
    const out = (await exportOwnerData("u1")) as unknown as Record<string, Array<Record<string, unknown>>>;
    assert.deepEqual(out.voicechange.map((c) => c.text).sort(), ["-".repeat(50), "Hi there!", "Hi.", 'Say "wait…"', text, `${"👋🏽".repeat(39)} hi there`].sort());
  });

  it("takes how the text is delivered: Turbo and an expressiveness boost, kept with the recording", async () => {
    const parse = (extra: Record<string, unknown>) => voiceSpeechSchema.parse({ voiceId: "iv_x", text: "Hi.", ...extra });
    assert.deepEqual([parse({ turbo: true }).turbo, parse({ turbo: false }).turbo], [true, undefined], "the standard model is stored as absent");
    assert.deepEqual([parse({ expressivenessBoost: 0.4 }).expressivenessBoost, parse({ expressivenessBoost: 0 }).expressivenessBoost, parse({ expressivenessBoost: 0.7 }).expressivenessBoost, parse({ expressivenessBoost: 1 }).expressivenessBoost], [0.4, 0, 0.7, undefined], "in tenths; HeyGen's default of 1 is stored as absent, and 0 is kept");
    for (const fine of [0.04, 0.33, 0.96]) assert.throws(() => parse({ expressivenessBoost: fine }), /steps of 0\.1/, "a finer value is refused, not rounded to another delivery");
    for (const bad of [-0.1, 1.1, "0.5", Number.NaN]) assert.throws(() => parse({ expressivenessBoost: bad }), /expressivenessBoost is a number from 0 to 1/);
    assert.throws(() => parse({ turbo: "yes" }), /turbo is true or false/);
    const voice = await ready("u1");
    const lively = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big news today.", turbo: true, expressivenessBoost: 0.6 }), "u1", { key: "speech-delivery" });
    assert.deepEqual([lively.turbo, lively.expressivenessBoost], [true, 0.6]);
    assert.deepEqual([publicVoiceChange(lively).turbo, publicVoiceChange(lively).expressivenessBoost], [true, 0.6]);
    const plain = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big news today." }), "u1");
    assert.deepEqual(["turbo" in plain, "expressivenessBoost" in plain], [false, false]);
    // The same key with another delivery is another recording, refused rather than answered with the first.
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big news today.", turbo: true }), "u1", { key: "speech-delivery" }), ConflictError);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big news today.", expressivenessBoost: 0.6 }), "u1", { key: "speech-delivery" }), ConflictError);
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big news today.", turbo: true, expressivenessBoost: 0.6 }), "u1", { key: "speech-delivery" })).id, lively.id);
    // A recording kept from before these options replays for a retry that spells out the defaults.
    const before = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Older words." }), "u1", { key: "speech-before" });
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Older words.", turbo: false, expressivenessBoost: 1 }), "u1", { key: "speech-before" })).id, before.id);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Older words.", expressivenessBoost: 0 }), "u1", { key: "speech-before" }), ConflictError, "no boost is not HeyGen's default");
    // A recording an earlier version stored with a boost of 1 replays for a retry at HeyGen's default.
    const full = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Full words." }), "u1", { key: "speech-full" });
    await getStore().put("voicechange", { ...full, expressivenessBoost: 1 });
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Full words.", expressivenessBoost: 1 }), "u1", { key: "speech-full" })).id, full.id);
    const calm = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Calm words.", expressivenessBoost: 0 }), "u1");
    assert.equal(calm.expressivenessBoost, 0, "no boost at all is kept, as HeyGen would otherwise apply its full one");
  });

  it("asks HeyGen to speak text in an instant voice once, dropping one not done in time and telling a refusal apart", async () => {
    // A voice made beforehand, as HeyGen holds it.
    const voice: InstantVoice = { ...(await ready("u1")), status: "completed", provider: "heygen", providerVoiceId: "hv_1" };
    await getStore().put<InstantVoice>("instantvoice", voice);
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; body: Record<string, unknown> | null; idem: string | null }> = [];
    const realFetch = globalThis.fetch;
    let tts: "slow" | "done" | "refuse" = "slow";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, body, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/models/audio/tts") {
        if (tts === "slow") {
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          throw err;
        }
        if (tts === "refuse") return Response.json({ error: { code: "invalid_parameter", message: "text language is not supported", param: "text" } }, { status: 400 });
        return Response.json({ data: { audio_url: "https://files.heygen.ai/generated/speech.wav", duration: 3.4 } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      // Not done in time: dropped with a 502 to try again, never asked for again (HeyGen documents no replay for text).
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Hello there." }), "u1", { key: "speech-hg-1" }), (e: unknown) => e instanceof UpstreamError && /did not finish speaking the text in time/.test((e as Error).message));
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1", voice_id: "hv_1", text: "Hello there." });
      const key = calls.at(-1)!.idem!;
      assert.match(key, /^vc_/);
      assert.deepEqual(await listVoiceChanges("u1"), []);
      // Tried again with the same client key, the same request goes with the same key.
      tts = "done";
      const done = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Hello there." }), "u1", { key: "speech-hg-1" });
      assert.deepEqual([done.status, done.audioUrl, done.durationSec, calls.at(-1)!.idem], ["completed", "https://files.heygen.ai/generated/speech.wav", 3.4, key]);
      const asked = calls.length;
      forgetVoiceChangerChecks();
      await listVoiceChanges("u1");
      assert.equal(calls.length, asked, "a finished one is never asked again");
      tts = "refuse";
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Bonjour." }), "u1"), (e: unknown) => e instanceof ValidationError && /could not speak that text: text language is not supported/.test((e as Error).message));
      assert.equal((await listVoiceChanges("u1")).length, 1, "nothing is kept for a refused text");
      // Turbo and the boost reach HeyGen as its model and expressiveness_boost.
      tts = "done";
      await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big news.", turbo: true, expressivenessBoost: 0.3 }), "u1");
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1-turbo", voice_id: "hv_1", text: "Big news.", expressiveness_boost: 0.3 });
      // HeyGen's default is its full boost: 1 sends nothing, and 0 is sent rather than left to that default.
      await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big news.", expressivenessBoost: 1 }), "u1");
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1", voice_id: "hv_1", text: "Big news." });
      await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Calm news.", expressivenessBoost: 0 }), "u1");
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1", voice_id: "hv_1", text: "Calm news.", expressiveness_boost: 0 });
      // One left as being spoken (its request was cut off) is waited for while its start could still answer, then given
      // up, and never asked for.
      const cut: VoiceChange = { ...done, id: "vc_cut", status: "processing", audioUrl: undefined, createdAt: new Date(Date.now() - 30_000).toISOString() };
      await getStore().put<VoiceChange>("voicechange", cut);
      const before = calls.length;
      forgetVoiceChangerChecks();
      assert.equal((await listVoiceChanges("u1")).find((c) => c.id === cut.id)!.status, "processing");
      await getStore().put<VoiceChange>("voicechange", { ...cut, createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() });
      forgetVoiceChangerChecks();
      assert.equal((await listVoiceChanges("u1")).find((c) => c.id === cut.id)!.error, "The renderer did not finish speaking this text; try again");
      assert.equal(calls.length, before, "text is never asked for again");
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
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
