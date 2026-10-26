// Voice design: a voice made from a written description (ElevenLabs text-to-voice), chosen from previews and kept as a
// voice of the account beside cloned ones, within the same limit.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { cloneVoice, cloneVoiceSchema, designVoice, designVoiceSchema, listVoices, saveDesignedVoice, saveDesignedVoiceSchema, MAX_CLONED_VOICES } from "../services";
import { MockTtsProvider } from "../providers/tts/mock";
import { ValidationError } from "../errors";
import { providerStatus } from "../providers";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const DESCRIPTION = "A warm, friendly woman in her thirties with a light Irish accent, speaking at an easy pace.";

describe("voice design", () => {
  it("checks the description and the sample text as ElevenLabs takes them", () => {
    assert.throws(() => designVoiceSchema.parse({ description: "Warm voice" }), /at least 20 characters/);
    assert.throws(() => designVoiceSchema.parse({ description: DESCRIPTION, text: "Too short to read." }), /at least 100 characters/);
    assert.deepEqual(designVoiceSchema.parse({ description: ` ${DESCRIPTION} `, text: "   " }), { description: DESCRIPTION, text: undefined });
    assert.throws(() => designVoiceSchema.parse({ description: "x".repeat(1001) }));
    assert.throws(() => saveDesignedVoiceSchema.parse({ name: "Narrator", description: DESCRIPTION, previewId: "../voices" }), /Choose one of the previews/);
  });

  it("offers previews in demo mode and keeps the chosen one as a voice, within the account's limit", async () => {
    assert.equal(providerStatus().voiceDesign, true);
    const { text, previews } = await designVoice(designVoiceSchema.parse({ description: DESCRIPTION }), "u1");
    assert.equal(previews.length, 3);
    assert.ok(text.length >= 100, "a sample is written when none is given");
    assert.ok(previews.every((p) => !p.audioUrl), "the browser reads demo previews");
    const voice = await saveDesignedVoice(saveDesignedVoiceSchema.parse({ name: "Irish narrator", description: DESCRIPTION, previewId: previews[1].previewId }), "u1");
    assert.equal(voice.source, "custom");
    assert.deepEqual(voice.tags, ["designed voice"]);
    const listed = await listVoices("u1");
    assert.equal(listed[0].id, voice.id, "listed first, with the account's own voices");
    assert.equal((await listVoices("u2")).some((v) => v.id === voice.id), false, "private to the account");
    // Designed and cloned voices share the limit; a full account is refused before any previews are asked for.
    for (let i = 1; i < MAX_CLONED_VOICES; i++) await saveDesignedVoice({ name: `V${i}`, description: DESCRIPTION, previewId: `design_${i}` }, "u1");
    const realDesign = MockTtsProvider.prototype.designVoice;
    let asked = 0;
    MockTtsProvider.prototype.designVoice = async function (input) {
      asked++;
      return realDesign.call(this, input);
    };
    try {
      await assert.rejects(designVoice(designVoiceSchema.parse({ description: DESCRIPTION }), "u1"), (e: unknown) => e instanceof ValidationError && /delete one to design another/.test((e as Error).message));
      assert.equal(asked, 0, "the provider is never asked for previews that could not be saved");
    } finally {
      MockTtsProvider.prototype.designVoice = realDesign;
    }
    await assert.rejects(saveDesignedVoice({ name: "One more", description: DESCRIPTION, previewId: "design_x" }, "u1"), ValidationError);
    const sample = `data:audio/webm;base64,${Buffer.from("voice sample").toString("base64")}`;
    await assert.rejects(cloneVoice(cloneVoiceSchema.parse({ name: "My voice", samples: [sample] }), "u1"), /delete one to clone another/);
  });

  it("keeps to the limit when saves arrive together", async () => {
    const saves = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => saveDesignedVoice({ name: `Voice ${i}`, description: DESCRIPTION, previewId: `design_${i}` }, "u-race")),
    );
    assert.equal(saves.filter((s) => s.status === "fulfilled").length, MAX_CLONED_VOICES);
    assert.equal((await listVoices("u-race")).filter((v) => v.source === "custom").length, MAX_CLONED_VOICES);
  });

  it("never lists one account's cloned or designed voices to another, and says why ElevenLabs refused a description", async () => {
    const { ElevenLabsTtsProvider } = await import("../providers/tts/elevenlabs");
    const realFetch = globalThis.fetch;
    const answers = [
      Response.json({
        voices: [
          { voice_id: "premade_1", name: "Rachel", category: "premade" },
          { voice_id: "pro_1", name: "Studio narrator", category: "professional" },
          { voice_id: "clone_a", name: "Dana (my voice)", category: "cloned" },
          { voice_id: "gen_a", name: "Irish narrator", category: "generated" },
        ],
      }),
      Response.json({ detail: { status: "invalid_voice_description", message: "The description could not be used." } }, { status: 422 }),
    ];
    globalThis.fetch = (async () => answers.shift()!) as typeof fetch;
    try {
      const el = new ElevenLabsTtsProvider("key");
      assert.deepEqual((await el.listVoices()).map((v) => v.id), ["premade_1", "pro_1"], "each account sees its own from its records");
      await assert.rejects(el.designVoice({ description: DESCRIPTION }), (e: unknown) => e instanceof ValidationError && /could not design that voice: The description could not be used\./.test((e as Error).message));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("asks ElevenLabs for previews of the description and saves the chosen one", async () => {
    const { config } = await import("../config");
    const saved = { tts: config.ttsProvider, key: config.elevenLabsApiKey };
    const calls: Array<{ url: string; body: unknown; key: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get("xi-api-key") });
      if (url.includes("/text-to-voice/design")) {
        return Response.json({
          text: "Written for the description.",
          previews: [
            { generated_voice_id: "gv_1", audio_base_64: "SUQz", media_type: "audio/mpeg", duration_secs: 6.4 },
            { generated_voice_id: "gv_2", audio_base_64: "SUQ0", media_type: "audio/mpeg", duration_secs: 5.9 },
          ],
        });
      }
      if (url.endsWith("/text-to-voice")) return Response.json({ voice_id: "el_voice_9", name: "Irish narrator" });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { ttsProvider: "elevenlabs", elevenLabsApiKey: "el_key" });
    try {
      const out = await designVoice(designVoiceSchema.parse({ description: DESCRIPTION }), "u1");
      assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-voice/design?output_format=mp3_44100_64");
      assert.deepEqual(calls[0].body, { voice_description: DESCRIPTION, model_id: "eleven_multilingual_ttv_v2", auto_generate_text: true });
      assert.equal(calls[0].key, "el_key");
      assert.deepEqual(out, {
        text: "Written for the description.",
        previews: [
          { previewId: "gv_1", audioUrl: "data:audio/mpeg;base64,SUQz", durationSec: 6.4 },
          { previewId: "gv_2", audioUrl: "data:audio/mpeg;base64,SUQ0", durationSec: 5.9 },
        ],
      });
      // A sample of the account's own is read instead of one written for it.
      const own = "Welcome to twelve Maple Street. Come in and have a look around; the kitchen was redone last spring and it shows.";
      await designVoice({ description: DESCRIPTION, text: own }, "u1");
      assert.deepEqual(calls[1].body, { voice_description: DESCRIPTION, model_id: "eleven_multilingual_ttv_v2", text: own });

      const voice = await saveDesignedVoice({ name: "Irish narrator", description: DESCRIPTION, previewId: "gv_2" }, "u1");
      assert.equal(calls[2].url, "https://api.elevenlabs.io/v1/text-to-voice");
      assert.deepEqual(calls[2].body, { voice_name: "Irish narrator", voice_description: DESCRIPTION, generated_voice_id: "gv_2" });
      assert.equal(voice.id, "el_voice_9");
      assert.equal(voice.provider, "elevenlabs");
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { ttsProvider: saved.tts, elevenLabsApiKey: saved.key });
    }
  });
});
