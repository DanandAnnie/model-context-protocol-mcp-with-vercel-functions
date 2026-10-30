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
  deleteClip,
  deleteVoiceChange,
  exportOwnerData,
  forgetVoiceChangerChecks,
  instantVoicePreview,
  keepVoiceChangeAsClip,
  instantVoiceSchema,
  listPublicVoices,
  listInstantVoices,
  listVoiceChanges,
  publicInstantVoice,
  publicVoiceChange,
  voiceChangeCaptions,
  startVoiceChange,
  startVoiceSpeech,
  voiceChangeSchema,
  voiceSpeechSchema,
} from "../services";
import { ConflictError, LimitError, NotFoundError, UpstreamError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { getStore } from "../store";
import type { InstantVoice, VoiceChange, VoiceChangeWords } from "../types";

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

  it("lets a voice be heard before it is used: a fresh preview link once it is ready, only for its account", async () => {
    const sample = await clip("u1", "Sample");
    const making = await createInstantVoice(instantVoiceSchema.parse({ name: "Narrator", clipId: sample.id, agreed: true }), "u1");
    await assert.rejects(instantVoicePreview(making.id, "u1"), (e: unknown) => e instanceof ValidationError && /"Narrator" is still being made/.test((e as Error).message));
    const voice = await ready("u1", "Host");
    assert.match(await instantVoicePreview(voice.id, "u1"), /\/demo\/revoiced\.mp3$/);
    await assert.rejects(instantVoicePreview(voice.id, "u2"), NotFoundError, "another account's reads as not found");
    await assert.rejects(instantVoicePreview("iv_nope", "u1"), NotFoundError);
    await getStore().put<InstantVoice>("instantvoice", { ...(await getStore().get<InstantVoice>("instantvoice", voice.id))!, status: "failed" });
    await assert.rejects(instantVoicePreview(voice.id, "u1"), /could not be made, so it has no preview/);
  });

  it("reads HeyGen's preview of an active voice each time, never a plain-http link, and says when HeyGen has none", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const realFetch = globalThis.fetch;
    let answer: Record<string, unknown> = { voice_id: "hv_p", status: "ACTIVE", preview_audio_url: "https://files.heygen.ai/previews/hv_p.wav?sig=1" };
    let reads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.heygen.com/v3/models/audio/voices/hv_p" && !init?.method) {
        reads++;
        return Response.json({ data: answer });
      }
      if (url === "https://api.heygen.com/v3/models/audio/voices/hv_gone") return Response.json({ error: { code: "voice_not_found" } }, { status: 404 });
      if (url === "https://api.heygen.com/v3/models/audio/voices/hv_down") return Response.json({ error: { code: "internal_error", message: "hv_down unavailable" } }, { status: 503 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const now = new Date().toISOString();
      const voice: InstantVoice = { id: "iv_heygen_preview", ownerId: "u1", name: "Host", clipId: "clip_x", provider: "heygen", providerVoiceId: "hv_p", status: "completed", createdAt: now, updatedAt: now };
      await getStore().put("instantvoice", voice);
      assert.equal(await instantVoicePreview(voice.id, "u1"), "https://files.heygen.ai/previews/hv_p.wav?sig=1");
      answer = { ...answer, preview_audio_url: "https://files.heygen.ai/previews/hv_p.wav?sig=2" };
      assert.equal(await instantVoicePreview(voice.id, "u1"), "https://files.heygen.ai/previews/hv_p.wav?sig=2", "the link expires, so it is read again");
      assert.equal(reads, 2);
      for (const missing of [{ preview_audio_url: null }, { preview_audio_url: "http://files.heygen.ai/p.wav" }, { status: "PENDING" }]) {
        answer = { voice_id: "hv_p", status: "ACTIVE", preview_audio_url: "https://files.heygen.ai/p.wav", ...missing };
        await assert.rejects(instantVoicePreview(voice.id, "u1"), /There is no preview of "Host" yet/, JSON.stringify(missing));
      }
      // HeyGen down: a message to try again, never HeyGen's own error, which names the voice there.
      await getStore().put("instantvoice", { ...voice, providerVoiceId: "hv_down" });
      await assert.rejects(instantVoicePreview(voice.id, "u1"), (e: unknown) => e instanceof UpstreamError && /try listening again/.test((e as Error).message) && !/hv_/.test((e as Error).message));
      assert.equal((await getStore().get<InstantVoice>("instantvoice", voice.id))!.status, "completed", "and the voice is kept as it was");
      // A voice HeyGen failed or no longer has will not come back: it is marked failed, with why, so it is not offered again.
      answer = { voice_id: "hv_p", status: "FAILED", failure_reason: "PREPROCESSING_FAILED" };
      await getStore().put("instantvoice", voice);
      await assert.rejects(instantVoicePreview(voice.id, "u1"), /The voice "Host" can no longer be used/);
      assert.equal((await getStore().get<InstantVoice>("instantvoice", voice.id))!.status, "failed");
      await getStore().put("instantvoice", { ...voice, providerVoiceId: "hv_gone" });
      await assert.rejects(instantVoicePreview(voice.id, "u1"), /can no longer be used: HeyGen no longer has this voice; make it again/);
      assert.deepEqual([(await getStore().get<InstantVoice>("instantvoice", voice.id))!.status, (await getStore().get<InstantVoice>("instantvoice", voice.id))!.error], ["failed", "HeyGen no longer has this voice; make it again"]);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("speaks text in one of HeyGen's public voices, with Turbo and the boost only for an instant one", async () => {
    const offered = await listPublicVoices();
    assert.deepEqual(offered.map((v) => [v.id, v.name, v.mode]), [["pv_mockpv_atlas", "Atlas", "instant"], ["pv_mockpv_nadine", "Nadine", "professional"]], "by name, with the studio's ids");
    const nadine = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_nadine", text: "Welcome aboard." }), "u1");
    assert.deepEqual([nadine.status, nadine.voiceId, nadine.voiceName, nadine.title], ["completed", "pv_mockpv_nadine", "Nadine", "Welcome aboard in Nadine"]);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_nadine", text: "Welcome aboard.", turbo: true }), "u1"), /for instant voices, and Nadine is not one/);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_nadine", text: "Welcome aboard.", expressivenessBoost: 0.5 }), "u1"), /for instant voices/);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_nadine", text: "Welcome aboard.", free: true }), "u1"), /Turbo \(free or not\)/);
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_nadine", text: "Welcome aboard.", format: "mp3" }), "u1")).format, "mp3", "any voice speaks into an MP3");
    const atlas = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_atlas", text: "Welcome aboard.", turbo: true, expressivenessBoost: 0.5 }), "u1");
    assert.deepEqual([atlas.turbo, atlas.expressivenessBoost], [true, 0.5]);
    const atlasFree = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_atlas", text: "Welcome aboard.", free: true }), "u1");
    assert.deepEqual([atlasFree.turbo, atlasFree.free], [true, true], "a public instant voice speaks free too");
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_gone", text: "Hi." }), "u1"), /no longer offered/);
    assert.throws(() => voiceSpeechSchema.parse({ voiceId: "hv_1", text: "Hi." }), /one of HeyGen's/);
    // Retried with the same key, the same voice returns the same recording; another voice is another recording.
    const keyed = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_nadine", text: "Again." }), "u1", { key: "public-voice-key" });
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_nadine", text: "Again." }), "u1", { key: "public-voice-key" })).id, keyed.id);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_atlas", text: "Again." }), "u1", { key: "public-voice-key" }), ConflictError);
  });

  it("lists HeyGen's public voices page by page, ready ones only, and speaks text in one by HeyGen's id", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    let down = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (url.startsWith("https://api.heygen.com/v3/models/audio/voices?type=public")) {
        if (down) return Response.json({ error: { code: "internal_error", message: "boom" } }, { status: 502 });
        if (!url.includes("token=")) {
          return Response.json({ data: [{ voice_id: "pub_nadine", name: "Nadine", mode: "professional", status: "ACTIVE", language: "English", preview_audio_url: "https://files.heygen.ai/p/nadine.wav" }, { voice_id: "pub_new", name: "Draft", mode: "instant", status: "PENDING" }], has_more: true, next_token: "t2" });
        }
        return Response.json({ data: [{ voice_id: "pub_ama", name: "Ama", mode: "instant", status: "ACTIVE", language: null, preview_audio_url: "http://files.heygen.ai/p/ama.wav" }, { voice_id: "pub/odd", name: "Odd", mode: "instant", status: "ACTIVE" }], has_more: false, next_token: null });
      }
      if (url === "https://api.heygen.com/v3/models/audio/tts") {
        if (calls.at(-1)!.body?.voice_id === "pub_ama") return Response.json({ error: { code: "voice_not_found", message: "no such voice" } }, { status: 404 });
        return Response.json({ data: { audio_url: "https://files.heygen.ai/generated/tts.wav", duration: 1.5 } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const voices = await listPublicVoices();
      assert.deepEqual(voices, [
        { id: "pv_pub_ama", name: "Ama", mode: "instant" },
        { id: "pv_pub_nadine", name: "Nadine", language: "English", mode: "professional", previewUrl: "https://files.heygen.ai/p/nadine.wav" },
      ], "every page, ready voices only, no id the studio cannot carry, and no plain-http sample");
      assert.deepEqual(calls.map((c) => c.url), ["https://api.heygen.com/v3/models/audio/voices?type=public&limit=100", "https://api.heygen.com/v3/models/audio/voices?type=public&limit=100&token=t2"]);
      await listPublicVoices();
      assert.equal(calls.length, 2, "kept for a few minutes");
      const spoken = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_pub_nadine", text: "Hello there." }), "u1");
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1", voice_id: "pub_nadine", text: "Hello there.", with_timestamps: true });
      assert.equal(spoken.audioUrl, "https://files.heygen.ai/generated/tts.wav");
      // A public voice HeyGen no longer has is chosen again, not made again, and the list is read afresh.
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_pub_ama", text: "Hello there." }), "u1"), /That HeyGen voice is no longer offered; choose another/);
      const before = calls.length;
      await listPublicVoices();
      assert.equal(calls.length, before + 2, "read again");
      forgetVoiceChangerChecks();
      down = true;
      await assert.rejects(listPublicVoices(), (e: unknown) => e instanceof UpstreamError && /could not be listed just now/.test((e as Error).message));
      // A failure is not kept: the next request asks again and gets the list; requests at once share one read.
      down = false;
      const reads = calls.length;
      const [a, b] = await Promise.all([listPublicVoices(), listPublicVoices()]);
      assert.deepEqual(a.map((v) => v.id), ["pv_pub_ama", "pv_pub_nadine"]);
      assert.equal(a, b);
      assert.equal(calls.length, reads + 2, "one read of two pages for both");
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
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
    // A spoken text's word times go with it, and are not in the export (like clip audio).
    const said = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Goodbye now." }), "u1");
    assert.equal(said.timed, true);
    const out = (await exportOwnerData("u1")) as unknown as Record<string, Array<Record<string, unknown>>>;
    assert.equal(out.instantvoice.length, 1);
    assert.equal(out.voicechange.length, 2);
    assert.equal("voicewords" in out, false);
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
    assert.equal(await getStore().get("voicewords", `voicewords_${said.id}`), null);
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
    // Free is Turbo at no charge: it turns Turbo on, is stored as absent when false, and contradicts Turbo off.
    assert.deepEqual([parse({ free: true }).turbo, parse({ free: true }).free, parse({ turbo: true, free: true }).free, parse({ turbo: true, free: false }).free], [true, true, true, undefined]);
    assert.throws(() => parse({ turbo: false, free: true }), /free is Turbo at no charge/);
    assert.throws(() => parse({ free: "yes" }), /free is true or false/);
    // The file: an MP3 when asked for; HeyGen's WAV is the default, stored as absent.
    assert.deepEqual([parse({ format: "mp3" }).format, parse({ format: "wav" }).format, parse({}).format], ["mp3", undefined, undefined]);
    assert.throws(() => parse({ format: "ogg" }), /format is wav or mp3/);
    // The text's language: a name or code, kept as given; blank lets HeyGen detect it; one naming no language is refused.
    assert.deepEqual([parse({ language: " French " }).language, parse({ language: "es-MX" }).language, parse({ language: "" }).language, parse({ language: null }).language], ["French", "es-MX", undefined, undefined]);
    for (const bad of ["Klingon", "sic", 7, "und", "mul", "zxx", "qaa"]) assert.throws(() => parse({ language: bad }), /Name the text's language|language is a language name or code/, String(bad));
    const voice = await ready("u1");
    const freebie = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Free words.", free: true }), "u1", { key: "speech-free" });
    assert.deepEqual([freebie.turbo, freebie.free, publicVoiceChange(freebie).free], [true, true, true]);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Free words.", turbo: true }), "u1", { key: "speech-free" }), ConflictError, "paid Turbo is another delivery");
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Free words.", turbo: true, free: true }), "u1", { key: "speech-free" })).id, freebie.id);
    // An MP3 is kept with the recording and is part of what a repeated key must match; WAV spelled out is the default.
    const small = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Small file.", format: "mp3" }), "u1", { key: "speech-mp3" });
    assert.deepEqual([small.format, publicVoiceChange(small).format], ["mp3", "mp3"]);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Small file." }), "u1", { key: "speech-mp3" }), ConflictError);
    // The language is part of what a repeated key must match, by language rather than spelling.
    const inFrench = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Salut.", language: "French" }), "u1", { key: "speech-fr" });
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Salut.", language: "fr" }), "u1", { key: "speech-fr" })).id, inFrench.id);
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Salut." }), "u1", { key: "speech-fr" }), ConflictError);
    const wav = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big file." }), "u1", { key: "speech-wav" });
    assert.equal("format" in wav, false);
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big file.", format: "wav" }), "u1", { key: "speech-wav" })).id, wav.id);
    // A Turbo recording kept from before Free existed replays for a retry with Turbo (and Free left out or false).
    const oldTurbo = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Old turbo.", turbo: true }), "u1", { key: "speech-old-turbo" });
    assert.equal("free" in oldTurbo, false);
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Old turbo.", turbo: true, free: false }), "u1", { key: "speech-old-turbo" })).id, oldTurbo.id);
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
    let tts: "slow" | "done" | "refuse" | "busy" | "down" | "noMp3" | "noLanguage" = "slow";
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
        if (tts === "busy") return Response.json({ error: { code: "rate_limit_exceeded", message: "free capacity exhausted" } }, { status: 429 });
        if (tts === "down") return Response.json({ error: { code: "internal_error", message: "service failure" } }, { status: 500 });
        if (tts === "noLanguage") return Response.json({ error: { code: "invalid_parameter", message: "language is not supported by HeyGen Voice", param: "language" } }, { status: 400 });
        if (tts === "noMp3") return Response.json({ error: { code: "invalid_parameter", message: "output_format is not supported with with_timestamps", param: "output_format" } }, { status: 400 });
        const words = [{ text: "Hi", start_time: 0, end_time: 0.3 }, { text: "there.", start_time: 0.3, end_time: 0.9 }, { text: "", start_time: 1, end_time: 1.1 }, { text: "Bye.", start_time: 1.6, end_time: 2 }, { text: "late", start_time: 2.5, end_time: "x" }];
        const characters = [..."Hi yo"].map((c, i) => ({ text: c, start_time: i / 10, end_time: (i + 1) / 10 }));
        // HeyGen names the language it spoke in: the one asked for, else the one it detected (here, English).
        const spoken = contentLanguage ?? (typeof body?.language === "string" ? `${body.language}, en` : "en-US");
        return Response.json({ data: { audio_url: "https://files.heygen.ai/generated/speech.wav", duration: 3.4, ...(timings === "words" ? { original_words: words, original_characters: characters } : timings === "characters" ? { original_characters: characters } : {}) } }, { headers: { "Content-Language": spoken } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    let timings: "words" | "characters" | "none" = "none";
    let contentLanguage: string | undefined;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      // Not done in time: dropped with a 502 to try again, never asked for again (HeyGen documents no replay for text).
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Hello there." }), "u1", { key: "speech-hg-1" }), (e: unknown) => e instanceof UpstreamError && /did not finish speaking the text in time/.test((e as Error).message));
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1", voice_id: "hv_1", text: "Hello there.", with_timestamps: true });
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
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1-turbo", voice_id: "hv_1", text: "Big news.", expressiveness_boost: 0.3, with_timestamps: true });
      // HeyGen's default is its full boost: 1 sends nothing, and 0 is sent rather than left to that default.
      await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Big news.", expressivenessBoost: 1 }), "u1");
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1", voice_id: "hv_1", text: "Big news.", with_timestamps: true });
      await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Calm news.", expressivenessBoost: 0 }), "u1");
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1", voice_id: "hv_1", text: "Calm news.", expressiveness_boost: 0, with_timestamps: true });
      // The text's language reaches HeyGen as its base code; the language HeyGen spoke in is kept from Content-Language,
      // and one that is no language tag is not.
      const french = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Bonjour.", language: "French (Canada)" }), "u1");
      assert.equal(calls.at(-1)!.body?.language, "fr");
      assert.deepEqual([french.language, french.spokenLanguage], ["French (Canada)", "fr"]);
      const detected = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Hello." }), "u1");
      assert.equal("language" in calls.at(-1)!.body!, false, "none named lets HeyGen detect it");
      assert.deepEqual([detected.language, detected.spokenLanguage], [undefined, "en-us"]);
      for (const odd of ["<script>", "und", "zxx-Latn"]) {
        contentLanguage = odd;
        assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Hi." }), "u1")).spokenLanguage, undefined, odd);
      }
      contentLanguage = undefined;
      // HeyGen refusing the language named is said as the language's; nothing is kept.
      tts = "noLanguage";
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Salve.", language: "la" }), "u1"), /does not speak that language; choose another/);
      tts = "done";
      // An MP3 reaches HeyGen as its output_format, at its defaults for MP3.
      await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Small news.", format: "mp3" }), "u1");
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1", voice_id: "hv_1", text: "Small news.", output_format: { encoding: "mp3" }, with_timestamps: true });
      await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Small free news.", free: true, format: "mp3" }), "u1");
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1-turbo-free", voice_id: "hv_1", text: "Small free news.", output_format: { encoding: "mp3" }, with_timestamps: true });
      // HeyGen refusing the MP3 (or its timings) is said as the MP3's, with WAV to choose instead; a WAV is unaffected.
      tts = "noMp3";
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "No mp3.", format: "mp3" }), "u1"), /would not make an MP3 of this text; choose WAV/);
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "No mp3." }), "u1"), /could not speak that text: output_format is not supported/);
      tts = "done";
      // Free reaches HeyGen as its Turbo Free model; its limits running out is said as free speech's, and nothing is kept.
      await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Free news.", free: true }), "u1");
      assert.deepEqual(calls.at(-1)!.body, { model: "heygen-voice-1-turbo-free", voice_id: "hv_1", text: "Free news.", with_timestamps: true });
      tts = "busy";
      const kept = (await listVoiceChanges("u1")).length;
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "More free news.", free: true }), "u1"), (e: unknown) => e instanceof LimitError && /free speech is at its limit or busy/.test((e as Error).message));
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Paid news.", turbo: true }), "u1"), (e: unknown) => e instanceof LimitError && /speaking too many texts/.test((e as Error).message));
      // A free request HeyGen fails (its shared free capacity, or no answer) is said as free speech's; a paid one as before.
      tts = "down";
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Down free.", free: true }), "u1"), (e: unknown) => e instanceof UpstreamError && /free speech did not answer; try again, or speak the text without Free/.test((e as Error).message));
      await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Down paid." }), "u1"), (e: unknown) => e instanceof UpstreamError && /did not finish speaking the text in time/.test((e as Error).message));
      assert.equal((await listVoiceChanges("u1")).length, kept);
      tts = "done";
      // Each word's time comes back with the audio and is kept for captions in a row of its own (never loaded by the
      // listing); a HeyGen that sends only characters has them put together into words.
      const wordsOf = async (id: string) => (await getStore().get<VoiceChangeWords>("voicewords", `voicewords_${id}`))?.words;
      timings = "words";
      const timed = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Hi there. Bye." }), "u1");
      assert.equal(timed.timed, true);
      assert.equal("words" in timed, false);
      assert.deepEqual(await wordsOf(timed.id), [{ text: "Hi", startSec: 0, endSec: 0.3 }, { text: "there.", startSec: 0.3, endSec: 0.9 }, { text: "Bye.", startSec: 1.6, endSec: 2 }]);
      assert.equal(publicVoiceChange(timed).timed, true);
      assert.deepEqual((await voiceChangeCaptions(timed.id, "u1")).cues.map((c) => [c.startMs, c.endMs, c.text]), [[0, 900, "Hi there."], [1600, 2300, "Bye."]]);
      await assert.rejects(voiceChangeCaptions(timed.id, "u2"), NotFoundError);
      await assert.rejects(voiceChangeCaptions("../x", "u1"));
      timings = "characters";
      const fromChars = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Hi yo" }), "u1");
      assert.deepEqual(await wordsOf(fromChars.id), [{ text: "Hi", startSec: 0, endSec: 0.2 }, { text: "yo", startSec: 0.3, endSec: 0.5 }]);
      // Deleting the text deletes its timings.
      await deleteVoiceChange(fromChars.id, "u1");
      assert.equal(await wordsOf(fromChars.id), undefined);
      timings = "none";
      const untimed = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Plain." }), "u1");
      assert.equal(untimed.timed, undefined);
      await assert.rejects(voiceChangeCaptions(untimed.id, "u1"), /no word timings/);
      // A store that will not take the timings (a database whose kinds predate them) keeps the speech without captions.
      timings = "words";
      const store = getStore();
      const realPut = store.put.bind(store);
      store.put = (async (kind: string, item: { id: string }) => {
        if (kind === "voicewords") throw new Error("violates check constraint studio_items_kind_check");
        return realPut(kind as never, item as never);
      }) as typeof store.put;
      try {
        const kept = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Old database." }), "u1");
        assert.deepEqual([kept.status, kept.timed], ["completed", undefined]);
      } finally {
        store.put = realPut;
      }
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

  it("keeps a finished recording as an audio clip once, while the renderer's link holds", async () => {
    const voice = await ready("u1");
    const spoken = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "Welcome to the spring open house, everyone." }), "u1");
    const before = (await getStore().get<VoiceChange>("voicechange", spoken.id))!;
    // Two clicks at once make one clip.
    const [first, second] = await Promise.all([keepVoiceChangeAsClip(spoken.id, "u1"), keepVoiceChangeAsClip(spoken.id, "u1")]);
    assert.equal(first.clip.id, second.clip.id);
    assert.equal(first.existing, false);
    assert.deepEqual([first.clip.name, first.clip.mimeType, first.clip.durationSec], [spoken.title, "audio/wav", spoken.durationSec]);
    assert.equal(first.clip.providerAssetIds, undefined, "the clip is shown as the API shows clips");
    const after = (await getStore().get<VoiceChange>("voicechange", spoken.id))!;
    assert.equal(after.savedClipId, first.clip.id);
    assert.equal(after.updatedAt, before.updatedAt, "keeping it does not make the renderer's link look newer");
    assert.equal(publicVoiceChange(after).savedClipId, first.clip.id);
    // Asked again: the same clip, made once.
    const again = await keepVoiceChangeAsClip(spoken.id, "u1");
    assert.deepEqual([again.clip.id, again.existing], [first.clip.id, true]);
    assert.equal((await getStore().list("clip", "u1")).length - 1, 1, "one clip beside the voice's sample");
    // The clip deleted: keeping it makes a new one.
    await deleteClip(first.clip.id, "u1");
    const remade = await keepVoiceChangeAsClip(spoken.id, "u1");
    assert.equal(remade.existing, false);
    assert.notEqual(remade.clip.id, first.clip.id);
    // Another account's recording is not found; one not ready, failed, or over an hour old is refused.
    await assert.rejects(keepVoiceChangeAsClip(spoken.id, "u2"), NotFoundError);
    const base = (await getStore().get<VoiceChange>("voicechange", spoken.id))!;
    const { savedClipId: _kept, ...fresh } = base;
    void _kept;
    await getStore().put("voicechange", { ...fresh, status: "processing", audioUrl: undefined });
    await assert.rejects(keepVoiceChangeAsClip(spoken.id, "u1"), /still being made; keep it once it is ready/);
    await getStore().put("voicechange", { ...fresh, status: "failed", audioUrl: undefined });
    await assert.rejects(keepVoiceChangeAsClip(spoken.id, "u1"), /could not be made/);
    const old = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    await getStore().put("voicechange", { ...fresh, updatedAt: old, checkedAt: old });
    await assert.rejects(keepVoiceChangeAsClip(spoken.id, "u1"), /over an hour ago, and its link from the renderer has expired/);
    await assert.rejects(keepVoiceChangeAsClip("vc_missing", "u1"), NotFoundError);
    await assert.rejects(keepVoiceChangeAsClip("not-an-id", "u1"), /Unknown recording/);
  });

  it("reads HeyGen's file through the public-address guard and keeps only WAV or MP3 within the clip limits", async () => {
    const now = new Date().toISOString();
    const change: VoiceChange = { id: "vc_heygen_keep", ownerId: "u1", title: "Hello there in Host", voiceId: "iv_x", voiceName: "Host", text: "Hello there.", provider: "heygen", providerVoiceId: "hv_x", status: "completed", audioUrl: "https://93.184.216.34/tts/a.wav?sig=1", durationSec: 1.2, createdAt: now, updatedAt: now };
    const wav = Buffer.from(wavDataUrl().split(",")[1], "base64");
    let answer: () => Response = () => new Response(wav, { headers: { "content-type": "application/octet-stream" } });
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      asked.push(url);
      return answer();
    };
    await getStore().put("voicechange", change);
    const kept = await keepVoiceChangeAsClip(change.id, "u1", fetchImpl);
    assert.deepEqual(asked, [change.audioUrl]);
    assert.deepEqual([kept.clip.mimeType, kept.clip.durationSec], ["audio/wav", 1], "a WAV's length is read from the file, its kind from its bytes");
    // An MP3 takes the length HeyGen reported.
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
    answer = () => new Response(mp3);
    await getStore().put("voicechange", { ...change, format: "mp3" });
    assert.deepEqual(((c) => [c.mimeType, c.durationSec])((await keepVoiceChangeAsClip(change.id, "u1", fetchImpl)).clip), ["audio/mpeg", 1.2]);
    await getStore().put("voicechange", { ...change, format: "mp3", durationSec: 0 });
    await assert.rejects(keepVoiceChangeAsClip(change.id, "u1", fetchImpl), /length of “Hello there in Host” is not known/);
    // Not audio, an expired link, HeyGen down, and a file past the clip size.
    await getStore().put("voicechange", change);
    answer = () => new Response("<html>nope</html>", { headers: { "content-type": "audio/wav" } });
    await assert.rejects(keepVoiceChangeAsClip(change.id, "u1", fetchImpl), /is not WAV or MP3 audio/);
    answer = () => new Response("denied", { status: 403 });
    await assert.rejects(keepVoiceChangeAsClip(change.id, "u1", fetchImpl), (e: unknown) => e instanceof ValidationError && /link to “Hello there in Host” has expired/.test((e as Error).message));
    answer = () => new Response("busy", { status: 503 });
    await assert.rejects(keepVoiceChangeAsClip(change.id, "u1", fetchImpl), (e: unknown) => e instanceof UpstreamError && /try again in a few minutes/.test((e as Error).message));
    answer = () => new Response(new Uint8Array(3 * 1024 * 1024 + 1));
    await assert.rejects(keepVoiceChangeAsClip(change.id, "u1", fetchImpl), /too large to keep as an audio clip \(3 MB at most\); speak it again as an MP3/);
    await getStore().put("voicechange", { ...change, text: undefined, clipId: "clip_x" });
    await assert.rejects(keepVoiceChangeAsClip(change.id, "u1", fetchImpl), /too large to keep as an audio clip \(3 MB at most\); make it from a shorter recording/);
    // A link to a private address is never read.
    asked.length = 0;
    await getStore().put("voicechange", { ...change, audioUrl: "https://127.0.0.1/a.wav" });
    await assert.rejects(keepVoiceChangeAsClip(change.id, "u1", fetchImpl), (e: unknown) => e instanceof ValidationError && /cannot be read from here; download it and upload it/.test((e as Error).message));
    assert.deepEqual(asked, []);
    // A WAV whose header gives no length (here 32-bit float) is not kept, as an upload of it would not be.
    await getStore().put("voicechange", change);
    const float = new Uint8Array(wav);
    new DataView(float.buffer).setUint16(20, 3, true);
    answer = () => new Response(float);
    await assert.rejects(keepVoiceChangeAsClip(change.id, "u1", fetchImpl), /WAV file for “Hello there in Host” is not one a clip can hold/);
    assert.equal((await getStore().list("clip", "u1")).length, 2, "only the two good files became clips");
  });
});
