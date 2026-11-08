// Result emails: one message per video, dub, or digital twin when it is ready or fails, sent to the address in
// Settings for the kinds chosen there (every kind unless some are left out).
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MockEmailProvider, setEmailProvider } from "../providers/email";
import { emailTranslationResult, emailTwinResult, emailVideoResult, getPrefs, notifyTranslationTransition, notifyTwinTransition, notifySchema, prefsSchema, saveNotifySettings, savePrefs, setNotificationFetch, toggleFavorite } from "../notifications";
import type { Translation, TwinJob, Video } from "../types";

let mail: MockEmailProvider;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  mail = new MockEmailProvider();
  setEmailProvider(mail);
});
afterEach(() => {
  setEmailProvider(undefined);
  setNotificationFetch(null);
});

const at = "2026-11-05T12:00:00.000Z";
const dub = (extra: Partial<Translation> = {}): Translation =>
  ({ id: "tr_1", ownerId: "re-a", title: "Launch <recap>", sourceVideoUrl: "https://cdn.example.com/v.mp4", targetLanguage: "Spanish", status: "processing", createdAt: at, updatedAt: at, ...extra }) as Translation;
const twin = (extra: Partial<TwinJob> = {}): TwinJob => ({ id: "tw_1", ownerId: "re-a", name: "Dana Ruiz", status: "processing", createdAt: at, updatedAt: at, ...extra }) as TwinJob;
const video = (extra: Partial<Video> = {}): Video => ({ id: "vid_1", ownerId: "re-a", title: "Welcome", status: "completed", createdAt: at, updatedAt: at, ...extra }) as Video;

describe("result emails", () => {
  it("take a choice of at least one kind, in Settings' order, repeats dropped", () => {
    assert.deepEqual(prefsSchema.parse({ emailOnComplete: "a@example.com", emailKinds: ["twins", "videos", "twins"] }).emailKinds, ["videos", "twins"]);
    assert.throws(() => prefsSchema.parse({ emailKinds: [] }), /at least one/);
    assert.throws(() => prefsSchema.parse({ emailKinds: ["clips"] }), /one of videos, dubs, twins/);
    assert.equal(prefsSchema.parse({ emailOnComplete: "a@example.com" }).emailKinds, undefined);
    // A save without the address turns emails off, so kinds sent alone are refused rather than quietly stored.
    assert.throws(() => prefsSchema.parse({ emailKinds: ["dubs"] }), /address/);
  });

  it("keep the choice when a save leaves it out, store none for every kind, and keep starred avatars", async () => {
    await toggleFavorite({ kind: "avatar", id: "stock_1", on: true }, "re-a");
    await savePrefs(prefsSchema.parse({ emailOnComplete: "a@example.com", emailKinds: ["dubs"] }), "re-a");
    assert.deepEqual((await getPrefs("re-a"))!.emailKinds, ["dubs"]);
    await savePrefs(prefsSchema.parse({ emailOnComplete: "b@example.com" }), "re-a");
    const kept = (await getPrefs("re-a"))!;
    assert.deepEqual(kept.emailKinds, ["dubs"], "a change of address keeps the kinds");
    assert.deepEqual(kept.favoriteAvatarIds, ["stock_1"]);
    await toggleFavorite({ kind: "voice", id: "v_1", on: true }, "re-a");
    assert.deepEqual((await getPrefs("re-a"))!.emailKinds, ["dubs"], "starring keeps the kinds");
    await savePrefs(prefsSchema.parse({ emailOnComplete: "b@example.com", emailKinds: ["videos", "dubs", "twins"] }), "re-a");
    assert.equal((await getPrefs("re-a"))!.emailKinds, undefined, "every kind is stored as none, so kinds added later are emailed too");
  });

  it("email a dub that is ready, with its language and the Video translate page, escaped in html", async () => {
    await savePrefs(prefsSchema.parse({ emailOnComplete: "owner@example.com" }), "re-a");
    assert.equal(await emailTranslationResult(dub({ status: "completed", videoUrl: "https://files.example.com/es.mp4" })), true);
    const [msg] = mail.sent;
    assert.equal(msg.to, "owner@example.com");
    assert.equal(msg.subject, 'Your dub "Launch <recap>" in Spanish is ready');
    assert.match(msg.text, /The Spanish dub of "Launch <recap>" is ready to watch and download\./);
    assert.match(msg.text, /\/translate\b/);
    assert.doesNotMatch(msg.text, /files\.example\.com/, "the provider's link expires, so the email points at Video translate instead");
    assert.match(msg.html, /Launch &lt;recap&gt;/);
    assert.doesNotMatch(msg.html, /<recap>/);
    await emailTranslationResult(dub({ status: "completed", targetLanguage: "<b>Klingon</b>" }));
    await emailTwinResult(twin({ status: "completed", name: "Dana <i>R</i>" }));
    assert.match(mail.sent[1].html, /&lt;b&gt;Klingon&lt;\/b&gt;/);
    assert.match(mail.sent[2].html, /Dana &lt;i&gt;R&lt;\/i&gt;/);
  });

  it("email a failed dub and a digital twin with the reason, and a ready twin with the Avatars page", async () => {
    await savePrefs(prefsSchema.parse({ emailOnComplete: "owner@example.com" }), "re-a");
    await emailTranslationResult(dub({ status: "failed", error: "No speech <found>" }));
    await emailTwinResult(twin({ status: "completed", avatarId: "av_1" }));
    await emailTwinResult(twin({ status: "failed", error: "Footage too short" }));
    assert.deepEqual(mail.sent.map((m) => m.subject), ['Your dub "Launch <recap>" in Spanish could not be made', 'Your digital twin "Dana Ruiz" is ready', 'Your digital twin "Dana Ruiz" could not be made']);
    assert.match(mail.sent[0].text, /Reason: No speech <found>/);
    assert.match(mail.sent[0].html, /No speech &lt;found&gt;/);
    assert.match(mail.sent[1].text, /\/avatars\b/);
    assert.match(mail.sent[2].text, /Reason: Footage too short/);
  });

  it("are sent only for the kinds chosen, and not at all without an address", async () => {
    assert.equal(await emailTranslationResult(dub({ status: "completed" })), false, "no address set");
    await savePrefs(prefsSchema.parse({ emailOnComplete: "owner@example.com", emailKinds: ["twins"] }), "re-a");
    assert.equal(await emailTranslationResult(dub({ status: "completed" })), false);
    assert.equal(await emailVideoResult(video()), false);
    assert.equal(await emailTwinResult(twin({ status: "completed" })), true);
    assert.equal(mail.sent.length, 1);
  });

  it("do not hold back or stop the webhook when the mail provider fails", async () => {
    await savePrefs(prefsSchema.parse({ emailOnComplete: "owner@example.com" }), "re-a");
    await saveNotifySettings(notifySchema.parse({ url: "https://203.0.113.5/hooks/re-a" }), "re-a");
    const events: string[] = [];
    setNotificationFetch(async (_input, init) => {
      events.push((init?.headers as Record<string, string>)["X-Studio-Event"]);
      return new Response("", { status: 200 });
    });
    setEmailProvider({ name: "broken", delivers: true, send: async () => { throw new Error("mail is down"); } } as never);
    await notifyTranslationTransition(dub(), dub({ status: "completed" }));
    await notifyTwinTransition(twin(), twin({ status: "completed" }));
    assert.deepEqual(events, ["translation.completed", "twin.completed"]);
  });

  it("go out once from the transition that finished the dub or twin, and not for other changes", async () => {
    await savePrefs(prefsSchema.parse({ emailOnComplete: "owner@example.com" }), "re-a");
    await notifyTranslationTransition(dub(), dub({ status: "completed" }));
    await notifyTranslationTransition(dub({ status: "completed" }), dub({ status: "completed", title: "Renamed" }));
    await notifyTwinTransition(twin(), twin({ status: "failed", error: "Refused" }));
    await notifyTwinTransition(twin(), twin({ consent: "pending" } as Partial<TwinJob>));
    assert.deepEqual(mail.sent.map((m) => m.subject), ['Your dub "Launch <recap>" in Spanish is ready', 'Your digital twin "Dana Ruiz" could not be made']);
  });
});
