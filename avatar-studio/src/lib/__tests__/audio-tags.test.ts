// HeyGen Voice audio tags in text spoken in a voice: what counts as a tag, how a text is read for them, what the
// server refuses (a professional voice, the boost beside a tag), what is kept without them (a title, a clip's words),
// and the script writer's draft of tags, taken only when the words are unchanged.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { audioTagDraftSchema, createClip, createInstantVoice, draftAudioTags, forgetVoiceChangerChecks, instantVoiceSchema, keepVoiceChangeAsClip, startVoiceSpeech, voiceChangeCaptions, voiceSpeechSchema } from "../services";
import { AUDIO_TAGS, COMMON_AUDIO_TAGS, boostIgnoredFor, dropTagWords, normalizeAudioTags, scanAudioTags, tagPlacements, withoutAudioTags } from "../audio-tags";
import { providerStatus, setScriptProvider } from "../providers";
import { MockScriptProvider } from "../providers/script/mock";
import { UpstreamError, ValidationError } from "../errors";
import type { InstantVoice } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetVoiceChangerChecks();
});
afterEach(() => setScriptProvider(undefined));

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

const ready = async (owner: string) => {
  const sample = await createClip({ name: "Sample", audio: wavDataUrl() }, owner);
  const voice = await createInstantVoice(instantVoiceSchema.parse({ name: "Narrator", clipId: sample.id, agreed: true }), owner);
  await getStore().put("instantvoice", { ...(await getStore().get<InstantVoice>("instantvoice", voice.id))!, status: "completed" });
  return voice;
};

describe("audio tags", () => {
  it("are HeyGen's list, the common ones among them, each once per category", () => {
    for (const [category, tags] of Object.entries(COMMON_AUDIO_TAGS)) {
      for (const t of tags) assert.ok(AUDIO_TAGS[category as keyof typeof AUDIO_TAGS].includes(t), `${t} is a ${category} tag`);
    }
    for (const tags of Object.values(AUDIO_TAGS)) assert.equal(new Set(tags).size, tags.length);
    assert.ok(AUDIO_TAGS.emotion.includes("deadpan, dry humor"), "a tag with a comma is one tag");
  });

  it("are read from a text with other brackets, tags side by side, and any case told apart", () => {
    const scan = scanAudioTags("[Excited] We did it! [laughs] [ sighs ] See [Section 4] and [sad, quietly]. [deadpan, dry humor] Sure.");
    assert.deepEqual(scan.tags, ["excited", "laughs", "sighs", "deadpan, dry humor"]);
    assert.deepEqual(scan.unknown, ["[Section 4]", "[sad, quietly]"], "a made-up pair is not a tag");
    assert.deepEqual(scan.sideBySide, ["[laughs] [sighs]"]);
    assert.deepEqual(scanAudioTags("[warm] Hi. [Section 4] [calm] Go.").sideBySide, [], "other bracketed text between them parts them");
    assert.equal(normalizeAudioTags("[Excited] Hi [ WHISPERS ] there [Section 4]"), "[excited] Hi [whispers] there [Section 4]");
    assert.equal(withoutAudioTags("[warm] Hey everyone, thanks. [laughs]\n[serious] One more thing [Section 4]."), "Hey everyone, thanks.\nOne more thing [Section 4].");
    assert.equal(withoutAudioTags("Hey [laughs], there.[sighs] Next [deadpan, dry humor] line."), "Hey, there. Next line.");
    // Only the gap a tag leaves is tidied: a text without tags is as written, French spacing and all.
    for (const plain of ["Bonjour ! Prix : 10 €", "Hey everyone , thanks", "Down  to .5 percent", "See [Section 4]."]) assert.equal(withoutAudioTags(plain), plain);
    assert.deepEqual(tagPlacements("[warm] Hi there. [laughs] Bye. [Section [sighs] 4]"), [
      { tag: "warm", wordsBefore: 0, nested: false },
      { tag: "laughs", wordsBefore: 2, nested: false },
      { tag: "sighs", wordsBefore: 4, nested: true },
    ]);
  });

  it("are left out of a renderer's timed words, one word or split at spaces", () => {
    const w = (text: string) => ({ text, startSec: 0, endSec: 0 });
    assert.deepEqual(dropTagWords([w("[excited]"), w("We"), w("won!"), w("[deadpan,"), w("dry"), w("humor]"), w("[Section"), w("4]"), w("Sure.")]).map((x) => x.text), ["We", "won!", "[Section", "4]", "Sure."]);
  });

  it("turn the expressiveness boost off, all but [pause]", () => {
    assert.equal(boostIgnoredFor("Breathe in. [pause] And out."), false);
    assert.equal(boostIgnoredFor("[calm] Breathe in."), true);
    assert.equal(boostIgnoredFor("See [Section 4]."), false, "bracketed text that is no tag leaves it on");
  });
});

describe("text spoken with audio tags", () => {
  it("is sent with each tag spelled as HeyGen reads it, titled and timed by its words only", async () => {
    const voice = await ready("u1");
    const spoken = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "[Warm] Welcome to the team. [LAUGHS] Really." }), "u1");
    assert.equal(spoken.text, "[warm] Welcome to the team. [laughs] Really.");
    assert.equal(spoken.title, "Welcome to the team. Really in Narrator");
    const { cues } = await voiceChangeCaptions(spoken.id, "u1");
    assert.doesNotMatch(cues.map((c) => c.text).join(" "), /\[/, "the demo renderer times words, not tags");
    // A text of tags alone is titled by their words.
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "[laughs]" }), "u1")).title, "laughs in Narrator");
  });

  it("keeps a clip's words without the tags, which a video's voice would read out", async () => {
    const voice = await ready("u1");
    const spoken = await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: voice.id, text: "[excited] Welcome to the spring open house! [laughs] Come in." }), "u1");
    const { clip } = await keepVoiceChangeAsClip(spoken.id, "u1");
    assert.equal(clip.transcript, "Welcome to the spring open house! Come in.");
  });

  it("refuses the boost beside a tag HeyGen ignores it for, but keeps it with [pause]", () => {
    const boosted = voiceSpeechSchema.safeParse({ voiceId: "iv_x", text: "[calm] Breathe.", expressivenessBoost: 0.5 });
    assert.equal(boosted.success, false);
    assert.match(boosted.error!.issues[0].message, /does not apply the expressiveness boost to text with audio tags/);
    assert.equal(voiceSpeechSchema.parse({ voiceId: "iv_x", text: "Breathe. [pause] Out.", expressivenessBoost: 0.5 }).expressivenessBoost, 0.5);
    assert.equal(voiceSpeechSchema.parse({ voiceId: "iv_x", text: "[calm] Breathe.", expressivenessBoost: 1 }).expressivenessBoost, undefined, "the full boost is none to send");
  });

  it("is refused for a professional voice, which performs no tags, and spoken by an instant public one", async () => {
    await assert.rejects(startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_nadine", text: "[excited] Welcome aboard." }), "u1"), /Nadine is one of HeyGen's professional voices, which do not perform audio tags/);
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_nadine", text: "Welcome aboard. See [Section 4]." }), "u1")).status, "completed", "bracketed text that is no tag is no tag");
    assert.equal((await startVoiceSpeech(voiceSpeechSchema.parse({ voiceId: "pv_mockpv_atlas", text: "[excited] Welcome aboard." }), "u1")).text, "[excited] Welcome aboard.");
  });
});

describe("tags drafted by the script writer", () => {
  const writer = (out: string | (() => Promise<string>)) => {
    const w = new MockScriptProvider();
    (w as unknown as { audioTags: (i: { text: string }) => Promise<string> }).audioTags = typeof out === "string" ? async () => out : out;
    setScriptProvider(w);
  };

  it("are offered where the writer can add them, the demo one opening warmly", async () => {
    assert.equal(providerStatus().audioTagDrafts, true);
    assert.deepEqual(await draftAudioTags(audioTagDraftSchema.parse({ text: "Welcome to the team." })), { text: "[warm] Welcome to the team.", added: 1 });
    assert.deepEqual(await draftAudioTags(audioTagDraftSchema.parse({ text: "[calm] Welcome." })), { text: "[calm] Welcome.", added: 0 });
  });

  it("are taken only when the words are the text's, a fence or quotes around them taken off", async () => {
    writer('```\n[Excited] We did it! [laughs] See [Section 4].\n```');
    assert.deepEqual(await draftAudioTags(audioTagDraftSchema.parse({ text: "We did it! See [Section 4]." })), { text: "[excited] We did it! [laughs] See [Section 4].", added: 2 });
    writer("[excited] We did it, friends!");
    await assert.rejects(draftAudioTags(audioTagDraftSchema.parse({ text: "We did it!" })), (e: unknown) => e instanceof UpstreamError && /changed the words while adding tags/.test(e.message));
    writer("[excited] We did it! [Part 2]");
    await assert.rejects(draftAudioTags(audioTagDraftSchema.parse({ text: "We did it!" })), /changed the words/, "bracketed text that is no tag is not a tag added");
    writer(`[warm] ${"word ".repeat(398)}words.`);
    await assert.rejects(draftAudioTags(audioTagDraftSchema.parse({ text: `${"word ".repeat(398)}words.` })), (e: unknown) => e instanceof ValidationError && /over 2,000 characters/.test(e.message));
    // The text's own tags stay where they were; none goes inside other brackets; quotes around the draft come off.
    writer("[as if sharing a secret] Don't tell. [excited] It's a surprise.");
    await assert.rejects(draftAudioTags(audioTagDraftSchema.parse({ text: "[whispers] Don't tell. It's a surprise." })), /changed the tags already in the text/);
    writer("[whispers] Don't tell. [excited] It's a surprise.");
    assert.equal((await draftAudioTags(audioTagDraftSchema.parse({ text: "[whispers] Don't tell. It's a surprise." }))).added, 1);
    writer("See [Section [laughs] 4].");
    await assert.rejects(draftAudioTags(audioTagDraftSchema.parse({ text: "See [Section 4]." })), /inside other brackets/);
    writer("“[warm] Welcome aboard.”");
    assert.equal((await draftAudioTags(audioTagDraftSchema.parse({ text: "Welcome aboard." }))).text, "[warm] Welcome aboard.");
    writer(async () => {
      throw new Error("Claude declined to add tags to this text.");
    });
    await assert.rejects(draftAudioTags(audioTagDraftSchema.parse({ text: "Hi." })), /^Error: Claude declined to add tags to this text; try again$|declined to add tags to this text; try again/);
  });
});
