// Pause markers in scripts: parsing, what each renderer receives, and what captions and estimates make of them.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_PAUSE_SEC, hasPauses, pauseSeconds, protectPauses, splitAtPauses, stripPauses, toSsml, withBreakTags } from "../pauses";
import { buildCues } from "../captions";
import { estimateSeconds, wordCount } from "../client";
import { applyPronunciations } from "../pronounce";
import { addSubtitles, captionDurationSec, createVideo, filterVideos, videoQuerySchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const script = "Welcome home. [pause] Let's look around [PAUSE 2.5s] the kitchen. [ pause 0,5s ]";

describe("pause markers", () => {
  it("are read in any case, with or without a length, and capped", () => {
    assert.equal(hasPauses(script), true);
    assert.equal(hasPauses("No pause here, just the word pause."), false, "the bare word is speech");
    assert.equal(pauseSeconds(script), 4);
    assert.equal(pauseSeconds("[pause 30s]"), MAX_PAUSE_SEC);
    assert.equal(stripPauses(script), "Welcome home. Let's look around the kitchen.");
    assert.equal(stripPauses("Hi [pause], there"), "Hi, there", "no stray space before punctuation");
    assert.deepEqual(splitAtPauses("A [pause 2s] B").map((p) => p.pauseSec), [2, 0]);
  });

  it("become break tags for HeyGen and ElevenLabs and SSML for Microsoft voices", () => {
    assert.equal(withBreakTags(script), `Welcome home. <break time="1s"/> Let's look around <break time="2.5s"/> the kitchen. <break time="0.5s"/>`);
    assert.equal(toSsml("A & B <c> [pause 2s] d"), `A &amp; B &lt;c&gt; <break time="2s"/> d`, "a fragment: D-ID wraps it in <speak> itself");
    // A pause longer than an engine's longest break becomes several breaks that add up to it.
    assert.equal(withBreakTags("Wait [pause 8s] now"), `Wait <break time="3s"/> <break time="3s"/> <break time="2s"/> now`);
    assert.equal(toSsml("Wait [pause 8s] now"), `Wait <break time="5s"/> <break time="3s"/> now`);
    assert.equal(withBreakTags("No markers <here>"), "No markers <here>", "text without markers is handed over as it was");
  });

  it("cannot make up a scene on their own", () => {
    const scene = (script: string) => ({ script, background: { type: "color", value: "#000000" } });
    assert.match(JSON.stringify(videoRequestSchema.safeParse({ title: "T", avatarId: "a", voiceId: "v", scenes: [scene("[pause 3s]")] }).error?.issues), /needs some words/);
    assert.match(JSON.stringify(videoRequestSchema.safeParse({ title: "T", avatarId: "a", voiceId: "v", script: "[pause]" }).error?.issues), /needs some words/);
  });

  it("are never rewritten by a pronunciation rule", () => {
    assert.equal(applyPronunciations("Pause here [pause 2s] please", [{ word: "pause", sayAs: "paws" }]), "paws here [pause 2s] please");
  });

  it("leave gaps between caption lines and count toward estimates, not words", () => {
    const cues = buildCues("First line. [pause 4s] Second line.", 10);
    assert.deepEqual(cues.map((c) => c.text), ["First line.", "Second line."]);
    assert.equal(cues[0].startMs, 0);
    assert.equal(cues[1].startMs - cues[0].endMs, 4000, "the pause shows no caption");
    assert.equal(cues[1].endMs, 10000);
    // A pause before the first line delays it; one after the last ends the captions that much early.
    assert.deepEqual(buildCues("Hello there. [pause 2s]", 6).map((c) => [c.startMs, c.endMs]), [[0, 4000]]);
    const tail = buildCues("One two. Three four. [pause 2s]", 6);
    assert.deepEqual(tail.map((c) => [c.startMs, c.endMs]), [[0, 2000], [2000, 4000]], "lines are not stretched over the silence");
    const led = buildCues("[pause 2s] Hello there. [pause 3s]", 6);
    assert.deepEqual([led[0].startMs, led[0].endMs], [1200, 4200], "five seconds of pauses squeezed into three");
    // Pauses longer than the render are squeezed to half of it so every line still shows.
    const squeezed = buildCues("A. [pause 10s] B.", 4);
    assert.equal(squeezed[1].startMs - squeezed[0].endMs, 2000);
    assert.equal(wordCount(script), 7);
    assert.equal(estimateSeconds("one two three four five [pause 3s]"), 5);
    assert.equal(captionDurationSec({ script: "one two three four five [pause 3s]", speed: 1 }), 5);
  });

  it("survive a rewrite as tokens the model leaves alone", () => {
    const { text, restore } = protectPauses("Hi. [pause 2s] Bye. [PAUSE]");
    assert.equal(text, "Hi. [[P1]] Bye. [[P2]]");
    assert.equal(restore("Hola. [[P1]] Adiós. [[P2]] [[P9]]"), "Hola. [pause 2s] Adiós. [PAUSE]", "a made-up token is dropped");
    assert.equal(restore("Hola. Adiós."), "Hola. Adiós.", "a marker the model left out is gone");
  });

  it("come back from the writer's Improve actions as written", async () => {
    const { reviseScript } = await import("../services");
    assert.equal(await reviseScript({ script: "hi. [pause 2s] bye.", action: "polish" }), "Hi. [pause 2s] bye.");
  });

  it("keep their gaps in translated subtitles, stay out of library search, and stretch the demo render", async () => {
    const v = await createVideo(videoRequestSchema.parse({ title: "Tour", script: "Welcome home. [pause 3s] Here is the kitchen.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }));
    // The demo renderer encodes the length in its job id: six words at 2.5 a second, plus three seconds.
    assert.match(v.providerJobId ?? "", /_5$/);
    let asked = "";
    await addSubtitles(v.id, "Spanish", undefined, async (text) => {
      asked = text;
      return "Bienvenido.";
    });
    assert.equal(asked, "Welcome home. [pause 3s] Here is the kitchen.", "the translator keeps the markers so the track keeps its gaps");
    assert.equal(filterVideos([v], videoQuerySchema.parse({ q: "pause" })).length, 0, "searching for the word does not find markers");
  });

  it("reach HeyGen as break tags and D-ID as SSML or break tags by voice engine", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const { DidAvatarProvider } = await import("../providers/avatar/did");
    const ava = { ...STOCK_AVATARS[0], id: "ava_hg", provider: "heygen", source: "provider" as const };
    const emma = { ...STOCK_VOICES[0], id: "emma_hg", provider: "heygen" };
    const req = videoRequestSchema.parse({ title: "Tour", script: "Hi & welcome. [pause 2s] Come in.", avatarId: ava.id, voiceId: emma.id });
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { scenes: Array<{ input: { script?: string } }> } | null = null;
    (heygen as unknown as { client: { generateVideo: (b: unknown) => Promise<unknown> } }).client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    await heygen.createVideo(req, ava, emma, { avatars: { [ava.id]: ava }, voices: { [emma.id]: emma }, clips: {} });
    assert.equal(sent!.scenes[0].input.script, `Hi & welcome. <break time="2s"/> Come in.`);

    const did = new DidAvatarProvider("key");
    const bodies: Array<{ script: Record<string, unknown> }> = [];
    (did as unknown as { request: (p: string, i: RequestInit) => Promise<unknown> }).request = async (_p, init) => {
      bodies.push(JSON.parse(init.body as string));
      return { id: "talk_1" };
    };
    const portrait = { ...ava, imageUrl: "https://cdn.example.com/a.png" };
    await did.createVideo(req, portrait, { ...emma, provider: "mock", gender: "female" });
    assert.deepEqual(bodies[0].script, { type: "text", input: `Hi &amp; welcome. <break time="2s"/> Come in.`, ssml: true, provider: { type: "microsoft", voice_id: "en-US-JennyNeural" } });
    await did.createVideo(req, portrait, { ...emma, id: "el_1", provider: "elevenlabs" });
    assert.equal(bodies[1].script.input, `Hi & welcome. <break time="2s"/> Come in.`);
    assert.equal(bodies[1].script.ssml, true);
    await did.createVideo(videoRequestSchema.parse({ ...req, script: "No pauses." }), portrait, emma);
    assert.deepEqual(bodies[2].script.input, "No pauses.", "a script without markers is sent as before");
  });
});
