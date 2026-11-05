// The scheduled background check: dubs, proofreads, and digital twins nobody is watching move on, and their webhooks
// are sent, without a page or the API being read.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { createTranslations, forgetTwinChecks, startTwin, translationBatchSchema, twinRequestSchema } from "../services";
import { checkTranslationsInBackground, BACKGROUND_TRANSLATION_CHECKS } from "../services/translations";
import { checkTwinsInBackground } from "../services/twins";
import { notifySchema, saveNotifySettings, setNotificationFetch } from "../notifications";
import { MockAvatarProvider } from "../providers/avatar/mock";
import type { Translation, TwinJob } from "../types";

const calls: Array<{ event: string; owner: string }> = [];
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetTwinChecks();
  calls.length = 0;
  setNotificationFetch(async (input, init) => {
    calls.push({ event: (init?.headers as Record<string, string>)["X-Studio-Event"], owner: new URL(String(input)).pathname.split("/").pop()! });
    return new Response("", { status: 200 });
  });
});
afterEach(() => setNotificationFetch(null));

const base = { title: "Walkthrough", sourceVideoUrl: "https://cdn.example.com/v.mp4" };

describe("background checks", () => {
  it("moves on every account's waiting dubs and proofreads, sending their webhooks, and leaves finished ones alone", async () => {
    for (const owner of ["bg-a", "bg-b"]) await saveNotifySettings(notifySchema.parse({ url: `https://203.0.113.5/hooks/${owner}` }), owner);
    const [dub] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish" }), "bg-a");
    const [proof] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "French", proofread: true }), "bg-b");
    // The demo provider reports a dub started long ago as made.
    await getStore().put("translation", { ...(await getStore().get<Translation>("translation", dub.id))!, providerJobId: "mock_tr_1" });
    const run = await checkTranslationsInBackground();
    assert.deepEqual(run, { checked: 2, moved: 2 });
    assert.deepEqual(calls.map((c) => `${c.owner}:${c.event}`).sort(), ["bg-a:translation.completed", "bg-b:translation.proofread_ready"]);
    assert.equal((await getStore().get<Translation>("translation", proof.id))!.proofreadStage, "ready");
    // Nothing is waiting now: lines waiting on a person and finished dubs are not asked about.
    assert.deepEqual(await checkTranslationsInBackground(BACKGROUND_TRANSLATION_CHECKS, Date.now() + 60_000), { checked: 0, moved: 0 });
    assert.equal(calls.length, 2, "sent once");
  });

  it("asks about at most the given number per run, the least recently asked first, each at most every 15 seconds", async () => {
    const jobs = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["Spanish", "French", "German"] }), "bg-c");
    assert.equal(jobs.length, 3);
    const now = Date.now();
    assert.equal((await checkTranslationsInBackground(2, now)).checked, 2);
    // The third was not asked yet, so it goes first; the two asked a moment ago wait their 15 seconds.
    assert.equal((await checkTranslationsInBackground(2, now + 1_000)).checked, 1);
    assert.equal((await checkTranslationsInBackground(5, now + 2_000)).checked, 0);
    assert.equal((await checkTranslationsInBackground(5, now + 16_000)).checked, 3, "still running: asked again once the gap has passed");
  });

  it("takes turns across runs by when each dub was last asked, so stuck dubs cannot hold every place", async () => {
    const jobs = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["Spanish", "French", "German"] }), "bg-d");
    const now = Date.now() + 100_000;
    await checkTranslationsInBackground(2, now);
    const asked = async () => Promise.all(jobs.map(async (j) => !!(await getStore().get<Translation>("translation", j.id))!.checkedAt));
    assert.deepEqual((await asked()).filter(Boolean).length, 2, "the two asked are noted");
    const left = jobs[(await asked()).indexOf(false)].id;
    // The next run (as on a fresh instance, after the gap) asks the one left out first.
    await checkTranslationsInBackground(1, now + 16_000);
    assert.ok((await getStore().get<Translation>("translation", left))!.checkedAt, "the dub left out is asked next");
  });

  it("moves on every account's twins, and one that becomes a presenter sends twin.completed", async () => {
    await saveNotifySettings(notifySchema.parse({ url: "https://203.0.113.5/hooks/bg-t" }), "bg-t");
    const clip = MockAvatarProvider as unknown as { CLIP_MS: number };
    const saved = clip.CLIP_MS;
    clip.CLIP_MS = 0;
    try {
      const twin = await startTwin(twinRequestSchema.parse({ name: "Dana Ruiz", footageUrl: "https://93.184.216.34/dana.mp4", agreed: true }), "bg-t");
      // Asked for consent (the demo gives it at once once asked), so a check alone takes it the rest of the way.
      await getStore().put("twin", { ...(await getStore().get<TwinJob>("twin", twin.id))!, consent: "pending", consentUrlAt: new Date().toISOString() });
      const first = await checkTwinsInBackground();
      assert.equal(first.checked, 1);
      assert.equal((await getStore().get<TwinJob>("twin", twin.id))!.status, "completed");
      assert.equal(first.moved, 1);
      assert.deepEqual(calls.map((c) => c.event), ["twin.completed"]);
      forgetTwinChecks();
      assert.deepEqual(await checkTwinsInBackground(), { checked: 0, moved: 0 }, "nothing left waiting");
    } finally {
      clip.CLIP_MS = saved;
    }
  });
});
