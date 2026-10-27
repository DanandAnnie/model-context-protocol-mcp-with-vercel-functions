// Voice cloning with HeyGen voices (v3 `POST /v3/voices/clone`): one WAV or MP3 recording uploaded as an asset and
// cloned, waited for briefly, kept as the account's own voice, never offered to another account, and deleted at
// HeyGen with it.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { cloneVoice, cloneVoiceSchema, deleteClonedVoice, deleteOwnerData, listVoices } from "../services";
import { ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { HeyGenTtsProvider } from "../providers/tts/heygen";
import { forgetMemo } from "../cache";

const WAV = `data:audio/wav;base64,${Buffer.from("RIFF....WAVEfmt ").toString("base64")}`;
const MP3 = `data:audio/mpeg;base64,${Buffer.from("ID3....").toString("base64")}`;
const WEBM = `data:audio/webm;base64,${Buffer.from("webm").toString("base64")}`;
const realFetch = globalThis.fetch;
const realSleep = HeyGenTtsProvider.sleep;

type Call = { url: string; method: string; body: unknown };
/** HeyGen as the tests need it: assets, clones (answered by `clone`), a clone's status, voice lists, and deletes. */
function stub(state: { status: Array<string | null>; failure?: string; refuse?: { status: number; message: string } }) {
  const calls: Call[] = [];
  let clones = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ? "form" : null });
    if (url === "https://api.heygen.com/v3/assets" && method === "POST") return Response.json({ data: { asset_id: `asset_${clones + 1}` } });
    if (url === "https://api.heygen.com/v3/voices/clone" && method === "POST") {
      if (state.refuse) return Response.json({ error: { code: "resource_limit_reached", message: state.refuse.message } }, { status: state.refuse.status });
      return Response.json({ data: { voice_clone_id: `clone_${++clones}` } });
    }
    const id = /\/v3\/voices\/(clone_\d+)$/.exec(url)?.[1];
    if (id && method === "DELETE") return Response.json({ data: { voice_id: id } });
    if (id) {
      const status = state.status.length > 1 ? state.status.shift()! : state.status[0];
      return Response.json({ data: { voice_id: id, status, support_pause: true, ...(status === "complete" ? { preview_audio_url: `https://93.184.216.34/${id}.wav` } : {}), ...(status === "failed" ? { failure_message: state.failure } : {}) } });
    }
    if (url.includes("/v3/voices?type=private")) return Response.json({ data: [1, 2].map((n) => ({ voice_id: `clone_${n}`, name: `Clone ${n}` })).concat([{ voice_id: "operator_voice", name: "Operator" }]), has_more: false });
    if (url.includes("/v3/voices?type=public")) return Response.json({ data: [{ voice_id: "public_voice", name: "Nadine" }], has_more: false });
    if (url.includes("/v3/avatars/looks?")) return Response.json({ data: [], has_more: false });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
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

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetMemo();
  HeyGenTtsProvider.sleep = async () => undefined;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  HeyGenTtsProvider.sleep = realSleep;
});

const input = (samples: string[], name = "Dana (my voice)") => cloneVoiceSchema.parse({ name, samples });

describe("voice cloning with HeyGen", () => {
  it("is offered with HeyGen voices, from one recording", () =>
    inHeygen(async () => {
      const status = providerStatus();
      assert.deepEqual([status.tts, status.voiceCloning, status.voiceCloneOneRecording], ["heygen", true, true]);
      stub({ status: ["complete"] });
      await assert.rejects(cloneVoice(input([WAV, WAV]), "u1"), (e: unknown) => e instanceof ValidationError && /one WAV or MP3 recording/.test((e as Error).message));
      await assert.rejects(cloneVoice(input([WEBM]), "u1"), /one WAV or MP3 recording/);
    }));

  it("uploads the recording, clones it with HeyGen, waits for it, and keeps it as the account's own voice only", () =>
    inHeygen(async () => {
      const calls = stub({ status: ["processing", "complete"] });
      const voice = await cloneVoice(input([WAV]), "u1");
      assert.deepEqual([voice.id, voice.source, voice.provider, voice.previewUrl], ["clone_1", "custom", "heygen", "https://93.184.216.34/clone_1.wav"]);
      const clone = calls.find((c) => c.url.endsWith("/v3/voices/clone"))!;
      assert.deepEqual(clone.body, { voice_name: "Dana (my voice)", audio: { type: "asset_id", asset_id: "asset_1" }, remove_background_noise: true });
      assert.equal(calls.filter((c) => /\/v3\/voices\/clone_1$/.test(c.url)).length, 2, "asked until it was complete");
      // HeyGen lists the clone with the account's own voices, to every account that shares its key.
      assert.ok((await listVoices("u1")).some((v) => v.id === "clone_1" && v.source === "custom"));
      const others = (await listVoices("u2")).map((v) => v.id);
      assert.equal(others.includes("clone_1"), false, "never offered to another account");
      assert.ok(others.includes("operator_voice"), "the operator's own HeyGen voices are listed as before");
      // An MP3 is sent as it is.
      const mp3 = await cloneVoice(input([MP3], "Lee"), "u1");
      assert.equal(mp3.id, "clone_2");
      // Deleted, it goes at HeyGen too, and stays out of other accounts' lists.
      await deleteClonedVoice(voice.id, "u1");
      assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v3/voices/clone_1")));
      forgetMemo();
      assert.equal((await listVoices("u2")).some((v) => v.id === "clone_1"), false);
      await deleteOwnerData("u1");
      assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v3/voices/clone_2")));
    }));

  it("keeps a clone still being made, refuses one HeyGen could not make, and passes on HeyGen's refusals", () =>
    inHeygen(async () => {
      let calls = stub({ status: ["processing"] });
      const slow = await cloneVoice(input([WAV]), "u1");
      assert.deepEqual([slow.id, slow.previewUrl], ["clone_1", undefined]);
      calls = stub({ status: ["failed"], failure: "The recording is too quiet." });
      await assert.rejects(cloneVoice(input([WAV], "Quiet"), "u1"), (e: unknown) => e instanceof ValidationError && /could not clone that voice: The recording is too quiet\./.test((e as Error).message));
      assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v3/voices/clone_1")), "a failed clone is deleted");
      assert.equal((await listVoices("u1")).some((v) => v.name === "Quiet"), false);
      stub({ status: ["complete"], refuse: { status: 400, message: "Voice clone limit reached (10). Delete unused clones or contact support to increase your limit." } });
      await assert.rejects(cloneVoice(input([WAV], "Over"), "u1"), (e: unknown) => e instanceof ValidationError && /could not clone that voice: Voice clone limit reached \(10\)/.test((e as Error).message));
    }));
});
