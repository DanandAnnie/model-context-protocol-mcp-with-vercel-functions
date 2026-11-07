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
const termsSeen: Array<string[] | undefined> = [];
const aggressive: ScriptProvider = {
  name: "aggressive",
  generate: async () => "",
  chat: async () => "",
  describe: async () => "",
  titles: async () => [],
  plan: async () => ({ title: "", orientation: "landscape", scenes: [] }),
  revise: async ({ script, action, terms }) => {
    seen.push(script);
    termsSeen.push(terms);
    if (action !== "translate") return script.toUpperCase();
    return script.replace(/\[\[\s*[PT]\d+\s*\]\]|[\p{L}\p{N}]+/gu, (w) => (w.startsWith("[[") ? w : "xx"));
  },
};

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  seen.length = 0;
  termsSeen.length = 0;
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

  it("finds terms beside unspaced scripts but never inside a longer word, and takes the token back however the model writes it", () => {
    // Chinese, Japanese, and Thai put no spaces between words, so a neighbour from them is a boundary.
    assert.equal(protectTerms("用Nimbus上传", ["Nimbus"]).text, "用[[T1]]上传");
    assert.equal(protectTerms("Nimbusを使って", ["Nimbus"]).text, "[[T1]]を使って");
    assert.equal(protectTerms("ใช้Nimbusได้", ["Nimbus"]).text, "ใช้[[T1]]ได้");
    assert.equal(protectTerms("雲雀クラウドで", ["雲雀クラウド"]).text, "[[T1]]で", "a term in such a script matches inside running text");
    // A combining mark, an accented letter, or an underscore continues the word.
    assert.equal(protectTerms("कमी", ["कम"]).text, "कमी");
    assert.equal(protectTerms("Acmeé and Acme", ["Acme"]).text, "Acmeé and [[T1]]");
    assert.equal(protectTerms("@acme_cloud and @acme", ["acme"]).text, "@acme_cloud and @[[T1]]");
    // Decomposed text and terms are compared in their composed form.
    assert.equal(protectTerms("Visit Cafe\u0301 Luna", ["Caf\u00e9 Luna"]).text, "Visit [[T1]]");
    const { text, terms, restore } = protectTerms("Acme Cloud and Nimbus", ["Nimbus", "Acme Cloud"]);
    assert.equal(text, "[[T1]] and [[T2]]");
    assert.deepEqual(terms, ["Acme Cloud", "Nimbus"], "what each token stands for, in order");
    assert.equal(restore("[[t1]] y [[ T 2 ]]"), "Acme Cloud y Nimbus", "case and spacing do not matter");
    assert.equal(restore("[T1] y [T2]"), "Acme Cloud y Nimbus", "nor single brackets");
    // Text that already looks like a token is kept as written instead of being taken for one.
    const literal = protectTerms("See [[T1]] in the docs, then [t2] and Nimbus.", ["Nimbus"]);
    assert.equal(literal.restore(literal.text), "See [[T1]] in the docs, then [t2] and Nimbus.");
  });

  it("reads one term per line without blanks or repeats, and the kit keeps at most 50 distinct terms", () => {
    assert.deepEqual(parseGlossary(" Acme Cloud \n\nacme cloud\nNimbus\n"), ["Acme Cloud", "Nimbus"]);
    const base = { primaryColor: "#4f46e5" };
    assert.deepEqual(brandKitSchema.parse({ ...base, glossary: ["Nimbus", "nimbus", " Acme "] }).glossary, ["Nimbus", "Acme"]);
    assert.equal(brandKitSchema.safeParse({ ...base, glossary: Array.from({ length: MAX_GLOSSARY_TERMS + 1 }, (_, i) => `T${i}`) }).success, false);
    assert.equal(brandKitSchema.safeParse({ ...base, glossary: ["x".repeat(61)] }).success, false);
    assert.equal(brandKitSchema.safeParse({ ...base, glossary: ["  "] }).success, false);
    assert.equal(brandKitSchema.safeParse({ ...base, glossary: ["A"] }).success, false, "a one-letter term would hold back every article");
  });

  it("keeps the owner's terms through script translation, pauses included, and only for translation", async () => {
    await saveBrandKit(brandKitSchema.parse({ primaryColor: "#4f46e5", glossary: ["Acme Cloud", "Nimbus"] }), "u-brand");
    const script = "Meet Acme Cloud. [pause 2s] Nimbus does the rest.";
    assert.equal(await reviseScript({ script, action: "translate", language: "Spanish" }, "u-brand"), "xx Acme Cloud. [pause 2s] Nimbus xx xx xx.");
    assert.equal(seen[0], "Meet [[T1]]. [[P1]] [[T2]] does the rest.", "the script the provider gets carries tokens, not the terms");
    assert.deepEqual(termsSeen[0], ["Acme Cloud", "Nimbus"], "and it is told what each token stands for");
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

describe("forced translations", () => {
  it("reads rules one per line, with an optional language, and reports lines it cannot read", async () => {
    const { parseForcedTranslations, formatForcedTranslations } = await import("../glossary");
    const parsed = parseForcedTranslations("CEO = Geschäftsführer [German]\n\nfree trial = essai gratuit\nno equals here\nceo = PDG [german]\n = x\nCEO = Directeur [French]");
    assert.deepEqual(parsed.rules, [
      { term: "CEO", translation: "Geschäftsführer", language: "German" },
      { term: "free trial", translation: "essai gratuit" },
      { term: "CEO", translation: "Directeur", language: "French" },
    ]);
    assert.deepEqual(parsed.bad, [4, 6], "line numbers count blank lines");
    // A bracket that names no language is pointed out, not kept as a rule that never applies.
    assert.deepEqual(parseForcedTranslations("Nimbus = Nimbus [beta]\nCEO = Jefe [Spanish (Mexico)]").badLanguage, [{ line: 1, language: "beta" }]);
    assert.equal(brandKitSchema.safeParse({ primaryColor: "#4f46e5", forcedTranslations: [{ term: "Acme", translation: "Acme [EU]" }] }).success, false, "a translation that would read back as a language is refused");
    assert.equal(formatForcedTranslations(parsed.rules), "CEO = Geschäftsführer [German]\nfree trial = essai gratuit\nCEO = Directeur [French]");
    assert.deepEqual(parseForcedTranslations(formatForcedTranslations(parsed.rules)).rules, parsed.rules, "what the page shows reads back the same");
    // The kit keeps the first of a repeated term and language and checks the lengths.
    const kit = brandKitSchema.parse({ primaryColor: "#4f46e5", forcedTranslations: [{ term: "CEO", translation: "A", language: "German" }, { term: "ceo", translation: "B", language: "GERMAN" }, { term: "CEO", translation: "C" }] });
    assert.deepEqual(kit.forcedTranslations?.map((r) => r.translation), ["A", "C"]);
    assert.equal(brandKitSchema.safeParse({ primaryColor: "#4f46e5", forcedTranslations: [{ term: "C", translation: "x" }] }).success, false);
    assert.equal(brandKitSchema.safeParse({ primaryColor: "#4f46e5", forcedTranslations: [{ term: "CEO", translation: "x".repeat(81) }] }).success, false);
  });

  it("picks the rules for a language: its own over every language's, its base language too", async () => {
    const { forcedFor } = await import("../glossary");
    const rules = [
      { term: "CEO", translation: "chief" },
      { term: "ceo", translation: "Geschäftsführer", language: "German" },
      { term: "free trial", translation: "prueba gratis", language: "Spanish" },
      { term: "free trial", translation: "prueba sin costo", language: "Spanish (Mexico)" },
    ];
    assert.deepEqual(forcedFor(rules, "German"), [{ term: "ceo", translation: "Geschäftsführer" }]);
    assert.deepEqual(forcedFor(rules, "spanish"), [{ term: "CEO", translation: "chief" }, { term: "free trial", translation: "prueba gratis" }]);
    assert.deepEqual(forcedFor(rules, "Spanish (Mexico)"), [{ term: "CEO", translation: "chief" }, { term: "free trial", translation: "prueba sin costo" }]);
    assert.deepEqual(forcedFor(rules, "Spanish (Spain)"), [{ term: "CEO", translation: "chief" }, { term: "free trial", translation: "prueba gratis" }], "a regional rule is not another region's");
    // Whatever the order: a region's rule never reaches the base language or another region.
    const reversed = [rules[3], rules[2]];
    assert.deepEqual(forcedFor(reversed, "Spanish (Spain)"), [{ term: "free trial", translation: "prueba gratis" }]);
    assert.deepEqual(forcedFor(reversed, "Spanish"), [{ term: "free trial", translation: "prueba gratis" }]);
    assert.deepEqual(forcedFor([rules[3]], "Spanish"), []);
    assert.deepEqual(forcedFor([rules[3]], "spanish (mexico)"), [{ term: "free trial", translation: "prueba sin costo" }]);
    assert.deepEqual(forcedFor(rules, "French"), [{ term: "CEO", translation: "chief" }]);
    assert.deepEqual(forcedFor(undefined, "French"), []);
  });

  it("puts each rule's translation where its term stood, and tells the model what the token stands for", async () => {
    await saveBrandKit(brandKitSchema.parse({ primaryColor: "#4f46e5", glossary: ["Nimbus"], forcedTranslations: [{ term: "CEO", translation: "Geschäftsführer", language: "German" }, { term: "free trial", translation: "Testphase" }] }), "u-forced");
    const script = "Our CEO says: start a free trial of Nimbus.";
    assert.equal(await reviseScript({ script, action: "translate", language: "German" }, "u-forced"), "xx Geschäftsführer xx: xx xx Testphase xx Nimbus.");
    assert.deepEqual(termsSeen[0], ["Geschäftsführer", "Testphase", "Nimbus"]);
    // In another language only the rule for every language applies.
    assert.equal(await reviseScript({ script, action: "translate", language: "French" }, "u-forced"), "xx xx xx: xx xx Testphase xx Nimbus.");
    // A translation that names no language goes into English, and English rules apply to it.
    await saveBrandKit(brandKitSchema.parse({ primaryColor: "#4f46e5", forcedTranslations: [{ term: "Kunde", translation: "customer", language: "English" }] }), "u-en");
    assert.equal(await reviseScript({ script: "Der Kunde.", action: "translate" }, "u-en"), "xx customer.");
    // A term matched in another case form still comes back as its translation.
    assert.equal(await reviseScript({ script: "Our ceo says.", action: "translate", language: "German" }, "u-forced"), "xx Geschäftsführer xx.");
    // Subtitle languages follow the same rules.
    const v = await createVideo(videoRequestSchema.parse({ title: "Launch", script, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), "u-forced");
    const done = await addSubtitles(v.id, "German", "u-forced");
    assert.equal(done.subtitles?.German, "xx Geschäftsführer xx: xx xx Testphase xx Nimbus.");
  });
});
