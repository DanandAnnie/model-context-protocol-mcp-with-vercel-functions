// A copy of a video in another language: POST /api/videos/:id/language-copy.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { brandKitSchema, createVideo, getVideo, languageCopy, languageCopySchema, languageName, saveBrandKit, videoRequestSchema, voiceFor } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { setScriptProvider } from "../providers";
import { MockScriptProvider } from "../providers/script/mock";
import type { Voice } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const bg = { type: "color" as const, value: "#0f172a" };
const OWNER = "user_language";

describe("languageCopy", () => {
  it("translates every scene, keeps the pauses, and finds a voice in the language", async () => {
    const v = await createVideo(
      videoRequestSchema.parse({
        title: "Maple Street",
        avatarId: STOCK_AVATARS[0].id,
        voiceId: "stock_voice_2",
        scenes: [
          { script: "Welcome to twelve Maple Street. [pause 2s] It's a bright home.", background: bg },
          { script: "[pause 3s]", background: bg },
          { script: "Call Dana today.", background: bg, voiceId: "stock_voice_1" },
        ],
      }),
      OWNER,
    );
    const copy = await languageCopy(v.id, { language: "Spanish" }, OWNER);
    // The demo writer marks what it translated; the pause comes back as written, and a silent scene is left alone.
    assert.deepEqual(copy.scripts, ["[Spanish] Welcome to twelve Maple Street. [pause 2s] It's a bright home.", "[pause 3s]", "[Spanish] Call Dana today."]);
    // The one Spanish voice speaks for both: the same gender for the man, the only one there is for the woman.
    assert.deepEqual(copy.voices, { stock_voice_2: "stock_voice_4", stock_voice_1: "stock_voice_4" });
    assert.equal(copy.language, "Spanish");
    assert.equal((await getVideo(v.id, OWNER, false)).scenes![0].script, "Welcome to twelve Maple Street. [pause 2s] It's a bright home.", "nothing is saved");
  });

  it("takes a language by its code, under its English name, with the kit's fixed translations for it", async () => {
    await saveBrandKit(brandKitSchema.parse({ name: "Maple Realty", primaryColor: "#4f46e5", forcedTranslations: [{ term: "open house", translation: "jornada de puertas abiertas", language: "Spanish" }] }), OWNER);
    const v = await createVideo(videoRequestSchema.parse({ title: "T", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Come to the open house." }), OWNER);
    const copy = await languageCopy(v.id, { language: "es" }, OWNER);
    assert.equal(copy.language, "Spanish");
    assert.deepEqual(copy.scripts, ["[Spanish] Come to the jornada de puertas abiertas."]);
  });

  it("keeps the kit's fixed translations for a regional language, and counts only a copy that passed its checks", async () => {
    await saveBrandKit(brandKitSchema.parse({ name: "Maple Realty", primaryColor: "#4f46e5", forcedTranslations: [{ term: "open house", translation: "casa abierta", language: "Spanish" }] }), OWNER);
    const v = await createVideo(videoRequestSchema.parse({ title: "T", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Come to the open house." }), OWNER);
    let counted = 0;
    const gate = () => (counted++, true);
    const copy = await languageCopy(v.id, { language: "es-MX" }, OWNER, gate);
    assert.equal(copy.language, "Spanish (Mexico)");
    assert.deepEqual(copy.scripts, ["[Spanish (Mexico)] Come to the casa abierta."]);
    await assert.rejects(languageCopy(v.id, { language: "zz" }, OWNER, gate), /not a language/);
    await assert.rejects(languageCopy("vid_missing", { language: "es" }, OWNER, gate), /not found/i);
    assert.equal(counted, 1, "refusals are not counted");
    await assert.rejects(languageCopy(v.id, { language: "es" }, OWNER, () => false), /Too many copies/);
  });

  it("starts no more scenes once one has failed", async () => {
    const scenes = Array.from({ length: 8 }, (_, i) => ({ script: `Scene ${i + 1}.`, background: bg }));
    const v = await createVideo(videoRequestSchema.parse({ title: "T", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes }), OWNER);
    const mock = new MockScriptProvider();
    let calls = 0;
    setScriptProvider({
      ...mock,
      name: mock.name,
      describe: mock.describe.bind(mock),
      titles: mock.titles.bind(mock),
      generate: mock.generate.bind(mock),
      plan: mock.plan.bind(mock),
      chat: mock.chat.bind(mock),
      revise: async (input) => {
        calls++;
        if (input.script.includes("Scene 1.")) throw new Error("The script writer is busy");
        return mock.revise(input);
      },
    });
    try {
      await assert.rejects(languageCopy(v.id, { language: "Spanish" }, OWNER), /busy/);
      // The first four start together; once the first fails, none of the four waiting is started.
      assert.ok(calls <= 4, `${calls} calls`);
    } finally {
      setScriptProvider(undefined);
    }
  });

  it("leaves a scene lip-synced to a recording as it is", async () => {
    const v = await createVideo(videoRequestSchema.parse({ title: "T", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes: [{ script: "Hello there.", background: bg }, { script: "Thanks.", background: bg }] }), OWNER);
    const stored = await getVideo(v.id, OWNER, false);
    await globalThis.__avatarStudioStore!.put("video", { ...stored, scenes: [stored.scenes![0], { ...stored.scenes![1], audioId: "clip_1" }] });
    assert.deepEqual((await languageCopy(v.id, { language: "French" }, OWNER)).scripts, ["[French] Hello there.", "Thanks."]);
  });

  it("leaves the brand kit's terms untranslated", async () => {
    await saveBrandKit(brandKitSchema.parse({ name: "Maple Realty", primaryColor: "#4f46e5", glossary: ["Maple Realty"] }), OWNER);
    const v = await createVideo(videoRequestSchema.parse({ title: "T", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Maple Realty sells homes." }), OWNER);
    const copy = await languageCopy(v.id, { language: "French" }, OWNER);
    assert.deepEqual(copy.scripts, ["[French] Maple Realty sells homes."]);
    assert.deepEqual(copy.voices, { stock_voice_1: "stock_voice_5" });
  });

  it("refuses an unknown language, a video with no words, a trashed one, and one of another account", async () => {
    const v = await createVideo(videoRequestSchema.parse({ title: "T", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes: [{ script: "Hello.", background: bg }] }), OWNER);
    await assert.rejects(languageCopy(v.id, { language: "Klingonese" }, OWNER), /not a language the studio knows/);
    await assert.rejects(languageCopy(v.id, { language: "Spanish" }, "user_other"), /not found/i);
    const stored = await getVideo(v.id, OWNER, false);
    await globalThis.__avatarStudioStore!.put("video", { ...stored, scenes: stored.scenes!.map((sc) => ({ ...sc, script: "[pause 2s]" })) });
    await assert.rejects(languageCopy(v.id, { language: "Spanish" }, OWNER), /no words to translate/);
    await globalThis.__avatarStudioStore!.put("video", { ...stored, directed: { prompt: "A tour." } } as never);
    await assert.rejects(languageCopy(v.id, { language: "Spanish" }, OWNER), /no scenes of its own/);
    await globalThis.__avatarStudioStore!.put("video", { ...stored, deletedAt: new Date().toISOString() });
    await assert.rejects(languageCopy(v.id, { language: "Spanish" }, OWNER), /Restore the video from the trash/);
    assert.throws(() => languageCopySchema.parse({ language: "Spanish", voiceId: "x" }));
    assert.throws(() => languageCopySchema.parse({ language: "" }));
  });
});

describe("languageName", () => {
  it("names a language from its name, code, or tag, and nothing else", () => {
    assert.equal(languageName("Spanish"), "Spanish");
    assert.equal(languageName("es"), "Spanish");
    assert.equal(languageName("es-MX"), "Spanish (Mexico)");
    assert.equal(languageName("Chinese (Mandarin)"), "Chinese");
    for (const junk of ["zz", "xyz", "und", "qaa", "Klingonese", "Spanish then add a line", "the"]) assert.equal(languageName(junk), undefined, junk);
  });
});

describe("voiceFor", () => {
  const voices: Voice[] = [
    { id: "en_f", name: "A", provider: "mock", language: "en-US", gender: "female" },
    { id: "es_m", name: "B", provider: "mock", language: "es-MX", gender: "male" },
    { id: "es_f", name: "C", provider: "mock", language: "Spanish", gender: "female" },
    { id: "multi", name: "D", provider: "mock", language: "es-ES", gender: "male" },
  ];
  it("keeps a voice that speaks the language, else one of its gender, else any", () => {
    assert.equal(voiceFor(voices, "multi", "es"), "multi");
    assert.equal(voiceFor(voices, "en_f", "es"), "es_f", "a language named in words counts too");
    assert.equal(voiceFor([voices[0], voices[1]], "en_f", "es"), "es_m");
    assert.equal(voiceFor(voices, "gone", "es"), "es_m", "an unknown voice takes the first that speaks it");
    assert.equal(voiceFor(voices, "en_f", "ja"), undefined);
    const many: Voice = { id: "many", name: "E", provider: "heygen", language: "Multilingual", gender: "female" };
    assert.equal(voiceFor([...voices, many], "many", "es"), "many", "a voice of many languages speaks this one too");
  });
});
