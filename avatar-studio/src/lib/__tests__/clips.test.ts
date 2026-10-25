// Audio clips and audio scenes: storage, validation, and how each renderer uses them.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import {
  MAX_CLIPS,
  createClip,
  createVideo,
  deleteClip,
  exportOwnerData,
  getClipAudio,
  listClips,
  retryVideo,
  videoRequestSchema,
  wavSeconds,
} from "../services";
import { LOCAL_OWNER } from "../owner-id";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { AudioClip, Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

/** A silent 16-bit mono PCM WAV of the given length. */
function wav(seconds: number, sampleRate = 8000): Uint8Array {
  const dataSize = Math.round(seconds * sampleRate) * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const put = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}
const dataUrl = (bytes: Uint8Array, type = "audio/wav") => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

describe("audio clips", () => {
  it("reads a WAV's length from its header and rejects what is not audio it can use", async () => {
    assert.equal(wavSeconds(wav(2.5)), 2.5);
    assert.equal(wavSeconds(new Uint8Array([1, 2, 3])), null);
    const clip = await createClip({ name: "Intro take", audio: dataUrl(wav(2.5)) });
    assert.equal(clip.durationSec, 2.5, "the client cannot claim a different length for a WAV");
    assert.equal(clip.mimeType, "audio/wav");
    assert.equal("providerAssetIds" in clip, false);
    const mp3 = await createClip({ name: "Phone memo", audio: dataUrl(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), "audio/mpeg"), durationSec: 4 });
    assert.equal(mp3.durationSec, 4);
    await assert.rejects(createClip({ name: "No length", audio: dataUrl(new Uint8Array([0xff, 0xfb]), "audio/mpeg") }), /durationSec/);
    await assert.rejects(createClip({ name: "Webm", audio: dataUrl(new Uint8Array([1, 2]), "audio/webm") }), /WAV or MP3/);
    await assert.rejects(createClip({ name: "Image", audio: "data:image/png;base64,AAAA" }), /audio recording/);
    await assert.rejects(createClip({ name: "Broken", audio: dataUrl(new Uint8Array([0x52, 0x49, 0x46, 0x46])) }), /malformed/);
    await assert.rejects(createClip({ name: "Blip", audio: dataUrl(wav(0.2)) }), /too short/);
    await assert.rejects(createClip({ name: "Lecture", audio: dataUrl(wav(91, 8000)) }), /at most 90 seconds/);
    // A WAV must be PCM, and its rate comes from its sample rate, channels, and bits, not the header's byte-rate field.
    const float = wav(2);
    new DataView(float.buffer).setUint16(20, 3, true);
    await assert.rejects(createClip({ name: "Float", audio: dataUrl(float) }), /WAV file is malformed/);
    const lying = wav(2);
    new DataView(lying.buffer).setUint32(28, 1, true);
    assert.equal(wavSeconds(lying), 2, "a forged byte rate cannot stretch the length");
    // An MP3 must start like one.
    await assert.rejects(createClip({ name: "Not MP3", audio: dataUrl(new Uint8Array([1, 2, 3, 4]), "audio/mpeg"), durationSec: 2 }), /MP3 file is malformed/);
    const id3 = await createClip({ name: "Tagged", audio: dataUrl(new Uint8Array([0x49, 0x44, 0x33, 4, 0]), "audio/mpeg"), durationSec: 2 });
    await deleteClip(id3.id);
    // Listing reads metadata only (both clips can share a millisecond, so order is not asserted); the bytes come back from their own record.
    const listed = await listClips();
    assert.deepEqual(listed.map((c) => c.name).sort(), ["Intro take", "Phone memo"]);
    assert.equal(listed.some((c) => "data" in c || "providerAssetIds" in c), false);
    const audio = await getClipAudio(clip.id);
    assert.equal(audio.bytes.byteLength, wav(2.5).byteLength);
    // Another account sees neither the clip nor its audio.
    await assert.rejects(getClipAudio(clip.id, "user_other"), /not found/);
    assert.deepEqual(await listClips("user_other"), []);
    await deleteClip(clip.id);
    await assert.rejects(getClipAudio(clip.id), /not found/);
    assert.equal(await getStore().get("clipaudio", `clipaudio_${clip.id}`), null, "the audio goes with the clip");
  });

  it("caps clips per account", async () => {
    for (let i = 0; i < MAX_CLIPS; i++) await createClip({ name: `Take ${i}`, audio: dataUrl(wav(1, 8000)) });
    await assert.rejects(createClip({ name: "One more", audio: dataUrl(wav(1, 8000)) }), /At most 20 audio clips/);
  });

  it("an audio scene names its clip, drops its voice, and times the demo render by the clip", async () => {
    const clip = await createClip({ name: "Founder intro", audio: dataUrl(wav(20, 8000)) });
    const req = videoRequestSchema.parse({
      title: "Recorded intro",
      avatarId: STOCK_AVATARS[0].id,
      voiceId: STOCK_VOICES[0].id,
      scenes: [
        { script: "Hi, I recorded this myself.", background: { type: "color", value: "#000000" }, audioId: clip.id, voiceId: "not-checked-for-audio" },
        { script: "And this part is typed.", background: { type: "color", value: "#ffffff" } },
      ],
    });
    const video = await createVideo(req);
    assert.equal(video.status, "processing", video.error);
    assert.deepEqual([video.scenes![0].audioName, video.scenes![0].audioSeconds, video.scenes![0].voiceId], ["Founder intro", 20, undefined]);
    assert.equal(video.scenes![1].audioId, undefined);
    // The demo render lasts the clip plus the typed words (5 words at 2.5 a second = 2s).
    assert.match(video.providerJobId!, /_22$/);
    // The demo renderer marks the clip prepared, so a retry or copy reuses it.
    assert.equal((await getStore().get<AudioClip>("clip", clip.id))?.providerAssetIds?.mock, clip.id);
    // The script stays the transcript, for captions and search.
    assert.match(video.script, /recorded this myself/);
  });

  it("a clip from another account or a deleted clip is refused before anything renders", async () => {
    const theirs = await createClip({ name: "Theirs", audio: dataUrl(wav(2, 8000)) }, "user_other");
    const base = { title: "Borrowed", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id };
    await assert.rejects(createVideo(videoRequestSchema.parse({ ...base, scenes: [{ script: "x", background: { type: "color", value: "#000000" }, audioId: theirs.id }] })), /Audio clip .* not found/);
    const mine = await createClip({ name: "Mine", audio: dataUrl(wav(2, 8000)) });
    // A failed video that named the clip cannot be retried once the clip is gone.
    const failed: Video = {
      ...videoRequestSchema.parse({ ...base, scenes: [{ script: "x", background: { type: "color", value: "#000000" }, audioId: mine.id }] }),
      id: "vid_failed_audio",
      ownerId: LOCAL_OWNER,
      status: "failed",
      provider: "mock",
      error: "boom",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await getStore().put("video", failed);
    await deleteClip(mine.id);
    await assert.rejects(retryVideo(failed.id), /Audio clip .* not found/);
  });

  it("deleting the account removes clips and their audio without listing the audio", async () => {
    const { deleteOwnerData } = await import("../services");
    const clip = await createClip({ name: "Gone", audio: dataUrl(wav(1, 8000)) });
    const store = getStore();
    const listed: string[] = [];
    const list = store.list.bind(store);
    store.list = (async (kind: Parameters<typeof list>[0], owner?: string) => {
      listed.push(kind);
      return list(kind, owner);
    }) as typeof store.list;
    const counts = await deleteOwnerData();
    assert.equal(counts.clip, 1);
    assert.equal(listed.includes("clipaudio"), false, "audio rows are removed by id, never loaded");
    assert.equal(await store.get("clipaudio", `clipaudio_${clip.id}`), null);
  });

  it("the export lists clips without provider ids and leaves the audio bytes out", async () => {
    const clip = await createClip({ name: "Export me", audio: dataUrl(wav(1, 8000)) });
    await getStore().put("clip", { ...(await getStore().get<AudioClip>("clip", clip.id))!, providerAssetIds: { heygen: "asset_1" } });
    const out = await exportOwnerData();
    assert.deepEqual((out.clip as Array<Record<string, unknown>>).map((c) => [c.name, "providerAssetIds" in c]), [["Export me", false]]);
    assert.equal("clipaudio" in out, false);
  });
});

describe("audio scenes at the renderer", () => {
  const ava = { ...STOCK_AVATARS[0], id: "ava_hg", provider: "heygen", source: "provider" as const };
  const emma = { ...STOCK_VOICES[0], id: "emma_hg", provider: "heygen" };
  const clip: AudioClip = { id: "clip_1", name: "Take", mimeType: "audio/wav", bytes: 10, durationSec: 3, createdAt: "", providerAssetIds: { heygen: "asset_1", did: "https://d-id.example/audio.wav" } };

  it("HeyGen lip-syncs an audio scene to its uploaded asset and speaks typed scenes as before", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    let sent: { video_inputs: Array<{ voice: Record<string, unknown> }> } | null = null;
    client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    const uploads: string[] = [];
    client.uploadAsset = async (_bytes, mime) => {
      uploads.push(mime as string);
      return "asset_new";
    };
    const req = videoRequestSchema.parse({
      title: "Mixed",
      avatarId: ava.id,
      voiceId: emma.id,
      scenes: [
        { script: "Recorded.", background: { type: "color", value: "#000000" }, audioId: clip.id },
        { script: "Typed.", background: { type: "color", value: "#ffffff" } },
      ],
    });
    await heygen.createVideo(req, ava, emma, { avatars: { [ava.id]: ava }, voices: { [emma.id]: emma }, clips: { [clip.id]: clip } });
    assert.deepEqual(sent!.video_inputs[0].voice, { type: "audio", audio_asset_id: "asset_1" });
    assert.equal(sent!.video_inputs[1].voice.type, "text");
    await assert.rejects(heygen.createVideo(req, ava, emma, { avatars: {}, voices: {}, clips: {} }), /not been uploaded to HeyGen/);
    // Preparing uploads once and keeps the id; an already prepared clip is not uploaded again.
    const fresh = await heygen.prepareAudio({ ...clip, providerAssetIds: {} }, { bytes: new Uint8Array([1]), mimeType: "audio/wav" });
    assert.equal(fresh.providerAssetIds?.heygen, "asset_new");
    await heygen.prepareAudio(clip, { bytes: new Uint8Array([1]), mimeType: "audio/wav" });
    assert.deepEqual(uploads, ["audio/wav"]);
  });

  it("D-ID speaks a single-scene clip from its hosted URL and refuses audio in a multi-scene video", async () => {
    const { DidAvatarProvider } = await import("../providers/avatar/did");
    const did = new DidAvatarProvider("key");
    let body: { script: Record<string, unknown> } | null = null;
    (did as unknown as { request: (p: string, i: RequestInit) => Promise<unknown> }).request = async (_p, init) => {
      body = JSON.parse(init.body as string);
      return { id: "talk_1" };
    };
    const one = videoRequestSchema.parse({ title: "Solo", avatarId: ava.id, voiceId: emma.id, scenes: [{ script: "Recorded.", background: { type: "color", value: "#000000" }, audioId: clip.id }] });
    await did.createVideo(one, ava, emma, { avatars: {}, voices: {}, clips: { [clip.id]: clip } });
    assert.deepEqual(body!.script, { type: "audio", audio_url: "https://d-id.example/audio.wav" });
    const two = videoRequestSchema.parse({ ...one, scenes: [...one.scenes!, { script: "Typed.", background: { type: "color", value: "#ffffff" } }] });
    await assert.rejects(did.createVideo(two, ava, emma, { avatars: {}, voices: {}, clips: { [clip.id]: clip } }), /single-scene video/);
  });
});
