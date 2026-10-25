// Brand glossary: terms a translation keeps exactly as written.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_GLOSSARY_TERMS, parseGlossary, protectTerms } from "../glossary";
import { setScriptProvider } from "../providers";
import type { ScriptProvider } from "../providers/types";
import { addSubtitles, brandKitSchema, createVideo, reviseScript, saveBrandKit, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

/** A translator that rewrites every word it is given, except tokens, so anything not protected visibly changes. */
const seen: string[] = [];
const aggressive: ScriptProvider = {
  name: "aggressive",
  generate: async () => "",
  chat: async () => "",
  revise: async ({ script, action }) => {
    seen.push(script);
    if (action !== "translate") return script.toUpperCase();
    return script.replace(/\[\[\s*[PT]\d+\s*\]\]|[\p{L}\p{N}]+/gu, (w) => (w.startsWith("[[") ? w : "xx"));
  },
};

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  seen.length = 0;
  setScriptProvider(aggressive);
});
afterEach(() => setScriptProvider(undefined));

describe("brand glossary", () => {
  it("swaps whole terms for tokens, longest first, ignoring case, and puts back the source's own spelling", () => {
    const { text, restore } = protectTerms("Try ACME Cloud today. Acme is here; acmeville is not. [pause 1s] Acme!", ["acme", "Acme Cloud", "ACME"]);
    assert.equal(text, "Try [[T1]] today. [[T2]] is here; acmeville is not. [pause 1s] [[T3]]!");
    assert.equal(restore("Prueba [[T1]] hoy. [[T2]] está aquí. [[T3]]!"), "Prueba ACME Cloud hoy. Acme está aquí. Acme!");
    assert.equal(restore("Sin marcas."), "Sin marcas.", "a dropped token is simply gone");
    assert.equal(restore("[[T9]] extra"), " extra", "a token the source never had is left out");
    // Pause markers and the pause tokens they become are never taken for a term.
    assert.equal(protectTerms("[[P1]] pause [pause]", ["pause", "P1"]).text, "[[P1]] [[T1]] [pause]");
    assert.equal(protectTerms("No terms here", []).text, "No terms here");
    assert.equal(protectTerms("C++ and a.b", ["C++", "a.b"]).text, "[[T1]] and [[T2]]", "terms are matched literally");
  });

  it("reads one term per line without blanks or repeats, and the kit keeps at most 50 distinct terms", () => {
    assert.deepEqual(parseGlossary(" Acme Cloud \n\nacme cloud\nNimbus\n"), ["Acme Cloud", "Nimbus"]);
    const base = { primaryColor: "#4f46e5" };
    assert.deepEqual(brandKitSchema.parse({ ...base, glossary: ["Nimbus", "nimbus", " Acme "] }).glossary, ["Nimbus", "Acme"]);
    assert.equal(brandKitSchema.safeParse({ ...base, glossary: Array.from({ length: MAX_GLOSSARY_TERMS + 1 }, (_, i) => `T${i}`) }).success, false);
    assert.equal(brandKitSchema.safeParse({ ...base, glossary: ["x".repeat(61)] }).success, false);
    assert.equal(brandKitSchema.safeParse({ ...base, glossary: ["  "] }).success, false);
  });

  it("keeps the owner's terms through script translation, pauses included, and only for translation", async () => {
    await saveBrandKit(brandKitSchema.parse({ primaryColor: "#4f46e5", glossary: ["Acme Cloud", "Nimbus"] }), "u-brand");
    const script = "Meet Acme Cloud. [pause 2s] Nimbus does the rest.";
    assert.equal(await reviseScript({ script, action: "translate", language: "Spanish" }, "u-brand"), "xx Acme Cloud. [pause 2s] Nimbus xx xx xx.");
    assert.equal(seen[0], "Meet [[T1]]. [[P1]] [[T2]] does the rest.", "the provider never sees the terms");
    // Someone without the kit gets their script translated in full; other actions leave terms to the model.
    assert.equal(await reviseScript({ script, action: "translate", language: "Spanish" }, "u-other"), "xx xx xx. [pause 2s] xx xx xx xx.");
    assert.equal(await reviseScript({ script, action: "polish" }, "u-brand"), "MEET ACME CLOUD. [pause 2s] NIMBUS DOES THE REST.");
  });

  it("keeps the owner's terms in subtitle translations", async () => {
    await saveBrandKit(brandKitSchema.parse({ primaryColor: "#4f46e5", glossary: ["Nimbus"] }), "u-brand");
    const v = await createVideo(videoRequestSchema.parse({ title: "Launch", script: "Nimbus ships today.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), "u-brand");
    const done = await addSubtitles(v.id, "German", "u-brand");
    assert.equal(done.subtitles?.German, "Nimbus xx xx.");
  });
});
