// Webhook events for the studio's other renderer jobs (job.completed and job.failed): sent once, from the write that
// moves a B-roll clip, photo shoot, clean-up, lip sync, music mix, voice recording, or instant voice off "processing",
// and the scheduled background check moves on the ones nobody is watching.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { footageRequestSchema, forgetFootageChecks, listFootage, startFootage } from "../services";
import { checkFootageInBackground } from "../services/footage";
import { checkShootsInBackground } from "../services/shoots";
import { checkCleanupsInBackground } from "../services/cleanups";
import { checkLipsyncsInBackground } from "../services/lipsyncs";
import { checkMusicJobsInBackground } from "../services/music";
import { checkInstantVoicesInBackground, checkVoiceChangesInBackground } from "../services/voice-changer";
import { JOB_EVENT_TYPES, notifyJobTransition, notifySchema, sampleEventData, saveNotifySettings, setNotificationFetch } from "../notifications";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { WEBHOOK_EVENTS, type FootageJob } from "../types";

const calls: Array<{ event: string; owner: string; data: Record<string, unknown> }> = [];
const clip = MockAvatarProvider as unknown as { CLIP_MS: number };
const savedClipMs = clip.CLIP_MS;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetFootageChecks();
  calls.length = 0;
  clip.CLIP_MS = 0;
  setNotificationFetch(async (input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ event: (init?.headers as Record<string, string>)["X-Studio-Event"], owner: new URL(String(input)).pathname.split("/").pop()!, data: body.data });
    return new Response("", { status: 200 });
  });
});
afterEach(() => {
  setNotificationFetch(null);
  clip.CLIP_MS = savedClipMs;
});

const ask = () => footageRequestSchema.parse({ prompt: "A slow push-in on a sunlit kitchen; steam rises from a coffee cup", title: "Kitchen push-in" });
const hook = (owner: string) => saveNotifySettings(notifySchema.parse({ url: `https://203.0.113.5/hooks/${owner}` }), owner);

describe("job webhook events", () => {
  it("are listed among the events a webhook can be sent, with a sample of each", () => {
    assert.ok(WEBHOOK_EVENTS.includes("job.completed") && WEBHOOK_EVENTS.includes("job.failed"));
    assert.deepEqual(Object.values(JOB_EVENT_TYPES).map((t) => t.type), ["broll", "photo_shoot", "cleanup", "lipsync", "music", "voice_change", "instant_voice"]);
    const done = sampleEventData("job.completed", "2026-01-01T00:00:00.000Z");
    assert.equal(done.type, "broll");
    assert.equal(done.status, "completed");
    assert.equal(done.error, undefined);
    assert.match(String(done.pageUrl), /^https:\/\/example\.com\//);
    assert.match(String(sampleEventData("job.failed").error), /Sample failure/);
  });

  it("send job.completed once when a B-roll clip is made, with its type, title, and page, and none of the renderer's links", async () => {
    await hook("je-a");
    const job = await startFootage(ask(), "je-a");
    assert.equal(calls.length, 0, "nothing is sent when a clip is started");
    const [listed] = await listFootage("je-a");
    assert.equal(listed.status, "completed");
    assert.deepEqual(calls.map((c) => `${c.owner}:${c.event}`), ["je-a:job.completed"]);
    const data = calls[0].data;
    assert.deepEqual(Object.keys(data).sort(), ["createdAt", "id", "pageUrl", "status", "title", "type", "updatedAt"]);
    assert.equal(data.type, "broll");
    assert.equal(data.id, job.id);
    assert.equal(data.title, "Kitchen push-in");
    assert.match(String(data.pageUrl), /\/footage$/);
    forgetFootageChecks();
    await listFootage("je-a");
    assert.equal(calls.length, 1, "a finished clip looked at again sends nothing more");
  });

  it("send job.failed with the renderer's reason when a clip fails, and nothing when a finished clip's later check fails", async () => {
    await hook("je-b");
    const job = await startFootage(ask(), "je-b");
    // The demo renderer knows no such job, so it reports the clip failed.
    await getStore().put("footage", { ...(await getStore().get<FootageJob>("footage", job.id))!, providerJobId: "gone" });
    await listFootage("je-b");
    assert.deepEqual(calls.map((c) => c.event), ["job.failed"]);
    assert.equal(calls[0].data.status, "failed");
    assert.equal(calls[0].data.error, "No such clip");

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const made = await startFootage(ask(), "je-b");
    await getStore().put("footage", { ...(await getStore().get<FootageJob>("footage", made.id))!, status: "completed", providerJobId: "gone", checkedAt: old, updatedAt: old });
    forgetFootageChecks();
    await listFootage("je-b");
    assert.equal((await getStore().get<FootageJob>("footage", made.id))!.status, "failed", "its link could not be renewed");
    assert.equal(calls.length, 1, "a clip that had already been made is not reported again");
  });

  it("are sent once when an out-of-date answer of 'still being made' arrives after the clip was made", async () => {
    await hook("je-h");
    const job = await startFootage(ask(), "je-h");
    const stale = (await getStore().get<FootageJob>("footage", job.id))!;
    await listFootage("je-h");
    assert.equal(calls.length, 1);
    // A check that read the row before it was made writes its (later stamped) "processing" answer over the made clip.
    const { writeRefresh } = await import("../services/shared");
    const kept = await writeRefresh<FootageJob>("footage", stale, (current) => ({ ...current, status: "processing", checkedAt: new Date(Date.now() + 60_000).toISOString() }));
    assert.equal(kept.status, "completed", "the made clip stands");
    forgetFootageChecks();
    await listFootage("je-h");
    assert.equal(calls.length, 1, "it is not made, or reported, a second time");
  });

  it("are not sent when the webhook leaves them out of its events", async () => {
    await saveNotifySettings(notifySchema.parse({ url: "https://203.0.113.5/hooks/je-c", events: ["video.completed"] }), "je-c");
    await startFootage(ask(), "je-c");
    await listFootage("je-c");
    assert.equal(calls.length, 0);
  });

  it("name an instant voice by its name, and are only sent for a job leaving processing", async () => {
    await hook("je-d");
    const at = new Date().toISOString();
    const voice = { id: "iv_1", ownerId: "je-d", name: "Narrator", status: "processing", createdAt: at, updatedAt: at };
    await notifyJobTransition("instantvoice", voice, { ...voice, status: "completed" });
    await notifyJobTransition("instantvoice", { ...voice, status: "completed" }, { ...voice, status: "failed", error: "Its link expired" });
    assert.deepEqual(calls.map((c) => [c.event, c.data.type, c.data.title]), [["job.completed", "instant_voice", "Narrator"]]);
    assert.match(String(calls[0].data.pageUrl), /\/voice-changer$/);
  });

  it("the background check moves on every account's waiting clips, sending their webhooks, and leaves finished ones alone", async () => {
    for (const owner of ["je-e", "je-f"]) await hook(owner);
    await startFootage(ask(), "je-e");
    await startFootage(ask(), "je-f");
    assert.deepEqual(await checkFootageInBackground(), { checked: 2, moved: 2 });
    assert.deepEqual(calls.map((c) => `${c.owner}:${c.event}`).sort(), ["je-e:job.completed", "je-f:job.completed"]);
    forgetFootageChecks();
    assert.deepEqual(await checkFootageInBackground(), { checked: 0, moved: 0 }, "nothing left waiting");
    for (const check of [checkShootsInBackground, checkCleanupsInBackground, checkLipsyncsInBackground, checkMusicJobsInBackground, checkVoiceChangesInBackground, checkInstantVoicesInBackground]) {
      assert.deepEqual(await check(), { checked: 0, moved: 0 });
    }
  });

  it("the background check asks about at most the given number of clips per run", async () => {
    for (let i = 0; i < 3; i++) await startFootage(ask(), "je-g");
    assert.equal((await checkFootageInBackground(2)).checked, 2);
    assert.equal((await checkFootageInBackground(2)).checked, 1, "the one left goes next");
  });
});
