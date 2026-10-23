// Service-layer tests against the demo providers and the in-memory store.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import {
  brandKitSchema,
  bulkVideoSchema,
  bulkVideos,
  createAvatar,
  createAvatarSchema,
  deleteBrandKit,
  getBrandKit,
  saveBrandKit,
  createTranslation,
  createVideo,
  deleteVideo,
  getVideo,
  listAvatars,
  listVideos,
  chatSchema,
  chatWithAvatar,
  agentSchema,
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  publicAgent,
  talkToAgent,
  updateAgent,
  listConversations,
  clearConversations,
  MAX_TRANSCRIPT_MESSAGES,
  recordView,
  scriptSchema,
  updateVideo,
  videoPatchSchema,
  videoRequestSchema,
} from "../services";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { API_KEY_PREFIX, MAX_API_KEYS, createApiKey, listApiKeys, ownerForApiKey, revokeApiKey } from "../api-keys";
import { createHmac } from "node:crypto";
import { computeInsights } from "../insights";
import { acceptInvite, createInvite, createWorkspace, deleteWorkspace, findInvite, listWorkspaces, removeMember, revokeInvite, setMemberRole, workspaceForMember, workspaceView } from "../workspaces";
import type { Video } from "../types";
import { MockEmailProvider, inviteEmail, setEmailProvider } from "../providers/email";
import { MockBillingProvider, applyStripeEvent, getPlan, renderLimitFor, setBillingProvider, setPlan, verifyStripeSignature } from "../billing";
import { config } from "../config";
import { dispatchNotification, getNotifySettings, notifyVideoTransition, saveNotifySettings, setNotificationFetch, signPayload } from "../notifications";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { SCRIPT_TEMPLATES, findTemplate } from "../templates";

beforeEach(() => {
  // Fresh store per test; getStore() memoises on globalThis.
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("avatars", () => {
  it("lists stock avatars in demo mode", async () => {
    const avatars = await listAvatars();
    assert.equal(avatars.length, STOCK_AVATARS.length);
    assert.ok(avatars.every((a) => a.imageUrl.startsWith("data:image/svg+xml")));
  });

  it("creates a custom avatar and lists it first", async () => {
    const created = await createAvatar({ name: "Dan", imageUrl: "https://example.com/p.jpg" });
    assert.equal(created.source, "custom");
    const avatars = await listAvatars();
    assert.equal(avatars[0].id, created.id);
  });

  it("rejects non-image inputs", () => {
    assert.throws(() => createAvatarSchema.parse({ name: "x", imageUrl: "not a url" }));
    assert.doesNotThrow(() => createAvatarSchema.parse({ name: "x", imageUrl: "data:image/png;base64,AAAA" }));
  });
});

describe("videos", () => {
  const base = {
    title: "Test",
    script: "Hello there. This is a short test script for the renderer.",
    avatarId: STOCK_AVATARS[0].id,
    voiceId: STOCK_VOICES[0].id,
  };

  it("applies schema defaults", () => {
    const parsed = videoRequestSchema.parse(base);
    assert.equal(parsed.aspect, "16:9");
    assert.equal(parsed.captions, false);
    assert.equal(parsed.speed, 1);
    assert.deepEqual(parsed.background, { type: "color", value: "#f1f5f9" });
  });

  it("submits a render, records names, and reports processing", async () => {
    const video = await createVideo(videoRequestSchema.parse(base));
    assert.equal(video.status, "processing");
    assert.equal(video.provider, "mock");
    assert.equal(video.avatarName, STOCK_AVATARS[0].name);
    assert.equal(video.voiceName, STOCK_VOICES[0].name);
    assert.ok(video.providerJobId?.startsWith("mock_"));
    const again = await getVideo(video.id);
    assert.equal(again.status, "processing");
  });

  it("completes once the mock render window has elapsed", async () => {
    const video = await createVideo(videoRequestSchema.parse(base));
    // Rewind the embedded start time so the mock provider reports completion.
    const [, , duration] = video.providerJobId!.split("_");
    await globalThis.__avatarStudioStore!.put("video", { ...video, providerJobId: `mock_${Date.now() - 60_000}_${duration}` });
    const done = await getVideo(video.id);
    assert.equal(done.status, "completed");
    assert.ok(done.videoUrl);
    assert.equal(done.durationSec, Number(duration));
  });

  it("fails cleanly for an unknown avatar", async () => {
    await assert.rejects(createVideo(videoRequestSchema.parse({ ...base, avatarId: "nope" })), /not found/);
  });

  it("lists newest first and deletes", async () => {
    const a = await createVideo(videoRequestSchema.parse({ ...base, title: "A" }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await createVideo(videoRequestSchema.parse({ ...base, title: "B" }));
    const list = await listVideos();
    assert.deepEqual(list.map((v) => v.id), [b.id, a.id]);
    await deleteVideo(a.id);
    assert.equal((await listVideos()).length, 1);
    await assert.rejects(deleteVideo(a.id), /not found/);
  });

  it("estimates duration from script length and speed", async () => {
    const provider = new MockAvatarProvider();
    const words = Array.from({ length: 50 }, () => "word").join(" ");
    const slow = await provider.createVideo({ ...base, script: words, aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 0.5 });
    const fast = await provider.createVideo({ ...base, script: words, aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1.5 });
    assert.equal(Number(slow.providerJobId.split("_")[2]), 40);
    assert.equal(Number(fast.providerJobId.split("_")[2]), 13);
  });
});

describe("translations and scripts", () => {
  it("creates a translation job", async () => {
    const t = await createTranslation({ title: "Dub", sourceVideoUrl: "https://example.com/v.mp4", targetLanguage: "Spanish" });
    assert.equal(t.status, "processing");
    assert.equal(t.targetLanguage, "Spanish");
  });

  it("validates script writer input", () => {
    const parsed = scriptSchema.parse({ topic: "welcoming tenants" });
    assert.equal(parsed.tone, "friendly");
    assert.equal(parsed.lengthSec, 45);
    assert.throws(() => scriptSchema.parse({ topic: "hi", lengthSec: 5 }));
  });
});

describe("templates", () => {
  it("have unique ids and non-empty scripts", () => {
    const ids = new Set(SCRIPT_TEMPLATES.map((t) => t.id));
    assert.equal(ids.size, SCRIPT_TEMPLATES.length);
    assert.ok(SCRIPT_TEMPLATES.every((t) => t.script.trim().length > 40));
    assert.equal(findTemplate("listing-walkthrough")?.aspect, "9:16");
    assert.equal(findTemplate("missing"), undefined);
  });
});

describe("captions", () => {
  it("times cues proportionally and covers the full duration", async () => {
    const { buildCues, buildSrt, formatSrtTime } = await import("../captions");
    const cues = buildCues("One two three. Four five six seven eight nine.", 9);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].startMs, 0);
    assert.equal(cues[0].endMs, 3000);
    assert.equal(cues[1].endMs, 9000);
    assert.equal(formatSrtTime(3_723_456), "01:02:03,456");
    const srt = buildSrt("Hello there. Welcome!", 4);
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\nHello there\.\n\n2\n/);
  });

  it("returns nothing for empty input", async () => {
    const { buildCues } = await import("../captions");
    assert.deepEqual(buildCues("   ", 10), []);
    assert.deepEqual(buildCues("Hi.", 0), []);
  });
});

describe("auth", () => {
  it("is open without a password and validates tokens with one", async () => {
    const { authEnabled, isValidSession, sessionToken, timingSafeEqual } = await import("../auth");
    delete process.env.STUDIO_PASSWORD;
    assert.equal(authEnabled(), false);
    assert.equal(await isValidSession(undefined), true);
    process.env.STUDIO_PASSWORD = "hunter2";
    assert.equal(authEnabled(), true);
    assert.equal(await isValidSession(undefined), false);
    assert.equal(await isValidSession("wrong"), false);
    assert.equal(await isValidSession(await sessionToken("hunter2")), true);
    assert.notEqual(await sessionToken("hunter2"), await sessionToken("hunter3"));
    assert.equal(timingSafeEqual("abc", "abd"), false);
    delete process.env.STUDIO_PASSWORD;
  });
});

describe("scenes", () => {
  it("derives the full script and background from scenes", () => {
    const parsed = videoRequestSchema.parse({
      title: "Multi",
      avatarId: "stock_1",
      voiceId: "stock_voice_1",
      scenes: [
        { script: "Scene one.", background: { type: "color", value: "#000000" } },
        { script: "Scene two.", background: { type: "color", value: "#ffffff" } },
      ],
    });
    assert.equal(parsed.script, "Scene one.\n\nScene two.");
    assert.deepEqual(parsed.background, { type: "color", value: "#000000" });
    assert.equal(parsed.scenes?.length, 2);
  });

  it("requires a script when no scenes are given", () => {
    assert.throws(() => videoRequestSchema.parse({ title: "x", avatarId: "a", voiceId: "v" }), /Script is required/);
    assert.throws(() => videoRequestSchema.parse({ title: "x", avatarId: "a", voiceId: "v", scenes: [] }));
  });
});

describe("review fixes", () => {
  it("rejects a voice the current provider does not list", async () => {
    await assert.rejects(
      createVideo(videoRequestSchema.parse({ title: "x", script: "hi there", avatarId: STOCK_AVATARS[0].id, voiceId: "not_a_voice" })),
      /not available/,
    );
  });

  it("store findBy matches a top-level field", async () => {
    const store = globalThis.__avatarStudioStore!;
    const v = await createVideo(videoRequestSchema.parse({ title: "x", script: "hi there", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }));
    const found = await store.findBy<{ id: string }>("video", "providerJobId", v.providerJobId!);
    assert.equal(found?.id, v.id);
    assert.equal(await store.findBy("video", "providerJobId", "missing"), null);
  });

  it("mock providers refuse foreign job ids instead of completing them", async () => {
    const { MockTranslateProvider } = await import("../providers/translate/mock");
    await assert.rejects(new MockAvatarProvider().getStatus("heygen-job-123"), /Not a demo job id/);
    await assert.rejects(new MockTranslateProvider().getStatus("abc"), /Not a demo job id/);
  });

  it("HeyGen translate webhook parsing recognises success and failure", async () => {
    const { HeyGenTranslateProvider } = await import("../providers/translate/heygen");
    const p = new HeyGenTranslateProvider("key");
    assert.deepEqual(p.parseWebhook({ event_type: "video_translate.success", event_data: { video_translate_id: "t1", url: "https://x/v.mp4" } }), {
      providerJobId: "t1",
      update: { status: "completed", videoUrl: "https://x/v.mp4" },
    });
    assert.equal(p.parseWebhook({ event_type: "video_translate.fail", event_data: { video_translate_id: "t2", msg: "bad" } })?.update.status, "failed");
    assert.equal(p.parseWebhook({ event_type: "other" }), null);
  });

  it("webhook URLs are only built when a secret is configured", async () => {
    const { webhookUrl } = await import("../config");
    assert.equal(webhookUrl("heygen"), undefined);
  });
});

describe("rename", () => {
  it("updates the title and bumps updatedAt", async () => {
    const { updateVideo } = await import("../services");
    const v = await createVideo(videoRequestSchema.parse({ title: "Old", script: "hi there", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }));
    const renamed = await updateVideo(v.id, { title: "New" });
    assert.equal(renamed.title, "New");
    assert.ok(renamed.updatedAt >= v.updatedAt);
    await assert.rejects(updateVideo("missing", { title: "x" }), /not found/);
  });
});

describe("script assistant", () => {
  it("revises scripts in demo mode", async () => {
    const { reviseScript } = await import("../services");
    const script = "Hi there! One. Two. Three. Four.";
    assert.equal(await reviseScript({ script, action: "shorten" }), "Hi there! One. Two.");
    assert.match(await reviseScript({ script, action: "expand" }), /Thanks for watching\.$/);
    assert.match(await reviseScript({ script, action: "tone", tone: "formal" }), /^Hello\./);
    assert.match(await reviseScript({ script, action: "translate", language: "Spanish" }), /^\[Spanish\]/);
  });
});

describe("owner isolation", () => {
  const req = () => videoRequestSchema.parse({ title: "mine", script: "hi there", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id });
  it("scopes videos, avatars, and translations to their owner", async () => {
    const a = await createVideo(req(), "user-a");
    await createVideo(req(), "user-b");
    assert.deepEqual((await listVideos("user-a")).map((v) => v.id), [a.id]);
    assert.equal((await listVideos("user-b")).length, 1);
    await assert.rejects(getVideo(a.id, "user-b"), /not found/);
    const { PUBLIC_ACCESS } = await import("../services");
    assert.equal((await getVideo(a.id, PUBLIC_ACCESS)).id, a.id, "public access (share page) still works");
    await assert.rejects(getVideo(a.id, undefined as unknown as string), /not found/, "undefined must not mean public");
    await assert.rejects(deleteVideo(a.id, "user-b"), /not found/);

    const av = await createAvatar({ name: "A", imageUrl: "https://example.com/a.jpg" }, "user-a");
    assert.ok((await listAvatars("user-a")).some((x) => x.id === av.id));
    assert.ok(!(await listAvatars("user-b")).some((x) => x.id === av.id));
    await assert.rejects(createVideo(videoRequestSchema.parse({ ...req(), avatarId: av.id }), "user-b"), /not found/);

    const t = await createTranslation({ title: "t", sourceVideoUrl: "https://example.com/v.mp4", targetLanguage: "French" }, "user-a");
    assert.equal(t.ownerId, "user-a");
    const { listTranslations } = await import("../services");
    assert.equal((await listTranslations("user-b")).length, 0);
  });
});

describe("render allowance", () => {
  it("counts this month's renders and enforces RENDER_LIMIT_PER_MONTH", async () => {
    const { config } = await import("../config");
    const { rendersThisMonth, LimitError } = await import("../services");
    const req = () => videoRequestSchema.parse({ title: "r", script: "hi there", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id });
    const original = config.renderLimitPerMonth;
    (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = 2;
    try {
      await createVideo(req(), "quota-user");
      await createVideo(req(), "quota-user");
      assert.equal(await rendersThisMonth("quota-user"), 2);
      await assert.rejects(createVideo(req(), "quota-user"), (e: unknown) => e instanceof LimitError && /2 of 2/.test((e as Error).message));
      // Other owners are unaffected.
      await createVideo(req(), "other-user");
    } finally {
      (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = original;
    }
  });
});

describe("personalized batches", () => {
  it("parses CSV with quotes, CRLF, and BOM", async () => {
    const { parseCsv, fillTemplate, placeholdersIn } = await import("../csv");
    const t = parseCsv('﻿name,note\r\n"Smith, Jo","Says ""hi"""\r\n\r\nAmy,plain\n');
    assert.deepEqual(t.columns, ["name", "note"]);
    assert.deepEqual(t.rows, [{ name: "Smith, Jo", note: 'Says "hi"' }, { name: "Amy", note: "plain" }]);
    assert.equal(fillTemplate("Hi {name}: {note} {missing}", t.rows[0]), 'Hi Smith, Jo: Says "hi" {missing}');
    assert.deepEqual(placeholdersIn("{a} {b} {a}"), ["a", "b"]);
  });

  it("creates one video per row with substituted scripts and a shared batch id", async () => {
    const { createBatch, previewBatch } = await import("../services");
    const csv = "name,city\nJordan,Austin\nPriya,Denver";
    const preview = previewBatch("Hi {name} from {city}.", csv);
    assert.equal(preview.rowCount, 2);
    assert.deepEqual(preview.missing, []);
    assert.equal(preview.samples[1].script, "Hi Priya from Denver.");
    const result = await createBatch({ title: "Welcome", scriptTemplate: "Hi {name} from {city}.", csv, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, "batch-user");
    assert.equal(result.videos.length, 2);
    assert.ok(result.videos.every((v) => v.batchId === result.batchId));
    assert.equal(result.videos[0].title, "Welcome – Jordan");
    assert.equal(result.videos[0].script, "Hi Jordan from Austin.");
    assert.equal(result.videos[0].rowLabel, "Jordan");
    assert.equal((await listVideos("batch-user")).length, 2);
  });

  it("rejects missing columns and stops at the allowance", async () => {
    const { createBatch } = await import("../services");
    const { config } = await import("../config");
    const base = { title: "W", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect: "16:9" as const, background: { type: "color" as const, value: "#fff" }, captions: false, speed: 1 };
    await assert.rejects(createBatch({ ...base, scriptTemplate: "Hi {nope}", csv: "name\nA" }, "u"), /does not have: nope/);
    await assert.rejects(createBatch({ ...base, scriptTemplate: "Hi", csv: "name" }, "u"), /at least one data row/);
    const original = config.renderLimitPerMonth;
    (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = 2;
    try {
      const r = await createBatch({ ...base, scriptTemplate: "Hi {name}", csv: "name\nA\nB\nC\nD" }, "quota-batch");
      assert.equal(r.videos.length, 2);
      assert.deepEqual(r.skipped.map((s) => s.row), [3, 4]);
      assert.match(r.skipped[0].reason, /limit reached/);
    } finally {
      (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = original;
    }
  });
});

describe("hardening", () => {
  it("rate limiter allows a burst then blocks until the window resets", async () => {
    const { rateLimit, resetRateLimit } = await import("../rate-limit");
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) assert.equal(rateLimit("k", 5, 60_000, t0 + i).allowed, true);
    const blocked = rateLimit("k", 5, 60_000, t0 + 10);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 59);
    assert.equal(rateLimit("k", 5, 60_000, t0 + 60_001).allowed, true, "window reset");
    resetRateLimit("k");
    assert.equal(rateLimit("k", 1, 60_000, t0).remaining, 0);
  });

  it("builds WebVTT with dot separators and a header", async () => {
    const { buildVtt } = await import("../captions");
    const vtt = buildVtt("Hello there. Welcome!", 4);
    assert.match(vtt, /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:0\d\.\d{3}\nHello there\.\n/);
  });
});

describe("second review fixes", () => {
  it("safeNextPath blocks open redirects", async () => {
    const { safeNextPath } = await import("../safe-url-client");
    assert.equal(safeNextPath("/videos"), "/videos");
    assert.equal(safeNextPath("//evil.com"), "/home");
    assert.equal(safeNextPath("/\\evil.com"), "/home");
    assert.equal(safeNextPath("https://evil.com"), "/home");
    assert.equal(safeNextPath(null), "/home");
  });

  it("rejects private and loopback image hosts, accepts public literals", async () => {
    const { assertPublicHttpUrl, isPrivateAddress } = await import("../safe-url");
    for (const bad of ["http://127.0.0.1/x", "http://10.0.0.5:8080/admin", "http://169.254.169.254/latest", "http://[::1]/", "http://localhost/x", "ftp://example.com/x", "http://192.168.1.1/"]) {
      await assert.rejects(assertPublicHttpUrl(bad), Error, bad);
    }
    assert.equal((await assertPublicHttpUrl("https://93.184.216.34/portrait.jpg")).hostname, "93.184.216.34");
    assert.equal(isPrivateAddress("::ffff:10.1.1.1"), true);
    assert.equal(isPrivateAddress("8.8.8.8"), false);
  });

  it("decodes base64 and utf8 data URLs", async () => {
    const { decodeDataUrl } = await import("../providers/image");
    const b64 = decodeDataUrl("data:image/png;base64,aGVsbG8=");
    assert.equal(b64.mimeType, "image/png");
    assert.equal(Buffer.from(b64.bytes).toString(), "hello");
    const utf = decodeDataUrl("data:image/svg+xml;utf8,%3Csvg%20fill%3D%22rgba(1%2C2%2C3)%22%3E");
    assert.equal(utf.mimeType, "image/svg+xml");
    assert.equal(Buffer.from(utf.bytes).toString(), '<svg fill="rgba(1,2,3)">');
  });

  it("batch reserves the allowance up front and reports failed starts", async () => {
    const { createBatch } = await import("../services");
    const { config } = await import("../config");
    const base = { title: "W", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect: "16:9" as const, background: { type: "color" as const, value: "#fff" }, captions: false, speed: 1 };
    const original = config.renderLimitPerMonth;
    (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = 3;
    try {
      const r = await createBatch({ ...base, scriptTemplate: "Hi {name}", csv: "name\nA\nB\nC\nD\nE" }, "quota-batch-2");
      assert.equal(r.videos.length, 3);
      assert.deepEqual(r.videos.map((v) => v.rowLabel), ["A", "B", "C"], "row order preserved under concurrency");
      assert.deepEqual(r.skipped.map((s) => s.row), [4, 5]);
      assert.deepEqual(r.failed, []);
    } finally {
      (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = original;
    }
  });

  it("global login backstop blocks forged client keys", async () => {
    const { rateLimitPair } = await import("../rate-limit");
    const t0 = 5_000_000;
    let blocked = 0;
    for (let i = 0; i < 20; i++) if (!rateLimitPair(`ip:${i}`, 5, "all", 10, 60_000, t0 + i).allowed) blocked++;
    assert.equal(blocked, 10, "after 10 global attempts every further request is blocked");
  });
});

describe("brand kit", () => {
  it("is null until saved, then round-trips per owner", async () => {
    assert.equal(await getBrandKit("u1"), null);
    const saved = await saveBrandKit(
      brandKitSchema.parse({ name: "Acme Realty", primaryColor: "#0F766E", defaultAvatarId: "stock_2", defaultVoiceId: "stock_voice_2", captionsByDefault: true }),
      "u1",
    );
    assert.equal(saved.primaryColor, "#0f766e");
    assert.equal(saved.logoUrl, undefined);
    assert.deepEqual(await getBrandKit("u1"), saved);
    assert.equal(await getBrandKit("u2"), null, "another owner never sees it");
    await deleteBrandKit("u1");
    assert.equal(await getBrandKit("u1"), null);
  });

  it("rejects bad colors, unknown voices, and other owners' avatars", async () => {
    assert.throws(() => brandKitSchema.parse({ primaryColor: "teal" }));
    assert.throws(() => brandKitSchema.parse({ primaryColor: "#0f766e", logoUrl: "ftp://x/logo.png" }));
    await assert.rejects(saveBrandKit(brandKitSchema.parse({ primaryColor: "#0f766e", defaultVoiceId: "nope" }), "u1"), /not available/);
    const foreign = await createAvatar({ name: "Theirs", imageUrl: "https://example.com/t.jpg" }, "u2");
    await assert.rejects(saveBrandKit(brandKitSchema.parse({ primaryColor: "#0f766e", defaultAvatarId: foreign.id }), "u1"), /not found/);
  });
});

describe("folders and share views", () => {
  const req = { title: "T", script: "Hello there.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9" as const, background: { type: "color" as const, value: "#fff" }, captions: false, speed: 1 };

  it("moves a video into and out of a folder without touching the title", async () => {
    const v = await createVideo(req);
    const moved = await updateVideo(v.id, videoPatchSchema.parse({ folder: " Listings " }));
    assert.equal(moved.folder, "Listings");
    assert.equal(moved.title, "T");
    const unfiled = await updateVideo(v.id, videoPatchSchema.parse({ folder: "" }));
    assert.equal("folder" in unfiled, false);
    assert.throws(() => videoPatchSchema.parse({}), /Nothing to update/);
    await assert.rejects(updateVideo(v.id, { folder: "x" }, "someone-else"), /not found/);
  });

  it("counts share views only once the render completed", async () => {
    const v = await createVideo(req);
    assert.deepEqual(await recordView(v.id), { views: 0, counted: false });
    await getVideo(v.id, undefined, false).then(async (fresh) => {
      globalThis.__avatarStudioStore!.put("video", { ...fresh, status: "completed" });
    });
    assert.deepEqual(await recordView(v.id), { views: 1, counted: true });
    assert.deepEqual(await recordView(v.id, () => false), { views: 1, counted: false }, "gated repeat is not counted");
    assert.equal((await recordView(v.id)).views, 2);
    assert.ok((await getVideo(v.id, undefined, false)).lastViewedAt);
    await assert.rejects(recordView("vid_missing"), /not found/);
  });
});

describe("bulk actions", () => {
  const req = { title: "B", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9" as const, background: { type: "color" as const, value: "#fff" }, captions: false, speed: 1 };

  it("moves and deletes many videos, skipping foreign and unknown ids", async () => {
    const a = await createVideo(req, "u1");
    const b = await createVideo(req, "u1");
    const theirs = await createVideo(req, "u2");
    const moved = await bulkVideos(bulkVideoSchema.parse({ action: "move", ids: [a.id, b.id, theirs.id, "vid_nope", a.id], folder: "Q4" }), "u1");
    assert.deepEqual(moved, { done: 2, missing: [theirs.id, "vid_nope"] });
    assert.equal((await getVideo(a.id, "u1", false)).folder, "Q4");
    assert.equal((await getVideo(theirs.id, "u2", false)).folder, undefined);
    const deleted = await bulkVideos({ action: "delete", ids: [a.id, theirs.id] }, "u1");
    assert.deepEqual(deleted, { done: 1, missing: [theirs.id] });
    assert.equal((await listVideos("u1")).length, 1);
    assert.equal((await listVideos("u2")).length, 1);
    assert.throws(() => bulkVideoSchema.parse({ action: "move", ids: [] }));
  });
});

describe("api keys", () => {
  it("resolves the owner from a secret, never exposes the hash, and stops after revocation", async () => {
    const { key, secret } = await createApiKey("Zapier", "u1");
    assert.ok(secret.startsWith(API_KEY_PREFIX));
    assert.ok(!("hash" in key));
    assert.equal(secret.startsWith(key.prefix), true);
    assert.equal(await ownerForApiKey(secret), "u1");
    assert.equal(await ownerForApiKey(`${secret}x`), null);
    assert.equal(await ownerForApiKey("not-a-key"), null);
    const listed = await listApiKeys("u1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, key.id);
    assert.deepEqual(await listApiKeys("u2"), []);
    assert.equal(await revokeApiKey(key.id, "u2"), false, "another owner cannot revoke it");
    assert.equal(await revokeApiKey(key.id, "u1"), true);
    assert.equal(await ownerForApiKey(secret), null);
  });

  it("caps the number of keys per owner", async () => {
    for (let i = 0; i < MAX_API_KEYS; i++) await createApiKey(`k${i}`, "u3");
    await assert.rejects(createApiKey("one more", "u3"), /At most/);
  });
});

describe("outbound webhooks", () => {
  const HOOK = "https://203.0.113.5/hooks/studio";

  it("rejects private hosts and keeps the secret across URL changes", async () => {
    await assert.rejects(saveNotifySettings({ url: "http://localhost:9/hook" }, "u1"), /public host/);
    await assert.rejects(saveNotifySettings({ url: "ftp://203.0.113.5/x" }, "u1"), /http or https/);
    const first = await saveNotifySettings({ url: HOOK }, "u1");
    assert.ok(first.secret.startsWith("whsec_"));
    const second = await saveNotifySettings({ url: `${HOOK}2` }, "u1");
    assert.equal(second.secret, first.secret);
    assert.equal(await getNotifySettings("u2"), null);
  });

  it("signs deliveries, records the outcome, and fires only on final transitions", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    setNotificationFetch(async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return new Response("ok", { status: 200 });
    });
    try {
      const settings = await saveNotifySettings({ url: HOOK }, "u1");
      const result = await dispatchNotification(settings, "test", { hello: 1 });
      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      const [call] = calls;
      const expected = createHmac("sha256", settings.secret).update(`${call.headers["X-Studio-Timestamp"]}.${call.body}`).digest("hex");
      assert.equal(call.headers["X-Studio-Signature"], `sha256=${expected}`);
      assert.equal(signPayload(settings.secret, call.headers["X-Studio-Timestamp"], call.body), expected);
      assert.equal(JSON.parse(call.body).event, "test");
      assert.equal((await getNotifySettings("u1"))?.lastDelivery?.ok, true);

      const base = { ...(await createVideo({ title: "N", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, "u1")) };
      await notifyVideoTransition(base, { ...base, status: "processing" });
      assert.equal(calls.length, 1, "processing is not a final state");
      await notifyVideoTransition({ ...base, status: "processing" }, { ...base, status: "completed", videoUrl: "https://cdn/x.mp4" });
      assert.equal(calls.length, 2);
      assert.equal(JSON.parse(calls[1].body).event, "video.completed");
      assert.equal(JSON.parse(calls[1].body).data.id, base.id);
      await notifyVideoTransition({ ...base, status: "completed" }, { ...base, status: "completed" });
      assert.equal(calls.length, 2, "no change, no delivery");
      await notifyVideoTransition({ ...base, status: "processing", ownerId: "u2" }, { ...base, status: "failed", ownerId: "u2" });
      assert.equal(calls.length, 2, "owners without a webhook are skipped");

      setNotificationFetch(async () => new Response("nope", { status: 500 }));
      const failed = await dispatchNotification(settings, "test", {});
      assert.equal(failed.ok, false);
      assert.match(failed.error ?? "", /500/);
    } finally {
      setNotificationFetch(null);
    }
  });
});

describe("insights", () => {
  it("buckets renders per UTC day, compares with the previous window, and ranks views", () => {
    const now = Date.parse("2026-10-23T15:00:00Z");
    const mk = (daysAgo: number, extra: Partial<Video> = {}): Video => ({
      id: `v${daysAgo}${extra.title ?? ""}`,
      title: "t",
      script: "s",
      avatarId: "a",
      voiceId: "v",
      aspect: "16:9",
      background: { type: "color", value: "#fff" },
      captions: false,
      speed: 1,
      status: "completed",
      provider: "mock",
      createdAt: new Date(now - daysAgo * 86_400_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      ...extra,
    });
    const videos = [mk(0), mk(0, { title: "b", views: 7 }), mk(13, { views: 2 }), mk(14), mk(20, { status: "failed" }), mk(40), mk(3, { folder: "Listings" }), mk(2, { folder: "Listings", status: "failed" })];
    const r = computeInsights(videos, now);
    assert.equal(r.perDay.length, 14);
    assert.equal(r.perDay[13].day, "2026-10-23");
    assert.equal(r.perDay[13].count, 2);
    assert.equal(r.perDay[0].day, "2026-10-10");
    assert.equal(r.perDay[0].count, 1, "13 days ago is the first day of the window");
    assert.equal(r.totalLast, 5);
    assert.equal(r.totalPrevious, 2, "14 and 20 days ago fall in the previous window; 40 is older");
    assert.equal(r.completionRate, 6 / 8);
    assert.equal(r.totalViews, 9);
    assert.deepEqual(r.topViewed.map((v) => v.views), [7, 2]);
    assert.deepEqual(r.folders, [{ name: "Listings", count: 2 }]);
    assert.equal(computeInsights([], now).completionRate, null);
  });
});

describe("workspaces", () => {
  const alice = { id: "alice", email: "alice@example.com" };
  const bob = { id: "bob", email: "bob@example.com" };

  it("creates, invites, joins, scopes content, and protects the last owner", async () => {
    const ws = await createWorkspace("Acme", alice);
    assert.equal(ws.members[0].role, "owner");
    assert.equal((await listWorkspaces(alice.id)).length, 1);
    assert.deepEqual(await listWorkspaces(bob.id), []);
    assert.equal(await workspaceForMember(ws.id, bob.id), null);

    await assert.rejects(createInvite(ws.id, { role: "editor" }, bob), /not found/);
    const invite = await createInvite(ws.id, { email: bob.email, role: "editor" }, alice);
    assert.ok((await findInvite(invite.token))?.workspace.id === ws.id);
    assert.equal(await findInvite("nope"), null);
    const joined = await acceptInvite(invite.token, bob);
    assert.equal(joined.members.length, 2);
    assert.equal(await findInvite(invite.token), null, "invite consumed");
    await assert.rejects(acceptInvite(invite.token, bob), /invalid or has expired/);
    assert.ok(await workspaceForMember(ws.id, bob.id));

    // Content created under the workspace id is visible to any member and not in personal spaces.
    const v = await createVideo({ title: "Team", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, ws.id);
    assert.equal((await listVideos(ws.id))[0].id, v.id);
    assert.deepEqual(await listVideos(alice.id), []);

    // Editors cannot manage members; the sole owner cannot be removed or demoted.
    await assert.rejects(removeMember(ws.id, alice.id, bob), /Only workspace owners/);
    await assert.rejects(removeMember(ws.id, alice.id, alice), /at least one owner/);
    await assert.rejects(setMemberRole(ws.id, alice.id, "editor", alice), /at least one owner/);
    const pendingForOwner = await createInvite(ws.id, { role: "editor" }, alice);
    assert.equal((await workspaceView(ws, bob)).invites.length, 0, "editors do not see invite tokens");
    assert.equal((await workspaceView(ws, alice)).invites.some((i) => i.token === pendingForOwner.token), true, "owners do");
    await revokeInvite(ws.id, pendingForOwner.token, alice);
    const promoted = await setMemberRole(ws.id, bob.id, "owner", alice);
    assert.equal(promoted.members.find((m) => m.userId === "bob")?.role, "owner");
    assert.equal((await listWorkspaces(bob.id)).length, 1, "membership record lists the workspace for bob");
    const left = await removeMember(ws.id, bob.id, bob);
    assert.equal(left.members.length, 1);
    assert.deepEqual(await listWorkspaces(bob.id), [], "leaving removes the membership record");

    const second = await createInvite(ws.id, { role: "owner" }, alice);
    await revokeInvite(ws.id, second.token, alice);
    assert.equal(await findInvite(second.token), null);
    await assert.rejects(deleteWorkspace(ws.id, bob), /not found/);
    await deleteWorkspace(ws.id, alice);
    assert.deepEqual(await listWorkspaces(alice.id), []);
  });

  it("revokes a departing member's workspace keys and every key on deletion", async () => {
    const ws = await createWorkspace("Keys", alice);
    const inv = await createInvite(ws.id, { role: "editor" }, alice);
    await acceptInvite(inv.token, bob);
    const bobKey = await createApiKey("bob-ci", ws.id, bob.id);
    const aliceKey = await createApiKey("alice-ci", ws.id, alice.id);
    const personal = await createApiKey("bob-personal", bob.id, bob.id);
    assert.equal(await ownerForApiKey(bobKey.secret), ws.id);
    await removeMember(ws.id, bob.id, alice);
    assert.equal(await ownerForApiKey(bobKey.secret), null, "removed member's workspace key is revoked");
    assert.equal(await ownerForApiKey(aliceKey.secret), ws.id, "other members' keys survive");
    assert.equal(await ownerForApiKey(personal.secret), bob.id, "personal keys are untouched");
    await deleteWorkspace(ws.id, alice);
    assert.equal(await ownerForApiKey(aliceKey.secret), null, "deletion revokes every workspace key");
  });
});

describe("invite emails", () => {
  it("builds a safe message with the link and expiry, and the mock records sends", async () => {
    const msg = inviteEmail({ to: "bob@example.com", workspaceName: "Acme <Realty>", inviterEmail: "alice@example.com", role: "editor", url: "https://studio.example.com/invite/abc", expiresAt: "2026-10-30T00:00:00.000Z" });
    assert.equal(msg.subject, 'Join "Acme <Realty>" on Avatar Studio');
    assert.match(msg.text, /alice@example.com invited you/);
    assert.match(msg.text, /https:\/\/studio.example.com\/invite\/abc/);
    assert.match(msg.html, /Acme &lt;Realty&gt;/, "html escapes the workspace name");
    assert.match(msg.html, /href="https:\/\/studio.example.com\/invite\/abc"/);
    const mock = new MockEmailProvider();
    setEmailProvider(mock);
    try {
      assert.equal(mock.delivers, false);
      await mock.send(msg);
      assert.equal(mock.sent.length, 1);
      assert.equal(mock.sent[0].to, "bob@example.com");
    } finally {
      setEmailProvider(undefined);
    }
  });
});

describe("plans and billing", () => {
  const req = { title: "P", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9" as const, background: { type: "color" as const, value: "#fff" }, captions: false, speed: 1 };

  it("plan decides the allowance and the mock provider switches plans", async () => {
    const original = { free: config.renderLimitPerMonth, pro: config.proRendersPerMonth };
    (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = 1;
    (config as { proRendersPerMonth?: number }).proRendersPerMonth = 3;
    setBillingProvider(new MockBillingProvider());
    try {
      assert.equal((await getPlan("u1")).plan, "free");
      assert.equal(await renderLimitFor("u1"), 1);
      await createVideo(req, "u1");
      await assert.rejects(createVideo(req, "u1"), /Monthly render limit reached \(1 of 1\)/);
      const { url } = await new MockBillingProvider().checkout("u1", "https://x/settings");
      assert.match(url, /billing=upgraded/);
      assert.equal((await getPlan("u1")).plan, "pro");
      assert.equal(await renderLimitFor("u1"), 3);
      await createVideo(req, "u1");
      await new MockBillingProvider().portal("u1", "https://x/settings");
      assert.equal((await getPlan("u1")).plan, "free");
      assert.equal((await getPlan("u1")).status, undefined, "downgrade clears subscription state");
      assert.equal((await getPlan("u2")).plan, "free", "plans are per owner");
    } finally {
      (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = original.free;
      (config as { proRendersPerMonth?: number }).proRendersPerMonth = original.pro;
      setBillingProvider(undefined);
    }
  });

  it("verifies Stripe signatures and applies subscription events", async () => {
    const secret = "whsec_test";
    const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { client_reference_id: "u9", customer: "cus_1", subscription: "sub_1" } } });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    assert.equal(verifyStripeSignature(body, `t=${t},v1=${v1}`, secret), true);
    assert.equal(verifyStripeSignature(body, `t=${t},v1=${v1}`, "other"), false);
    assert.equal(verifyStripeSignature(body, `t=${t - 1000},v1=${v1}`, secret), false, "stale timestamp");
    assert.equal(verifyStripeSignature(body, null, secret), false);

    assert.equal(await applyStripeEvent(JSON.parse(body)), "u9");
    const plan = await getPlan("u9");
    assert.equal(plan.plan, "pro");
    assert.equal(plan.customerId, "cus_1");
    assert.equal(plan.subscriptionId, "sub_1");
    assert.equal(await applyStripeEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "active", cancel_at_period_end: true, current_period_end: 1800000000, metadata: { ownerId: "u9" } } } }), "u9");
    assert.equal((await getPlan("u9")).endsAt, new Date(1800000000 * 1000).toISOString());
    assert.equal(await applyStripeEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "canceled", metadata: { ownerId: "u9" } } } }), "u9");
    assert.equal((await getPlan("u9")).plan, "free");
    assert.equal((await getPlan("u9")).customerId, "cus_1", "customer id kept for re-subscribing");
    assert.equal(await applyStripeEvent({ type: "invoice.paid", data: { object: {} } }), null);
    await setPlan("u9", { plan: "pro" });
    assert.equal(await applyStripeEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_2", status: "unpaid", metadata: { ownerId: "u9" } } } }), "u9");
    assert.equal((await getPlan("u9")).plan, "free", "unpaid subscriptions drop to free");
  });
});

describe("interactive avatar", () => {
  it("answers in character from the demo provider and validates the turn", async () => {
    const hello = await chatWithAvatar(chatSchema.parse({ avatarId: "stock_1", instructions: "Open houses in Hillsboro. Book showings online.", messages: [{ role: "user", content: "Hi there" }] }));
    assert.match(hello, /^Hi, I'm /);
    assert.match(hello, /open houses in hillsboro/i, "uses the first sentence of the instructions as the topic");
    const price = await chatWithAvatar(chatSchema.parse({ avatarId: "stock_1", messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }, { role: "user", content: "How much does it cost?" }] }));
    assert.match(price, /pricing/i);
    await assert.rejects(chatWithAvatar(chatSchema.parse({ avatarId: "stock_1", messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }] })), /last message must be from the visitor/);
    await assert.rejects(chatWithAvatar(chatSchema.parse({ avatarId: "nope", messages: [{ role: "user", content: "Hi" }] })), /not found/);
    assert.throws(() => chatSchema.parse({ avatarId: "stock_1", messages: [] }));
  });
});

describe("shared agents", () => {
  it("creates, exposes a safe public view, counts visitor turns, and hides private or deleted agents", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Dana", avatarId: "stock_1", voiceId: "stock_voice_2", instructions: "Secret playbook. Open houses on Saturdays." }), "u1");
    assert.equal((await listAgents("u1"))[0].id, agent.id);
    assert.deepEqual(await listAgents("u2"), []);
    await assert.rejects(getAgent(agent.id, "u2"), /not found/);

    const pub = await publicAgent(agent.id);
    assert.equal(pub.name, "Dana");
    assert.equal(pub.avatar.name, "Ava Chen");
    assert.equal(pub.voiceLanguage, "en-US");
    assert.equal("instructions" in pub, false, "instructions never leave the server");
    assert.equal("ownerId" in pub, false);

    const first = await talkToAgent(agent.id, { messages: [{ role: "user", content: "Hi" }] });
    assert.match(first.reply, /Hi, I'm Ava Chen/);
    assert.match(first.conversationId, /^conv_/);
    await talkToAgent(agent.id, { conversationId: first.conversationId, messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: first.reply }, { role: "user", content: "When?" }] });
    const counted = await getAgent(agent.id, "u1");
    assert.equal(counted.conversations, 1, "a continued visit is one conversation");
    assert.equal(counted.messages, 2);

    // Transcripts: owner-only, one per visit, capped per visit, cleared on demand and on delete.
    const transcripts = await listConversations(agent.id, "u1");
    assert.equal(transcripts.length, 1);
    assert.deepEqual(transcripts[0].messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(transcripts[0].messages[2].content, "When?");
    await assert.rejects(listConversations(agent.id, "u2"), /not found/);
    const other = await talkToAgent(agent.id, { messages: [{ role: "user", content: "New visitor" }] });
    assert.notEqual(other.conversationId, first.conversationId);
    assert.equal((await listConversations(agent.id, "u1")).length, 2);
    let conv = other.conversationId;
    for (let i = 0; i < MAX_TRANSCRIPT_MESSAGES; i++) conv = (await talkToAgent(agent.id, { conversationId: conv, messages: [{ role: "user", content: `turn ${i}` }] })).conversationId;
    const capped = (await listConversations(agent.id, "u1")).find((c) => c.id === conv)!;
    assert.equal(capped.messages.length, MAX_TRANSCRIPT_MESSAGES, "transcript is capped per visit");
    assert.equal(await clearConversations(agent.id, "u1"), 2);
    assert.deepEqual(await listConversations(agent.id, "u1"), []);

    await updateAgent(agent.id, { isPublic: false }, "u1");
    await assert.rejects(publicAgent(agent.id), /not available/);
    await assert.rejects(talkToAgent(agent.id, { messages: [{ role: "user", content: "Hi" }] }), /not available/);
    await assert.rejects(updateAgent(agent.id, { isPublic: true }, "u2"), /not found/);
    await assert.rejects(createAgent(agentSchema.parse({ name: "X", avatarId: "stock_1", voiceId: "nope" }), "u1"), /not available/);
    await deleteAgent(agent.id, "u1");
    await assert.rejects(publicAgent(agent.id), /not available/);
  });
});
