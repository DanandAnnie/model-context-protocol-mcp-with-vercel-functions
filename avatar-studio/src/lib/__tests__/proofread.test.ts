// Proofreading a dub's translated lines before it is made.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { config } from "../config";
import { cuesToSrt, parseSrt } from "../captions";
import { ConflictError, NotFoundError, ValidationError, createTranslations, exportOwnerData, dubProofread, getTranslation, listTranslations, proofreadLinesSchema, proofreadSrt, saveProofreadLines, translationBatchSchema } from "../services";
import type { Translation } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const base = { title: "Walkthrough", sourceVideoUrl: "https://cdn.example.com/v.mp4" };
const stored = async (id: string) => (await getStore().get<Translation>("translation", id))!;

describe("SRT parsing", () => {
  it("reads back what it writes, and tolerates BOMs, CRLF, missing numbers, dots, and junk blocks", () => {
    const cues = [
      { startMs: 0, endMs: 2500, text: "Hola." },
      { startMs: 3_723_004, endMs: 3_725_000, text: "Dos\nlíneas" },
    ];
    assert.deepEqual(parseSrt(cuesToSrt(cues)), cues);
    const messy = "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nUno\r\n\r\nnot a cue\r\n\r\n00:00:03.5 --> 00:00:04.250\r\n  Tres  \r\n\r\n4\r\n00:00:05,000 --> 00:00:06,000\r\n\r\n";
    assert.deepEqual(parseSrt(messy), [
      { startMs: 1000, endMs: 2000, text: "Uno" },
      { startMs: 3500, endMs: 4250, text: "Tres" },
    ]);
  });
});

describe("proofread dubs", () => {
  it("translates the lines first, takes corrections, and dubs them from a secret SRT link", async () => {
    const [job] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", proofread: true }), "u-pr");
    assert.deepEqual([job.status, job.proofreadStage, job.proofread, job.providerJobId], ["processing", "preparing", true, undefined]);
    assert.ok(job.providerProofreadId?.startsWith("mock_pr_"));

    // Once the lines are translated the job holds them and waits.
    const ready = await getTranslation(job.id, "u-pr");
    assert.equal(ready.proofreadStage, "ready");
    assert.deepEqual(ready.proofreadCues?.map((c) => c.text), ["Hola y bienvenidos a Avatar Studio.", "En el próximo minuto te muestro cómo se hace un video.", "Empecemos."]);
    // Lines waiting on a person are not asked about again.
    const again = await getTranslation(job.id, "u-pr");
    assert.equal(again.updatedAt, ready.updatedAt);

    // Corrections keep one text per line; a different count or a blank line is refused.
    await assert.rejects(saveProofreadLines(job.id, proofreadLinesSchema.parse({ lines: ["Solo una"] }), "u-pr"), ConflictError);
    assert.equal(proofreadLinesSchema.safeParse({ lines: ["Hola", " ", "Fin"] }).success, false);
    await assert.rejects(saveProofreadLines(job.id, proofreadLinesSchema.parse({ lines: ["a", "b", "c"] }), "someone-else"), NotFoundError);
    const saved = await saveProofreadLines(job.id, proofreadLinesSchema.parse({ lines: ["Hola y bienvenidos a Avatar Studio.", "En un minuto te enseño cómo se hace un video.", "¡Empecemos!"] }), "u-pr");
    assert.equal(saved.proofreadCues?.[1].text, "En un minuto te enseño cómo se hace un video.");
    assert.equal(saved.proofreadCues?.[1].startMs, ready.proofreadCues?.[1].startMs, "timing stays as translated");
    // Someone who opened the lines before that save cannot overwrite it.
    await assert.rejects(dubProofread(job.id, proofreadLinesSchema.parse({ lines: ["x", "y", "z"], basedOn: ready.updatedAt }), "u-pr"), /changed since you opened them/);

    const dubbed = await dubProofread(job.id, undefined, "u-pr");
    assert.equal(dubbed.proofreadStage, undefined);
    assert.equal(dubbed.status, "processing");
    assert.ok(dubbed.providerJobId?.startsWith("mock_tr_"));
    assert.equal("proofreadToken" in dubbed, false, "the secret never reaches the browser");
    assert.equal((await listTranslations("u-pr")).some((t) => "proofreadToken" in t), false);
    assert.equal((await exportOwnerData("u-pr")).translation.some((t) => "proofreadToken" in t), false, "nor an export");

    // The provider reads the corrected lines with the job's secret, and only with it.
    const token = (await stored(job.id)).proofreadToken!;
    assert.ok(token.length >= 32);
    assert.match(await proofreadSrt(job.id, token), /¡Empecemos!/);
    await assert.rejects(proofreadSrt(job.id, "x".repeat(token.length)), NotFoundError);
    await assert.rejects(proofreadSrt(job.id, ""), NotFoundError);
    // Once the dub is under way the lines are closed.
    await assert.rejects(dubProofread(job.id, undefined, "u-pr"), ConflictError);
    await assert.rejects(saveProofreadLines(job.id, proofreadLinesSchema.parse({ lines: ["a", "b", "c"] }), "u-pr"), ConflictError);
  });

  it("starts one dub for two quick clicks, and a start that never finished opens the lines again", async () => {
    const [job] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "French", proofread: true }), "u-pr2");
    await getTranslation(job.id, "u-pr2");
    // The claim is a conditional write, so it holds across server instances too: the in-memory store only lets one win.
    const results = await Promise.allSettled([dubProofread(job.id, undefined, "u-pr2"), dubProofread(job.id, undefined, "u-pr2")]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);

    const [stuck] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "German", proofread: true }), "u-pr2");
    await getTranslation(stuck.id, "u-pr2");
    await getStore().put("translation", { ...(await stored(stuck.id)), proofreadStage: "dubbing", updatedAt: new Date().toISOString() });
    await assert.rejects(dubProofread(stuck.id, undefined, "u-pr2"), ConflictError);
    assert.equal((await getTranslation(stuck.id, "u-pr2")).proofreadStage, "dubbing");
    await getStore().put("translation", { ...(await stored(stuck.id)), updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    // The page shows the lines again, with a warning, and they can be dubbed.
    const shownAgain = await getTranslation(stuck.id, "u-pr2");
    assert.equal(shownAgain.proofreadStage, "ready");
    assert.match(shownAgain.error ?? "", /did not finish/);
    assert.ok((await dubProofread(stuck.id, proofreadLinesSchema.parse({ lines: ["a", "b", "c"], basedOn: shownAgain.updatedAt }), "u-pr2")).providerJobId);
  });

  it("needs a public https APP_URL before HeyGen is asked to proofread", async () => {
    const original = { key: config.heygenApiKey, url: config.publicAppUrl };
    const c = config as { heygenApiKey?: string; publicAppUrl?: string };
    c.heygenApiKey = "key";
    try {
      for (const url of [undefined, "http://studio.example.com", "https://localhost:3000"]) {
        c.publicAppUrl = url;
        await assert.rejects(createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", proofread: true }), "u-url"), ValidationError);
      }
      assert.equal((await listTranslations("u-url")).length, 0, "nothing was started");
    } finally {
      c.heygenApiKey = original.key;
      c.publicAppUrl = original.url;
    }
  });

  it("goes through HeyGen's proofread endpoints and keeps the lines open when the dub is refused", async () => {
    const original = config.heygenApiKey;
    const originalUrl = config.publicAppUrl;
    (config as { heygenApiKey?: string }).heygenApiKey = "key";
    (config as { publicAppUrl?: string }).publicAppUrl = "https://studio.example.com";
    const realFetch = globalThis.fetch;
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    let respond: (method: string, url: string) => Response = () => new Response("{}");
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return respond(method, String(url));
    }) as typeof fetch;
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    try {
      const { HeyGenTranslateProvider } = await import("../providers/translate/heygen");
      const heygen = new HeyGenTranslateProvider("key");
      respond = () => ok({ proofread_ids: ["pr_1"] });
      assert.deepEqual(await heygen.createProofread({ ...base, targetLanguage: "Spanish", quality: "precision", speakers: 2 }), { proofreadId: "pr_1" });
      assert.deepEqual(calls.at(-1), {
        method: "POST",
        url: "https://api.heygen.com/v3/video-translations/proofreads",
        body: { video: { type: "url", url: base.sourceVideoUrl }, output_languages: ["Spanish"], mode: "precision", title: "Walkthrough", speaker_num: 2 },
      });

      const job = { id: "tr_hg", ownerId: "u-hg", ...base, targetLanguage: "Spanish", proofread: true, status: "processing" as const, provider: "heygen", providerProofreadId: "pr_1", proofreadStage: "preparing" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await getStore().put("translation", job);
      respond = () => ok({ status: "running" });
      assert.equal((await getTranslation("tr_hg", "u-hg")).proofreadStage, "preparing");

      respond = (_m, url) =>
        url.endsWith("/proofreads/pr_1") ? ok({ status: "completed" }) : url.endsWith("/pr_1/srt") ? ok({ srt_url: "https://files.heygen.ai/pr_1.srt" }) : new Response("1\n00:00:00,000 --> 00:00:02,000\nHola\n\n2\n00:00:02,500 --> 00:00:04,000\nAdiós\n");
      const ready = await getTranslation("tr_hg", "u-hg");
      assert.deepEqual(ready.proofreadCues, [
        { startMs: 0, endMs: 2000, text: "Hola" },
        { startMs: 2500, endMs: 4000, text: "Adiós" },
      ]);

      // HeyGen refuses: the job says why and the lines can be dubbed again.
      respond = (m) => (m === "PUT" ? ok({}) : new Response("no credits", { status: 402 }));
      const refused = await dubProofread("tr_hg", proofreadLinesSchema.parse({ lines: ["Hola a todos", "Adiós"] }), "u-hg");
      assert.equal(refused.proofreadStage, "ready");
      assert.match(refused.error ?? "", /could not be started.*402/);
      assert.equal(refused.proofreadCues?.[0].text, "Hola a todos", "the corrections are kept");

      calls.length = 0;
      respond = (m) => (m === "PUT" ? ok({}) : ok({ video_translation_id: "vt_pr" }));
      const dubbed = await dubProofread("tr_hg", undefined, "u-hg");
      assert.deepEqual([dubbed.providerJobId, dubbed.proofreadStage, dubbed.error], ["vt_pr", undefined, undefined]);
      const token = (await stored("tr_hg")).proofreadToken!;
      assert.deepEqual(
        calls.map((c) => [c.method, c.url, c.body]),
        [
          ["PUT", "https://api.heygen.com/v3/video-translations/proofreads/pr_1/srt", { srt: { type: "url", url: `https://studio.example.com/api/translate/tr_hg/srt?token=${token}` } }],
          ["POST", "https://api.heygen.com/v3/video-translations/proofreads/pr_1/generate", {}],
        ],
      );
      // From here it is an ordinary dub, and one HeyGen does not know yet is new however long the lines took to read.
      await getStore().put("translation", { ...(await stored("tr_hg")), createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
      respond = () => new Response("not found", { status: 404 });
      assert.equal((await getTranslation("tr_hg", "u-hg")).status, "processing");
      respond = () => ok({ status: "completed", video_url: "https://files.heygen.ai/pr.mp4" });
      assert.equal((await getTranslation("tr_hg", "u-hg")).videoUrl, "https://files.heygen.ai/pr.mp4");

      // A proofread HeyGen could not translate fails the job.
      await getStore().put("translation", { ...job, id: "tr_bad", providerProofreadId: "pr_bad" });
      respond = () => ok({ status: "failed", failure_message: "No speech found" });
      const bad = await getTranslation("tr_bad", "u-hg");
      assert.deepEqual([bad.status, bad.error, bad.proofreadStage], ["failed", "No speech found", undefined]);
      // Finished, but its lines cannot be read: a refused link fails the job, a server error is asked about again.
      await getStore().put("translation", { ...job, id: "tr_srt5", providerProofreadId: "pr_5" });
      respond = (_m, url) => (url.endsWith("/proofreads/pr_5") ? ok({ status: "completed" }) : url.endsWith("/srt") ? ok({ srt_url: "https://files.heygen.ai/x.srt" }) : new Response("busy", { status: 503 }));
      assert.equal((await getTranslation("tr_srt5", "u-hg")).proofreadStage, "preparing");
      respond = (_m, url) => (url.endsWith("/proofreads/pr_5") ? ok({ status: "completed" }) : url.endsWith("/srt") ? ok({ srt_url: "https://files.heygen.ai/x.srt" }) : new Response("expired", { status: 403 }));
      const unreadable = await getTranslation("tr_srt5", "u-hg");
      assert.deepEqual([unreadable.status, unreadable.error], ["failed", "HeyGen's translated lines could not be read (403)"]);
    } finally {
      globalThis.fetch = realFetch;
      (config as { heygenApiKey?: string }).heygenApiKey = original;
      (config as { publicAppUrl?: string }).publicAppUrl = originalUrl;
    }
  });
});
