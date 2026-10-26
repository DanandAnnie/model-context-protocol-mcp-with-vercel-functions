// Dubbing one video into several languages in one request.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_TRANSLATION_LANGUAGES, createTranslations, listTranslations, translationBatchSchema } from "../services";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const base = { title: "Walkthrough", sourceVideoUrl: "https://cdn.example.com/v.mp4" };

describe("multi-language translation", () => {
  it("accepts one language or a list, ignores repeats without regard to case, and caps the list", () => {
    assert.deepEqual(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish" }).languages, ["Spanish"]);
    assert.deepEqual(translationBatchSchema.parse({ ...base, targetLanguages: ["French", "german", "french", "German"] }).languages, ["French", "german"]);
    assert.equal(translationBatchSchema.safeParse({ ...base }).success, false, "a language is required");
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguages: [] }).success, false);
    const six = ["English", "Spanish", "French", "German", "Italian", "Portuguese"];
    assert.equal(six.length, MAX_TRANSLATION_LANGUAGES + 1);
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguages: six }).success, false);
  });

  it("starts one job per language, each titled with its language", async () => {
    const made = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["French", "German", "Italian"] }), "u-dub");
    assert.deepEqual(made.map((t) => [t.title, t.targetLanguage, t.status]), [
      ["Walkthrough (French)", "French", "processing"],
      ["Walkthrough (German)", "German", "processing"],
      ["Walkthrough (Italian)", "Italian", "processing"],
    ]);
    assert.equal((await listTranslations("u-dub")).length, 3);
    // A single language keeps the title as typed.
    const [one] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish" }), "u-dub");
    assert.equal(one.title, "Walkthrough");
    assert.equal((await listTranslations("someone-else")).length, 0);
  });

  it("passes voice-only and the speaker count to every dub, and HeyGen gets them as its own fields", async () => {
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", speakers: 0 }).success, false);
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", speakers: 11 }).success, false);
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", speakers: 1.5 }).success, false);
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", speakers: "2" }).success, false, "a number, not a string");
    const unset = translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", speakers: null, audioOnly: null });
    assert.equal("speakers" in unset || "audioOnly" in unset, false, "null means not set");
    const made = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["French", "German"], audioOnly: true, speakers: 2 }), "u-opt");
    assert.deepEqual(made.map((t) => [t.audioOnly, t.speakers]), [[true, 2], [true, 2]]);
    const [plain] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", audioOnly: false }), "u-opt");
    assert.equal("audioOnly" in plain, false, "a lip-synced dub stores no flag");
    assert.equal("speakers" in plain, false);

    const { HeyGenTranslateProvider } = await import("../providers/translate/heygen");
    const heygen = new HeyGenTranslateProvider("key");
    const bodies: Array<Record<string, unknown>> = [];
    (heygen as unknown as { client: { createTranslation: (b: Record<string, unknown>) => Promise<unknown> } }).client.createTranslation = async (b) => {
      bodies.push(b);
      return { video_translation_ids: ["vt_1"] };
    };
    await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T", audioOnly: true, speakers: 2 });
    await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T" });
    assert.deepEqual([bodies[0].translate_audio_only, bodies[0].speaker_num], [true, 2]);
    assert.equal("translate_audio_only" in bodies[1] || "speaker_num" in bodies[1], false, "left to HeyGen's defaults");
  });

  it("dubs at speed or precision, without the music or with cleaner speech, through HeyGen's v3 translations", async () => {
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", quality: "best" }).success, false);
    const defaults = translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", quality: "speed", removeMusic: false, enhanceSpeech: null });
    assert.equal("quality" in defaults || "removeMusic" in defaults || "enhanceSpeech" in defaults, false, "defaults are stored as no field");
    const made = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["French", "German"], quality: "precision", removeMusic: true, enhanceSpeech: true }), "u-q");
    assert.deepEqual(made.map((t) => [t.quality, t.removeMusic, t.enhanceSpeech]), [["precision", true, true], ["precision", true, true]]);

    const { HeyGenTranslateProvider } = await import("../providers/translate/heygen");
    const heygen = new HeyGenTranslateProvider("key");
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let status: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const data = init?.method === "POST" ? { video_translation_ids: ["vt_9"] } : status;
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const { providerJobId } = await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T", quality: "precision", removeMusic: true, enhanceSpeech: true });
      assert.equal(providerJobId, "vt_9");
      assert.equal(calls[0].url, "https://api.heygen.com/v3/video-translations");
      assert.deepEqual(calls[0].body, { video: { type: "url", url: base.sourceVideoUrl }, output_languages: ["French"], mode: "precision", title: "T", disable_music_track: true, enable_speech_enhancement: true });
      await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T" });
      assert.equal(calls[1].body?.mode, "speed");
      assert.equal("disable_music_track" in (calls[1].body ?? {}) || "enable_speech_enhancement" in (calls[1].body ?? {}), false);

      status = { status: "running" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "processing" });
      assert.equal(calls.at(-1)?.url, "https://api.heygen.com/v3/video-translations/vt_9");
      status = { status: "pending" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "queued" });
      status = { status: "completed", video_url: "https://files.heygen.ai/v.mp4", srt_caption_url: "https://files.heygen.ai/v.srt", vtt_caption_url: "https://files.heygen.ai/v.vtt" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "completed", videoUrl: "https://files.heygen.ai/v.mp4", captionUrls: { srt: "https://files.heygen.ai/v.srt", vtt: "https://files.heygen.ai/v.vtt" } });
      status = { status: "completed", video_url: "https://files.heygen.ai/v.mp4" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "completed", videoUrl: "https://files.heygen.ai/v.mp4" }, "no caption files, no field");
      status = { status: "failed", failure_message: "Unsupported audio" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "failed", error: "Unsupported audio" });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(heygen.parseWebhook({ event_type: "video_translate.success", event_data: { video_translation_id: "vt_9", video_url: "https://x/v.mp4" } }), { providerJobId: "vt_9", update: { status: "completed", videoUrl: "https://x/v.mp4" } });
  });

  it("picks up a dub's subtitle files when HeyGen's completion callback arrives", async () => {
    const { config } = await import("../config");
    const { getStore } = await import("../store");
    const { applyTranslationWebhook } = await import("../services");
    const original = config.heygenApiKey;
    (config as { heygenApiKey?: string }).heygenApiKey = "key";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { status: "completed", video_url: "https://files.heygen.ai/v.mp4", vtt_caption_url: "https://files.heygen.ai/v.vtt" } }), { status: 200 })) as typeof fetch;
    try {
      await getStore().put("translation", { id: "tr_w", ownerId: "u-w", title: "T", sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", status: "processing", provider: "heygen", providerJobId: "vt_w", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
      const done = await applyTranslationWebhook("heygen", { event_type: "video_translate.success", event_data: { video_translation_id: "vt_w", url: "https://files.heygen.ai/v.mp4" } });
      assert.equal(done?.status, "completed");
      assert.deepEqual(done?.captionUrls, { vtt: "https://files.heygen.ai/v.vtt" });
      // A status read that fails still completes the dub from the callback alone.
      globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
      await getStore().put("translation", { id: "tr_x", ownerId: "u-w", title: "T", sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", status: "processing", provider: "heygen", providerJobId: "vt_x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
      const alone = await applyTranslationWebhook("heygen", { event_type: "video_translate.success", event_data: { video_translation_id: "vt_x", url: "https://files.heygen.ai/x.mp4" } });
      assert.deepEqual([alone?.status, alone?.videoUrl, alone?.captionUrls], ["completed", "https://files.heygen.ai/x.mp4", undefined]);
    } finally {
      globalThis.fetch = realFetch;
      (config as { heygenApiKey?: string }).heygenApiKey = original;
    }
  });

  it("asks about each job at most every 15 seconds, oldest-asked first, and survives a store that fails", async () => {
    const { getStore } = await import("../store");
    const job = (id: string, createdAt: string, providerJobId: string) => ({ id, ownerId: "u-g", title: id, sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", status: "processing" as const, provider: "mock", providerJobId, createdAt, updatedAt: createdAt });
    // Five newer jobs the provider cannot answer for, and one older job that is done.
    for (let i = 0; i < 5; i++) await getStore().put("translation", job(`tr_stuck${i}`, `2026-01-0${i + 2}T00:00:00Z`, "not-a-mock-id"));
    await getStore().put("translation", job("tr_older", "2026-01-01T00:00:00Z", `mock_tr_${Date.now() - 60_000}`));
    assert.equal((await listTranslations("u-g")).find((t) => t.id === "tr_older")?.status, "processing", "five slots went to the newer jobs");
    assert.equal((await listTranslations("u-g")).find((t) => t.id === "tr_older")?.status, "completed", "the job not yet asked about goes first");
    // A store that fails while refreshing leaves the listing as stored instead of failing it.
    await getStore().put("translation", job("tr_fresh", "2026-02-01T00:00:00Z", `mock_tr_${Date.now() - 60_000}`));
    const store = getStore() as unknown as { put: (...a: unknown[]) => Promise<unknown> };
    const put = store.put.bind(store);
    store.put = async () => {
      throw new Error("store down");
    };
    try {
      assert.equal((await listTranslations("u-g")).find((t) => t.id === "tr_fresh")?.status, "processing");
    } finally {
      store.put = put;
    }
  });

  it("moves running jobs on from the list, keeps a newer write, and renews HeyGen's expiring links", async () => {
    const { config } = await import("../config");
    const { getStore } = await import("../store");
    const { applyTranslationWebhook } = await import("../services");
    const job = (id: string, extra: Record<string, unknown>) => ({ id, ownerId: "u-r", title: id, sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra });
    // Without webhooks, the polled list is what finishes a job.
    await getStore().put("translation", job("tr_mock", { status: "processing", provider: "mock", providerJobId: `mock_tr_${Date.now() - 60_000}` }));
    assert.equal((await listTranslations("u-r")).find((t) => t.id === "tr_mock")?.status, "completed");

    const original = config.heygenApiKey;
    (config as { heygenApiKey?: string }).heygenApiKey = "key";
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    let respond: (url: string) => Response = () => new Response("{}");
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return respond(String(url));
    }) as typeof fetch;
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    try {
      // A job started through v2 before the move is asked about through v2 when v3 does not know it.
      await getStore().put("translation", job("tr_v2", { status: "processing", provider: "heygen", providerJobId: "old_1" }));
      respond = (url) => (url.includes("/v3/") ? new Response("not found", { status: 404 }) : ok({ status: "success", url: "https://files.heygen.ai/old.mp4" }));
      const old = (await listTranslations("u-r")).find((t) => t.id === "tr_v2");
      assert.deepEqual([old?.status, old?.videoUrl], ["completed", "https://files.heygen.ai/old.mp4"]);
      assert.ok(urls.some((u) => u === "https://api.heygen.com/v2/video_translate/old_1"));

      // A finished HeyGen job over an hour old has its presigned links read again; a recent one does not.
      await getStore().put("translation", job("tr_old", { status: "completed", provider: "heygen", providerJobId: "vt_old", videoUrl: "https://files.heygen.ai/expired.mp4" }));
      respond = () => ok({ status: "completed", video_url: "https://files.heygen.ai/fresh.mp4", vtt_caption_url: "https://files.heygen.ai/fresh.vtt" });
      const renewed = (await listTranslations("u-r")).find((t) => t.id === "tr_old");
      assert.deepEqual([renewed?.videoUrl, renewed?.captionUrls?.vtt], ["https://files.heygen.ai/fresh.mp4", "https://files.heygen.ai/fresh.vtt"]);
      urls.length = 0;
      await listTranslations("u-r");
      assert.equal(urls.length, 0, "renewed links are trusted for an hour");

      // A poll whose answer arrives after a callback wrote the job leaves the callback's result alone.
      await getStore().put("translation", job("tr_race", { status: "processing", provider: "heygen", providerJobId: "vt_race" }));
      respond = () => {
        void getStore().put("translation", job("tr_race", { status: "completed", provider: "heygen", providerJobId: "vt_race", videoUrl: "https://files.heygen.ai/cb.mp4", captionUrls: { srt: "https://files.heygen.ai/cb.srt" }, updatedAt: "2026-02-01T00:00:00Z" }));
        return ok({ status: "completed", video_url: "https://files.heygen.ai/poll.mp4" });
      };
      const raced = (await listTranslations("u-r")).find((t) => t.id === "tr_race");
      assert.deepEqual([raced?.videoUrl, raced?.captionUrls], ["https://files.heygen.ai/cb.mp4", { srt: "https://files.heygen.ai/cb.srt" }]);

      // A failed renewal never writes an expired link back over one a parallel request just renewed.
      await getStore().put("translation", job("tr_par", { status: "completed", provider: "heygen", providerJobId: "vt_par", videoUrl: "https://files.heygen.ai/expired.mp4" }));
      respond = () => {
        void getStore().put("translation", job("tr_par", { status: "completed", provider: "heygen", providerJobId: "vt_par", videoUrl: "https://files.heygen.ai/renewed.mp4", updatedAt: new Date().toISOString() }));
        return new Response("busy", { status: 500 });
      };
      assert.equal((await listTranslations("u-r")).find((t) => t.id === "tr_par")?.videoUrl, "https://files.heygen.ai/renewed.mp4");

      // A job HeyGen knows under neither API fails instead of being asked about forever.
      await getStore().put("translation", job("tr_gone", { status: "processing", provider: "heygen", providerJobId: "gone_1" }));
      respond = () => new Response("not found", { status: 404 });
      assert.deepEqual((await listTranslations("u-r")).find((t) => t.id === "tr_gone")?.status, "failed");
      // A new job HeyGen does not know yet (it has only just been created) stays running and finishes later.
      await getStore().put("translation", job("tr_new", { status: "processing", provider: "heygen", providerJobId: "vt_new", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      assert.equal((await listTranslations("u-r")).find((t) => t.id === "tr_new")?.status, "processing");
      respond = () => ok({ status: "completed", video_url: "https://files.heygen.ai/new.mp4" });
      const { getTranslation } = await import("../services");
      assert.equal((await getTranslation("tr_new", "u-r")).status, "completed");

      // A late failure callback does not undo a finished dub.
      const late = await applyTranslationWebhook("heygen", { event_type: "video_translate.fail", event_data: { video_translation_id: "vt_race", msg: "late" } });
      assert.equal(late?.status, "completed");
    } finally {
      globalThis.fetch = realFetch;
      (config as { heygenApiKey?: string }).heygenApiKey = original;
    }
  });
});

describe("dubs that keep the brand glossary", () => {
  it("stores the kit's terms on each dub only when asked and the kit has some", async () => {
    const { saveBrandKit, brandKitSchema } = await import("../services");
    const [none] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", keepGlossary: true }), "u-gl");
    assert.equal("glossary" in none, false, "no kit, nothing to keep");
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#112233", glossary: ["Acme Cloud", "Zeno"] }), "u-gl");
    const made = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["French", "German"], keepGlossary: true }), "u-gl");
    assert.deepEqual(made.map((t) => t.glossary), [["Acme Cloud", "Zeno"], ["Acme Cloud", "Zeno"]]);
    const [off] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", keepGlossary: false }), "u-gl");
    assert.equal("glossary" in off, false);
    assert.equal("keepGlossary" in off, false, "the request flag is not stored; the terms are");
  });

  it("gives HeyGen one glossary per set of terms, found again by name when it already exists", async () => {
    const { HeyGenTranslateProvider } = await import("../providers/translate/heygen");
    const realFetch = globalThis.fetch;
    const calls: Array<{ method: string; url: string; body?: Record<string, unknown>; key?: string }> = [];
    let respond: (method: string, url: string) => Response = () => new Response("{}");
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, key: (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] });
      return respond(method, String(url));
    }) as typeof fetch;
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    try {
      const heygen = new HeyGenTranslateProvider("key");
      respond = (_m, url) => (url.endsWith("/brand-glossaries") ? ok({ id: "bg_1", name: "x" }) : ok({ video_translation_ids: ["vt_g"] }));
      await heygen.createTranslation({ ...base, targetLanguage: "French", glossary: ["Zeno", "Acme Cloud"] });
      const [create, dub] = calls;
      assert.equal(create.url, "https://api.heygen.com/v3/brand-glossaries");
      assert.deepEqual(create.body?.do_not_translate_terms, [{ term: "Acme Cloud" }, { term: "Zeno" }]);
      assert.match(String(create.body?.name), /^Avatar Studio terms [0-9a-f]{16}$/);
      assert.match(create.key ?? "", /^avatar-studio-glossary-[0-9a-f]{16}$/, "a retried create returns the same glossary");
      assert.equal(dub.body?.brand_glossary_id, "bg_1");

      // The same terms in any order reuse it; a dub without terms names none.
      calls.length = 0;
      await heygen.createTranslation({ ...base, targetLanguage: "German", glossary: ["Acme Cloud", "Zeno"] });
      await heygen.createTranslation({ ...base, targetLanguage: "German" });
      assert.deepEqual(calls.map((c) => [c.url.endsWith("/brand-glossaries"), c.body?.brand_glossary_id]), [[false, "bg_1"], [false, undefined]]);

      // A glossary made before (its name taken) is found by name, and proofreads use it too.
      calls.length = 0;
      respond = (m, url) => {
        if (url.endsWith("/brand-glossaries") && m === "POST") return new Response("name taken", { status: 409 });
        if (url.includes("/brand-glossaries?")) {
          const name = String(calls.find((c) => c.method === "POST" && c.url.endsWith("/brand-glossaries"))?.body?.name);
          return ok([{ id: "bg_other", name: "Someone else's" }, { id: "bg_2", name }]);
        }
        return ok({ proofread_ids: ["pr_g"] });
      };
      await heygen.createProofread({ ...base, targetLanguage: "Spanish", glossary: ["Nimbus"] });
      assert.equal(calls.at(-1)?.body?.brand_glossary_id, "bg_2");

      // A glossary deleted in HeyGen since: the dub naming it is refused, so it is made again and the dub sent once more.
      calls.length = 0;
      let made = 0;
      respond = (m, url) => {
        if (url.endsWith("/brand-glossaries") && m === "POST") return ok({ id: `bg_new${++made}` });
        const body = calls.at(-1)?.body;
        return body?.brand_glossary_id === "bg_2" ? new Response("glossary not found", { status: 404 }) : ok({ video_translation_ids: ["vt_again"] });
      };
      assert.deepEqual(await heygen.createTranslation({ ...base, targetLanguage: "Spanish", glossary: ["Nimbus"] }), { providerJobId: "vt_again" });
      assert.deepEqual(calls.map((c) => c.body?.brand_glossary_id ?? (c.url.endsWith("/brand-glossaries") ? "create" : "?")), ["bg_2", "create", "bg_new1"]);
      // A refusal for another reason (the glossary is fine) is not retried with a copy of it.
      calls.length = 0;
      respond = (m, url) => (url.endsWith("/brand-glossaries") && m === "POST" ? new Response("name taken", { status: 409 }) : url.includes("/brand-glossaries?") ? ok([{ id: "bg_new1", name: String(calls.find((c) => c.method === "POST" && c.url.endsWith("/brand-glossaries"))?.body?.name) }]) : new Response("bad video", { status: 400 }));
      await assert.rejects(heygen.createTranslation({ ...base, targetLanguage: "Spanish", glossary: ["Nimbus"] }), /400 bad video/);
      assert.equal(calls.filter((c) => !c.url.includes("brand-glossaries")).length, 1, "the glossary was still there, so the dub was not sent again");

      // The name is looked up through every page, and a create still in flight elsewhere is waited for.
      calls.length = 0;
      let lists = 0;
      respond = (m, url) => {
        if (url.endsWith("/brand-glossaries") && m === "POST") return new Response("key in use", { status: 409 });
        if (url.includes("/brand-glossaries?")) {
          lists++;
          const name = String(calls.find((c) => c.method === "POST" && c.url.endsWith("/brand-glossaries"))?.body?.name);
          if (lists === 1) return ok([{ id: "bg_a", name: "Other" }]); // first look: not made yet, no further page
          if (!url.includes("token=")) return new Response(JSON.stringify({ data: [{ id: "bg_b", name: "Other 2" }], next_token: "p2" }), { status: 200 });
          return ok([{ id: "bg_paged", name }]);
        }
        return ok({ video_translation_ids: ["vt_paged"] });
      };
      await heygen.createTranslation({ ...base, targetLanguage: "Spanish", glossary: ["Orbit 2"] });
      assert.equal(calls.at(-1)?.body?.brand_glossary_id, "bg_paged");
      assert.ok(calls.some((c) => c.url.includes("token=p2")), "the second page was read");

      // Any other failure fails the dub rather than dubbing without the terms.
      respond = () => new Response("down", { status: 500 });
      await assert.rejects(heygen.createTranslation({ ...base, targetLanguage: "Spanish", glossary: ["Orbit"] }), /500/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("dubs that follow the brand kit's forced translations", () => {
  it("stores the rules for each dub's language and sends them to HeyGen as forced_translations", async () => {
    const { saveBrandKit, brandKitSchema } = await import("../services");
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#112233", forcedTranslations: [{ term: "CEO", translation: "Geschäftsführer", language: "German" }, { term: "free trial", translation: "trial" }] }), "u-ft");
    // A kept term with a fixed translation in a dub's language is translated there, and kept elsewhere.
    const both = await (async () => {
      await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#112233", glossary: ["CEO", "Zeno"], forcedTranslations: [{ term: "ceo", translation: "Geschäftsführer", language: "German" }] }), "u-ft2");
      return createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["German", "French"], keepGlossary: true }), "u-ft2");
    })();
    assert.deepEqual(both.map((t) => [t.targetLanguage, t.glossary, t.forcedTranslations?.length ?? 0]), [
      ["German", ["Zeno"], 1],
      ["French", ["CEO", "Zeno"], 0],
    ]);
    const made = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["German", "French"], keepGlossary: true }), "u-ft");
    assert.deepEqual(made.map((t) => [t.targetLanguage, t.forcedTranslations, "glossary" in t]), [
      ["German", [{ term: "CEO", translation: "Geschäftsführer" }, { term: "free trial", translation: "trial" }], false],
      ["French", [{ term: "free trial", translation: "trial" }], false],
    ]);

    const { HeyGenTranslateProvider } = await import("../providers/translate/heygen");
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ data: String(url).endsWith("/brand-glossaries") ? { id: "bg_ft" } : { video_translation_ids: ["vt_ft"] } }), { status: 200 });
    }) as typeof fetch;
    try {
      const heygen = new HeyGenTranslateProvider("key");
      await heygen.createTranslation({ ...base, targetLanguage: "German", glossary: ["Zeno"], forcedTranslations: [{ term: "free trial", translation: "Testphase" }, { term: "CEO", translation: "Geschäftsführer" }] });
      assert.deepEqual(calls[0].body?.do_not_translate_terms, [{ term: "Zeno" }]);
      assert.deepEqual(calls[0].body?.forced_translations, [{ term: "CEO", translation: "Geschäftsführer" }, { term: "free trial", translation: "Testphase" }]);
      assert.equal(calls[1].body?.brand_glossary_id, "bg_ft");
      // Other rules for the same kept terms are another glossary, never a change to this one.
      const firstName = calls[0].body?.name;
      calls.length = 0;
      await heygen.createTranslation({ ...base, targetLanguage: "French", glossary: ["Zeno"], forcedTranslations: [{ term: "CEO", translation: "PDG" }] });
      assert.ok(calls[0].url.endsWith("/brand-glossaries"), "a new glossary for new rules");
      assert.notEqual(calls[0].body?.name, firstName);
      assert.deepEqual(calls[0].body?.forced_translations, [{ term: "CEO", translation: "PDG" }]);
      // A glossary of kept terms only is named as it was before rules existed: a digest of the sorted terms.
      calls.length = 0;
      await heygen.createTranslation({ ...base, targetLanguage: "French", glossary: ["Zulu", "Yak"] });
      const { createHash } = await import("node:crypto");
      assert.equal(calls[0].body?.name, `Avatar Studio terms ${createHash("sha256").update(JSON.stringify(["Yak", "Zulu"])).digest("hex").slice(0, 16)}`);
      assert.equal("forced_translations" in (calls[0].body ?? {}), false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
