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
  getAvatar,
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
  captureLead,
  listVoices,
  cloneVoice,
  cloneVoiceSchema,
  deleteClonedVoice,
  MAX_CLONED_VOICES,
  exportOwnerData,
  deleteOwnerData,
  recordView,
  scriptSchema,
  updateVideo,
  videoPatchSchema,
  videoRequestSchema,
} from "../services";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { API_KEY_PREFIX, MAX_API_KEYS, createApiKey, listApiKeys, ownerForApiKey, revokeApiKey } from "../api-keys";
import { createHmac } from "node:crypto";
import { computeInsights, finishRateOf } from "../insights";
import { acceptInvite, canManageAccount, createInvite, createWorkspace, deleteWorkspace, findInvite, listWorkspaces, removeMember, revokeInvite, setMemberRole, workspaceForMember, workspaceView } from "../workspaces";
import type { Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { MockEmailProvider, inviteEmail, setEmailProvider } from "../providers/email";
import { forgetMemo, memo } from "../cache";
import { extractReadableText, fetchPageText } from "../webpage";
import { MAX_SESSIONS_PER_SCOPE, SESSION_TTL_MS, closeLiveSession, openLiveSession, resetLiveSessions, setStreamingProvider, speakLive } from "../streaming";
import type { StreamingProvider } from "../providers/types";
import { generateScript } from "../services";
import { MockBillingProvider, applyStripeEvent, getPlan, renderLimitFor, setBillingProvider, setPlan, verifyStripeSignature } from "../billing";
import { config } from "../config";
import { dispatchNotification, emailVideoResult, getNotifySettings, notifyVideoTransition, savePrefs, saveNotifySettings, setNotificationFetch, signPayload } from "../notifications";
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

  it("the library refreshes in-flight renders without a detail visit", async () => {
    const video = await createVideo(videoRequestSchema.parse({ ...base, title: "Rendering" }));
    const [, , duration] = video.providerJobId!.split("_");
    await globalThis.__avatarStudioStore!.put("video", { ...video, providerJobId: `mock_${Date.now() - 60_000}_${duration}` });
    assert.equal((await listVideos(LOCAL_OWNER, false)).find((v) => v.id === video.id)?.status, "processing", "refresh can be skipped");
    const listed = (await listVideos()).find((v) => v.id === video.id)!;
    assert.equal(listed.status, "completed");
    assert.ok(listed.videoUrl);
    // The change was stored, so the next read needs no provider call.
    assert.equal((await getVideo(video.id, LOCAL_OWNER, false)).status, "completed");
  });

  it("concurrent refreshes record a completion once and keep edits made meanwhile", async () => {
    const { refreshStatus } = await import("../services/videos");
    const video = await createVideo(videoRequestSchema.parse({ ...base, title: "Race" }));
    const [, , duration] = video.providerJobId!.split("_");
    const stale = { ...video, providerJobId: `mock_${Date.now() - 60_000}_${duration}` };
    // The library poll and the detail page both hold this snapshot; a folder move lands in between.
    await globalThis.__avatarStudioStore!.put("video", { ...stale, folder: "Listings" });
    const store = (await import("../store")).getStore();
    const originalPut = store.put.bind(store);
    let puts = 0;
    store.put = async (kind, item) => {
      if (kind === "video") puts += 1;
      return originalPut(kind, item);
    };
    const [a, b] = await Promise.all([refreshStatus(stale), refreshStatus(stale)]);
    store.put = originalPut;
    assert.equal(a.status, "completed");
    assert.equal(b.status, "completed");
    assert.equal(puts, 1, "one refresher records (and announces) the transition");
    assert.equal(a.folder, "Listings", "the write builds on the stored record, not the stale snapshot");
    assert.equal((await getVideo(video.id, LOCAL_OWNER, false)).folder, "Listings");
    // A later refresher with the old snapshot sees the stored outcome and writes nothing.
    assert.equal((await refreshStatus(stale)).status, "completed");
  });

  it("a render whose provider check fails sits out of the list refresh for a while", async () => {
    const { isRefreshDeferred, listVideos: list } = await import("../services/videos");
    const video = await createVideo(videoRequestSchema.parse({ ...base, title: "Stuck" }));
    await globalThis.__avatarStudioStore!.put("video", { ...video, providerJobId: "job-from-another-world" });
    let checks = 0;
    const proto = MockAvatarProvider.prototype;
    const originalStatus = proto.getStatus;
    proto.getStatus = async function (id: string) {
      checks += 1;
      return originalStatus.call(this, id);
    };
    try {
      const first = (await list()).find((v) => v.id === video.id)!;
      assert.equal(first.status, "processing", "a failed check does not flip the render");
      assert.equal(checks, 1);
      assert.equal(isRefreshDeferred(video.id), true);
      await list();
      assert.equal(checks, 1, "the next poll leaves it alone");
      assert.equal(isRefreshDeferred(video.id, Date.now() + 61_000), false, "it is checked again later");
    } finally {
      proto.getStatus = originalStatus;
    }
  });

  it("queries the library with filters, sorting, and a page size", async () => {
    const { filterVideos, queryVideos, videoQuerySchema } = await import("../services/videos");
    const a = await createVideo(videoRequestSchema.parse({ ...base, title: "Zulu tour" }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await createVideo(videoRequestSchema.parse({ ...base, title: "Alpha intro", script: "Welcome to the quartz kitchen." }));
    await new Promise((r) => setTimeout(r, 5));
    const c = await createVideo(videoRequestSchema.parse({ ...base, title: "Mike update" }));
    await globalThis.__avatarStudioStore!.put("video", { ...b, folder: "Listings", views: 3 });
    await globalThis.__avatarStudioStore!.put("video", { ...c, status: "failed", providerJobId: undefined });

    const query = (raw: Record<string, string>) => videoQuerySchema.parse(raw);
    const page = await queryVideos(LOCAL_OWNER, query({ limit: "2" }));
    assert.deepEqual(page.videos.map((v) => v.title), ["Mike update", "Alpha intro"], "newest first, two per page");
    assert.equal(page.matched, 3);
    assert.equal(page.total, 3);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.folders, ["Listings"]);
    assert.equal(page.rendering, 2);
    assert.equal((await queryVideos(LOCAL_OWNER, query({}))).hasMore, false, "no limit returns everything");

    const all = await listVideos(LOCAL_OWNER, false);
    assert.deepEqual(filterVideos(all, query({ q: "QUARTZ" })).map((v) => v.id), [b.id], "search covers the script, case-insensitively");
    assert.deepEqual(filterVideos(all, query({ folder: "Listings" })).map((v) => v.id), [b.id]);
    assert.deepEqual(filterVideos(all, query({ folder: "" })).map((v) => v.id), [c.id, a.id], "an empty folder means unfiled");
    assert.deepEqual(filterVideos(all, query({ status: "failed" })).map((v) => v.id), [c.id]);
    assert.deepEqual(filterVideos(all, query({ status: "processing" })).map((v) => v.id), [b.id, a.id]);
    assert.deepEqual(filterVideos(all, query({ sort: "title" })).map((v) => v.title), ["Alpha intro", "Mike update", "Zulu tour"]);
    assert.deepEqual(filterVideos(all, query({ sort: "oldest" })).map((v) => v.id), [a.id, b.id, c.id]);
    assert.deepEqual(filterVideos(all, query({ sort: "views" }))[0].id, b.id);
    assert.throws(() => query({ limit: "0" }));
    assert.throws(() => query({ sort: "random" }));
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

  it("scenes can name their own presenter and voice", async () => {
    const { resolveRenderContext } = await import("../services/videos");
    const req = videoRequestSchema.parse({
      title: "Two presenters",
      avatarId: STOCK_AVATARS[0].id,
      voiceId: STOCK_VOICES[0].id,
      scenes: [
        { script: "Ava opens.", background: { type: "color", value: "#000000" } },
        { script: "Marcus closes.", background: { type: "color", value: "#ffffff" }, avatarId: STOCK_AVATARS[1].id, voiceId: STOCK_VOICES[1].id },
      ],
    });
    const ctx = await resolveRenderContext(req, LOCAL_OWNER);
    assert.equal(ctx.avatar.id, STOCK_AVATARS[0].id);
    assert.deepEqual(Object.keys(ctx.cast.avatars).sort(), [STOCK_AVATARS[0].id, STOCK_AVATARS[1].id].sort());
    assert.deepEqual(Object.keys(ctx.cast.voices).sort(), [STOCK_VOICES[0].id, STOCK_VOICES[1].id].sort());
    const video = await createVideo(req);
    assert.equal(video.status, "processing");
    assert.equal(video.scenes?.[0].avatarName, undefined, "a scene on the video's presenter carries no name of its own");
    assert.equal(video.scenes?.[1].avatarName, STOCK_AVATARS[1].name);
    assert.equal(video.scenes?.[1].voiceName, STOCK_VOICES[1].name);
    assert.equal(video.avatarName, STOCK_AVATARS[0].name);
    await assert.rejects(
      resolveRenderContext({ ...req, scenes: [{ ...req.scenes![1], voiceId: "ghost" }] }, LOCAL_OWNER),
      /Voice ghost is not available/,
    );
    await assert.rejects(resolveRenderContext({ ...req, scenes: [{ ...req.scenes![1], avatarId: "ghost" }] }, LOCAL_OWNER), /not found/);
  });

  it("HeyGen renders one input per scene with that scene's presenter; D-ID refuses a second presenter", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const { DidAvatarProvider } = await import("../providers/avatar/did");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { video_inputs: Array<{ character: { avatar_id?: string }; voice: { voice_id: string } }> } | null = null;
    (heygen as unknown as { client: { generateVideo: (b: unknown) => Promise<{ video_id: string }> } }).client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    const ava = { ...STOCK_AVATARS[0], id: "ava_hg", provider: "heygen", source: "provider" as const };
    const marcus = { ...STOCK_AVATARS[1], id: "marcus_hg", provider: "heygen", source: "provider" as const };
    const emma = { ...STOCK_VOICES[0], id: "emma_hg", provider: "heygen" };
    const james = { ...STOCK_VOICES[1], id: "james_hg", provider: "heygen" };
    const req = videoRequestSchema.parse({
      title: "Two presenters",
      avatarId: ava.id,
      voiceId: emma.id,
      scenes: [
        { script: "Ava opens.", background: { type: "color", value: "#000000" } },
        { script: "Marcus closes.", background: { type: "color", value: "#ffffff" }, avatarId: marcus.id, voiceId: james.id },
      ],
    });
    const cast = { avatars: { [ava.id]: ava, [marcus.id]: marcus }, voices: { [emma.id]: emma, [james.id]: james } };
    assert.equal((await heygen.createVideo(req, ava, emma, cast)).providerJobId, "hg_1");
    assert.deepEqual(sent!.video_inputs.map((i) => [i.character.avatar_id, i.voice.voice_id]), [[ava.id, emma.id], [marcus.id, james.id]]);
    // A scene voice from another provider is refused like the video's voice would be.
    await assert.rejects(heygen.createVideo(req, ava, emma, { ...cast, voices: { ...cast.voices, [james.id]: { ...james, provider: "elevenlabs" } } }), /HeyGen voice/);
    await assert.rejects(new DidAvatarProvider("key").createVideo(req, ava, emma), /one presenter and one voice per video/);
  });

  it("requires a script when no scenes are given", () => {
    assert.throws(() => videoRequestSchema.parse({ title: "x", avatarId: "a", voiceId: "v" }), /Script is required/);
    assert.throws(() => videoRequestSchema.parse({ title: "x", avatarId: "a", voiceId: "v", scenes: [] }));
  });
});

describe("share call to action", () => {
  it("stores a labelled http(s) link and clears it with null", async () => {
    const { updateVideo, videoPatchSchema } = await import("../services/videos");
    const video = await createVideo(videoRequestSchema.parse({ title: "CTA", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }));
    const set = await updateVideo(video.id, videoPatchSchema.parse({ shareCta: { label: "  Book a showing ", url: "https://example.com/book " } }));
    assert.deepEqual(set.shareCta, { label: "Book a showing", url: "https://example.com/book" });
    assert.equal((await getVideo(video.id, LOCAL_OWNER, false)).shareCta?.label, "Book a showing");
    const cleared = await updateVideo(video.id, videoPatchSchema.parse({ shareCta: null }));
    assert.equal(cleared.shareCta, undefined);
    assert.throws(() => videoPatchSchema.parse({ shareCta: { label: "Go", url: "javascript:alert(1)" } }), /http/);
    assert.throws(() => videoPatchSchema.parse({ shareCta: { label: "Go", url: "example.com" } }), /http/);
    assert.throws(() => videoPatchSchema.parse({ shareCta: { label: "x".repeat(41), url: "https://example.com" } }), /40/);
    assert.throws(() => videoPatchSchema.parse({ shareCta: { label: "", url: "https://example.com" } }));
    assert.throws(() => videoPatchSchema.parse({ shareCta: { label: "   ", url: "https://example.com" } }));
    assert.throws(() => videoPatchSchema.parse({ shareCta: {} }));
    assert.throws(() => videoPatchSchema.parse({ shareCta: { label: "Go" } }));
    assert.throws(() => videoPatchSchema.parse({}), /Nothing to update/);
  });

  it("survives patches that do not mention it", async () => {
    const { updateVideo, videoPatchSchema } = await import("../services/videos");
    const video = await createVideo(videoRequestSchema.parse({ title: "CTA", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }));
    await updateVideo(video.id, videoPatchSchema.parse({ shareCta: { label: "Book", url: "https://example.com" } }));
    const renamed = await updateVideo(video.id, videoPatchSchema.parse({ title: "Renamed", shareDownload: true }));
    assert.deepEqual(renamed.shareCta, { label: "Book", url: "https://example.com" });
  });
});

describe("saved templates", () => {
  it("saves a video as a template and reopens it", async () => {
    const { createTemplate, deleteTemplate, getTemplate, listTemplates, templateInputSchema, MAX_TEMPLATES } = await import("../services/templates");
    const video = await createVideo(
      videoRequestSchema.parse({
        title: "Open house",
        avatarId: STOCK_AVATARS[0].id,
        voiceId: STOCK_VOICES[0].id,
        aspect: "9:16",
        resolution: "720p",
        captions: true,
        speed: 1.1,
        scenes: [
          { script: "Welcome.", background: { type: "color", value: "#000000" } },
          { script: "Goodbye.", background: { type: "color", value: "#ffffff" }, avatarId: STOCK_AVATARS[1].id, voiceId: STOCK_VOICES[1].id },
        ],
      }),
    );
    const t = await createTemplate(templateInputSchema.parse({ fromVideoId: video.id, description: "Listing opener" }));
    assert.equal(t.title, "Open house");
    assert.equal(t.description, "Listing opener");
    assert.equal(t.sourceVideoId, video.id);
    assert.deepEqual(t.scenes.map((sc) => sc.script), ["Welcome.", "Goodbye."]);
    assert.equal(t.scenes[1].avatarId, STOCK_AVATARS[1].id);
    assert.equal(t.scenes[1].voiceId, STOCK_VOICES[1].id);
    assert.equal((t.scenes[1] as { avatarName?: string }).avatarName, undefined, "display names are not copied; the render fills them in");
    assert.deepEqual([t.avatarId, t.voiceId, t.aspect, t.resolution, t.captions, t.speed], [STOCK_AVATARS[0].id, STOCK_VOICES[0].id, "9:16", "720p", true, 1.1]);
    assert.equal((await getTemplate(t.id)).id, t.id);
    assert.deepEqual((await listTemplates()).map((x) => x.id), [t.id]);
    // Another owner can neither copy the video nor read the template.
    await assert.rejects(createTemplate({ fromVideoId: video.id }, "someone-else"), /not found/);
    await assert.rejects(getTemplate(t.id, "someone-else"), /not found/);
    await assert.rejects(createTemplate({ fromVideoId: "vid_missing" }), /not found/);
    // Spelled out: title and scenes are required, settings default.
    await assert.rejects(createTemplate(templateInputSchema.parse({ title: "No scenes" })), /at least one scene/);
    const plain = await createTemplate(templateInputSchema.parse({ title: "Plain", scenes: [{ script: "Hi.", background: { type: "color", value: "#fff" } }] }));
    assert.deepEqual([plain.aspect, plain.captions, plain.speed, plain.avatarId], ["16:9", false, 1, undefined]);
    await deleteTemplate(plain.id);
    await assert.rejects(deleteTemplate(plain.id), /not found/);
    assert.equal((await listTemplates()).length, 1);
    // The cap.
    for (let i = 1; i < MAX_TEMPLATES; i++) await createTemplate({ fromVideoId: video.id, title: `T${i}` });
    await assert.rejects(createTemplate({ fromVideoId: video.id }), /up to 50 templates/);
    assert.equal((await listTemplates()).length, MAX_TEMPLATES);
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
    assert.equal((await updateVideo(v.id, { shareDownload: true })).shareDownload, true);
    assert.equal("shareDownload" in (await updateVideo(v.id, { shareDownload: false })), false, "off is stored as absent");
    assert.equal(videoPatchSchema.safeParse({}).success, false, "an empty patch is rejected");
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

  it("prepares a custom portrait once for a whole batch", async () => {
    const { createBatch } = await import("../services");
    const custom = await createAvatar({ name: "Me", imageUrl: "https://example.com/me.jpg" }, "batch-prep");
    let uploads = 0;
    const proto = MockAvatarProvider.prototype as unknown as { prepareAvatar?: (a: typeof custom) => Promise<typeof custom> };
    proto.prepareAvatar = async (a) => {
      if (a.providerAssetIds?.mock) return a;
      uploads += 1;
      return { ...a, providerAssetIds: { ...a.providerAssetIds, mock: "asset_1" } };
    };
    try {
      const result = await createBatch(
        { title: "Hi", scriptTemplate: "Hi {name}.", csv: "name\nA\nB\nC", avatarId: custom.id, voiceId: STOCK_VOICES[0].id, aspect: "16:9", resolution: "1080p", background: { type: "color", value: "#fff" }, captions: false, speed: 1 },
        "batch-prep",
      );
      assert.equal(result.videos.length, 3);
      assert.ok(result.videos.every((v) => v.status === "processing"));
      assert.equal(uploads, 1, "the portrait is uploaded for the first row and reused");
      const stored = await getAvatar(custom.id, "batch-prep");
      assert.equal(stored.providerAssetIds?.mock, "asset_1", "the prepared avatar is persisted");
    } finally {
      delete proto.prepareAvatar;
    }
  });

  it("creates one video per row with substituted scripts and a shared batch id", async () => {
    const { createBatch, previewBatch } = await import("../services");
    const csv = "name,city\nJordan,Austin\nPriya,Denver";
    const preview = previewBatch("Hi {name} from {city}.", csv);
    assert.equal(preview.rowCount, 2);
    assert.deepEqual(preview.missing, []);
    assert.equal(preview.samples[1].script, "Hi Priya from Denver.");
    const store = (await import("../store")).getStore();
    const originalPut = store.put.bind(store);
    let videoPuts = 0;
    store.put = async (kind, item) => {
      if (kind === "video") videoPuts += 1;
      return originalPut(kind, item);
    };
    const result = await createBatch({ title: "Welcome", scriptTemplate: "Hi {name} from {city}.", csv, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect: "16:9", resolution: "1080p", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, "batch-user");
    store.put = originalPut;
    assert.equal(result.videos.length, 2);
    assert.equal(videoPuts, 2, "each batch row is written once, with its batch id and row label");
    assert.ok(result.videos.every((v) => v.batchId === result.batchId));
    assert.equal(result.videos[0].title, "Welcome – Jordan");
    assert.equal(result.videos[0].script, "Hi Jordan from Austin.");
    assert.equal(result.videos[0].rowLabel, "Jordan");
    assert.equal((await listVideos("batch-user")).length, 2);
  });

  it("rejects missing columns and stops at the allowance", async () => {
    const { createBatch } = await import("../services");
    const { config } = await import("../config");
    const base = { title: "W", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect: "16:9" as const, resolution: "1080p" as const, background: { type: "color" as const, value: "#fff" }, captions: false, speed: 1 };
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

  it("reserves a batch of slots whole or not at all", async () => {
    const { reserveRateLimit, resetRateLimit } = await import("../rate-limit");
    const t0 = 2_000_000;
    assert.equal(reserveRateLimit("batch", 7, 10, 60_000, t0).allowed, true);
    const refused = reserveRateLimit("batch", 4, 10, 60_000, t0 + 1);
    assert.equal(refused.allowed, false);
    assert.equal(refused.remaining, 3, "a refused batch leaves the window untouched");
    assert.equal(reserveRateLimit("batch", 3, 10, 60_000, t0 + 2).allowed, true, "the three that fit still go");
    assert.equal(reserveRateLimit("batch", 1, 10, 60_000, t0 + 3).allowed, false);
    assert.equal(reserveRateLimit("batch", 10, 10, 60_000, t0 + 60_001).allowed, true, "window reset");
    resetRateLimit("batch");
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
    // The URL parser drops tabs and newlines before parsing, so these would resolve off-origin.
    for (const sneaky of ["/\t/evil.com", "/\t//evil.com", "/\n/evil.com", "/\r//evil.com", "/\t\\evil.com", "/ /evil.com", "/videos\n"]) {
      assert.equal(safeNextPath(sneaky), "/home", JSON.stringify(sneaky));
      assert.equal(new URL(safeNextPath(sneaky), "https://app.example").origin, "https://app.example");
    }
    assert.equal(safeNextPath("/videos?folder=Q4%20launch#top"), "/videos?folder=Q4%20launch#top");
  });

  it("rejects private and loopback image hosts, accepts public literals", async () => {
    const { assertPublicHttpUrl, isPrivateAddress } = await import("../safe-url");
    for (const bad of ["http://127.0.0.1/x", "http://10.0.0.5:8080/admin", "http://169.254.169.254/latest", "http://[::1]/", "http://localhost/x", "ftp://example.com/x", "http://192.168.1.1/"]) {
      await assert.rejects(assertPublicHttpUrl(bad), Error, bad);
    }
    assert.equal((await assertPublicHttpUrl("https://93.184.216.34/portrait.jpg")).hostname, "93.184.216.34");
    assert.equal((await assertPublicHttpUrl("https://[2606:4700::1111]/x")).hostname, "[2606:4700::1111]");
    assert.equal(isPrivateAddress("::ffff:10.1.1.1"), true);
    assert.equal(isPrivateAddress("8.8.8.8"), false);
    // IPv4-mapped literals arrive from the URL parser in hex form; NAT64 and other non-global ranges stay blocked.
    for (const bad of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[::ffff:10.0.0.5]/", "http://[64:ff9b::7f00:1]/", "http://[fd12::1]/", "http://[fe80::1]/", "http://[::]/"]) {
      await assert.rejects(assertPublicHttpUrl(bad), Error, bad);
    }
    for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:a00:5", "0:0:0:0:0:ffff:7f00:1", "64:ff9b::808:808", "100::1"]) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "2606:4700::1111", "2001:4860:4860::8888"]) assert.equal(isPrivateAddress(ip), false, ip);
  });

  it("pins server-side fetches to the addresses the host check saw", async () => {
    const { resolvePublicHttpUrl } = await import("../safe-url");
    const { pinnedLookup, safeFetch } = await import("../safe-fetch");
    // Literals are their own answer, in both families.
    assert.deepEqual((await resolvePublicHttpUrl("https://93.184.216.34/x")).addresses, [{ address: "93.184.216.34", family: 4 }]);
    assert.deepEqual((await resolvePublicHttpUrl("https://[2606:4700::1111]/x")).addresses, [{ address: "2606:4700::1111", family: 6 }]);
    // The socket-level lookup ignores the name and answers in whichever shape net.connect asks for.
    const lookup = pinnedLookup([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
    await new Promise<void>((resolve) => {
      lookup("evil.example", { all: true }, ((err: unknown, list: Array<{ address: string; family: number }>) => {
        assert.equal(err, null);
        assert.deepEqual(list, [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
        resolve();
      }) as never);
    });
    await new Promise<void>((resolve) => {
      lookup("evil.example", 4, ((err: unknown, address: string, family: number) => {
        assert.equal(err, null);
        assert.equal(address, "93.184.216.34");
        assert.equal(family, 4);
        resolve();
      }) as never);
    });
    // An injected client still goes through the host check.
    const calls: string[] = [];
    const fake = async (input: string) => { calls.push(input); return new Response("ok"); };
    await assert.rejects(safeFetch("http://[::ffff:7f00:1]/", {}, "Page URL", fake), /public host/);
    assert.equal((await safeFetch("https://93.184.216.34/ok", {}, "Page URL", fake)).status, 200);
    assert.deepEqual(calls, ["https://93.184.216.34/ok"]);
  });

  it("reads large bodies through the pinned client and caps them", async () => {
    const { createServer } = await import("node:http");
    const { fetchPinned, ResponseTooLargeError } = await import("../safe-fetch");
    const big = Buffer.alloc(3 * 1024 * 1024, "a");
    const server = createServer((req, res) => {
      if (req.url === "/empty") { res.writeHead(204); res.end(); return; }
      if (req.url === "/hook") { res.writeHead(200, { "content-type": "text/plain" }); res.end(big); return; }
      res.writeHead(200, { "content-type": "text/html", "x-host-seen": req.headers.host ?? "" });
      // Several writes so the body spans many socket reads, like a real download.
      for (let i = 0; i < 3; i++) res.write(big.subarray(i * 1024 * 1024, (i + 1) * 1024 * 1024));
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    // The name never resolves; only the pinned lookup can reach the server.
    const url = new URL(`http://pinned.example.invalid:${port}/page`);
    const pinned = [{ address: "127.0.0.1", family: 4 as const }];
    try {
      const res = await fetchPinned(url, pinned, { signal: AbortSignal.timeout(5_000) }, "Page URL");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-host-seen"), `pinned.example.invalid:${port}`, "Host header keeps the name, not the address");
      assert.equal((await res.arrayBuffer()).byteLength, big.byteLength, "the whole body arrives after the client is torn down");
      await assert.rejects(fetchPinned(url, pinned, { signal: AbortSignal.timeout(5_000) }, "Page URL", { maxBytes: 1_000_000 }), ResponseTooLargeError);
      const hook = await fetchPinned(new URL(`http://pinned.example.invalid:${port}/hook`), pinned, { method: "POST", body: "{}", signal: AbortSignal.timeout(5_000) }, "Webhook URL", { discardBody: true });
      assert.equal(hook.status, 200);
      assert.equal(hook.body, null, "a discarded body is not read");
      const empty = await fetchPinned(new URL(`http://pinned.example.invalid:${port}/empty`), pinned, {}, "URL");
      assert.equal(empty.status, 204);
    } finally {
      server.close();
    }
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
    const base = { title: "W", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect: "16:9" as const, resolution: "1080p" as const, background: { type: "color" as const, value: "#fff" }, captions: false, speed: 1 };
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

  it("counts how far viewers get, once per quarter, under the share rules", async () => {
    const { recordWatch, updateVideo, videoPatchSchema, watchSchema } = await import("../services/videos");
    const v = await createVideo(req);
    assert.throws(() => watchSchema.parse({ quarter: 30 }), /Invalid/);
    assert.deepEqual(await recordWatch(v.id, 25), { watch: { q25: 0, q50: 0, q75: 0, q100: 0 }, counted: false }, "nothing counts before the render completed");
    const fresh = await getVideo(v.id, undefined, false);
    globalThis.__avatarStudioStore!.put("video", { ...fresh, status: "completed" });
    // One viewer's windows: each quarter counts once, however the beacons arrive.
    const seen = new Set<number>();
    const viewer = (q: number) => (seen.has(q) ? false : (seen.add(q), true));
    assert.deepEqual(await recordWatch(v.id, 25, viewer), { watch: { q25: 1, q50: 0, q75: 0, q100: 0 }, counted: true });
    assert.deepEqual(await recordWatch(v.id, 100, viewer), { watch: { q25: 1, q50: 1, q75: 1, q100: 1 }, counted: true }, "the end counts every marker not yet counted, in one write");
    assert.deepEqual(await recordWatch(v.id, 75, viewer), { watch: { q25: 1, q50: 1, q75: 1, q100: 1 }, counted: false }, "nothing left to count for this viewer");
    assert.equal((await getVideo(v.id, undefined, false)).watch?.q75, 1);
    // Beacons that land together (several viewers, or a view and a quarter) lose nothing.
    const before = (await getVideo(v.id, undefined, false)).views ?? 0;
    const burst = await Promise.all([recordWatch(v.id, 25), recordWatch(v.id, 50), recordView(v.id), recordWatch(v.id, 75), recordView(v.id)]);
    assert.ok(burst.every((r) => r.counted));
    const after = await getVideo(v.id, undefined, false);
    assert.deepEqual(after.watch, { q25: 4, q50: 3, q75: 2, q100: 1 }, "every concurrent quarter landed");
    assert.equal(after.views, before + 2, "views landed beside them");
    await updateVideo(v.id, videoPatchSchema.parse({ sharePassword: "letmein1" }));
    assert.equal((await recordWatch(v.id, 50)).counted, false, "a locked link needs the unlock cookie");
    const { getShareLock, shareCookieValue } = await import("../share-lock");
    assert.equal((await recordWatch(v.id, 50, undefined, shareCookieValue((await getShareLock(v.id))!))).counted, true);
    await updateVideo(v.id, videoPatchSchema.parse({ sharePassword: null, shareDisabled: true }));
    await assert.rejects(recordWatch(v.id, 75), /not found/, "an offline link answers like the share page");
    await assert.rejects(recordWatch("vid_missing", 25), /not found/);
  });

  it("owner edits and late webhooks never roll the counters back", async () => {
    const { applyAvatarWebhook, updateVideo, videoPatchSchema } = await import("../services/videos");
    const v = await createVideo(req);
    const fresh = await getVideo(v.id, undefined, false);
    globalThis.__avatarStudioStore!.put("video", { ...fresh, status: "completed" });
    // An edit reads the record, then a view lands before the edit writes: the view survives.
    const [edited] = await Promise.all([updateVideo(v.id, videoPatchSchema.parse({ title: "Renamed" })), recordView(v.id)]);
    assert.equal(edited.title, "Renamed");
    assert.equal(edited.views, 1, "the edit carried the view counted while it was in flight");
    const stored = await getVideo(v.id, undefined, false);
    assert.equal(stored.title, "Renamed");
    assert.equal(stored.views, 1);
    // A provider webhook that repeats a recorded outcome is ignored rather than written over the counts.
    const proto = MockAvatarProvider.prototype as unknown as { parseWebhook?: (body: unknown) => { providerJobId: string; update: { status: "completed" } } | null };
    const original = proto.parseWebhook;
    proto.parseWebhook = (body) => ({ providerJobId: (body as { id: string }).id, update: { status: "completed" } });
    try {
      const late = await applyAvatarWebhook("mock", { id: stored.providerJobId });
      assert.equal(late?.views, 1);
      assert.equal(late?.updatedAt, stored.updatedAt, "nothing was written");
      assert.equal((await getVideo(v.id, undefined, false)).views, 1);
    } finally {
      proto.parseWebhook = original;
    }
  });

  it("takes the share link offline for the public only", async () => {
    const { recordCtaClick, updateVideo, videoPatchSchema } = await import("../services/videos");
    const v = await createVideo(req);
    const fresh = await getVideo(v.id, undefined, false);
    globalThis.__avatarStudioStore!.put("video", { ...fresh, status: "completed", shareCta: { label: "Go", url: "https://example.com" } });
    assert.equal((await getVideo(v.id, null, false)).id, v.id, "public before the switch");
    const off = await updateVideo(v.id, videoPatchSchema.parse({ shareDisabled: true }));
    assert.equal(off.shareDisabled, true);
    await assert.rejects(getVideo(v.id, null, false), /not found/, "public after the switch");
    assert.equal((await getVideo(v.id, undefined, false)).id, v.id, "the owner still sees it");
    await assert.rejects(recordView(v.id), /not found/, "beacons answer like the share page");
    await assert.rejects(recordCtaClick(v.id), /not found/);
    const on = await updateVideo(v.id, videoPatchSchema.parse({ shareDisabled: false }));
    assert.equal("shareDisabled" in on, false);
    assert.equal((await getVideo(v.id, null, false)).id, v.id);
    assert.deepEqual(await recordView(v.id), { views: 1, counted: true });
  });

  it("expires a share link at a set time for the public only", async () => {
    const { recordCtaClick, updateVideo, videoPatchSchema } = await import("../services/videos");
    const { shareExpired, shareOffline } = await import("../client");
    const v = await createVideo(req);
    const fresh = await getVideo(v.id, undefined, false);
    globalThis.__avatarStudioStore!.put("video", { ...fresh, status: "completed", shareCta: { label: "Go", url: "https://example.com" } });
    assert.throws(() => videoPatchSchema.parse({ shareExpiresAt: "yesterday" }), /ISO 8601/);
    assert.throws(() => videoPatchSchema.parse({ shareExpiresAt: "2030-01-01T09:00" }), /UTC offset/, "a wall-clock time without an offset is ambiguous");
    assert.throws(() => videoPatchSchema.parse({ shareExpiresAt: "2001-01-01T00:00:00Z" }), /in the future/);
    const offset = await updateVideo(v.id, videoPatchSchema.parse({ shareExpiresAt: "2030-06-01T10:00:00+02:00" }));
    assert.equal(offset.shareExpiresAt, "2030-06-01T08:00:00.000Z", "stored as a UTC instant");
    const soon = new Date(Date.now() + 60_000).toISOString();
    const set = await updateVideo(v.id, videoPatchSchema.parse({ shareExpiresAt: soon }));
    assert.equal(set.shareExpiresAt, soon);
    assert.equal(shareExpired(set), false);
    assert.equal(shareOffline(set, Date.parse(soon)), true, "the helper takes a clock");
    assert.equal((await getVideo(v.id, null, false)).id, v.id, "public until the time passes");
    assert.deepEqual(await recordView(v.id), { views: 1, counted: true });
    // The moment passes (the stored instant moves behind the clock rather than the test waiting).
    const stored = (await getVideo(v.id, undefined, false)) as Video;
    globalThis.__avatarStudioStore!.put("video", { ...stored, shareExpiresAt: new Date(Date.now() - 1).toISOString() });
    assert.equal(shareExpired(await getVideo(v.id, undefined, false)), true);
    await assert.rejects(getVideo(v.id, null, false), /not found/, "public after the time passes");
    assert.equal((await getVideo(v.id, undefined, false)).id, v.id, "the owner still sees it");
    await assert.rejects(recordView(v.id), /not found/, "beacons answer like the share page");
    await assert.rejects(recordCtaClick(v.id), /not found/);
    const cleared = await updateVideo(v.id, videoPatchSchema.parse({ shareExpiresAt: null }));
    assert.equal("shareExpiresAt" in cleared, false);
    assert.equal((await getVideo(v.id, null, false)).id, v.id, "clearing the expiry reopens the link");
    assert.deepEqual(await recordView(v.id), { views: 2, counted: true });
  });

  it("the in-memory store refuses one id under two kinds, like the single-key table", async () => {
    const store = new MemoryStore();
    await store.put("video", { id: "vid_shared" });
    await assert.rejects(store.put("sharelock", { id: "vid_shared" }), /already belongs to a video record/);
    await store.put("video", { id: "vid_shared", title: "again" });
    await store.remove("video", "vid_shared");
    await store.put("sharelock", { id: "vid_shared" });
  });

  it("protects a share link with a password kept only as a hash", async () => {
    const { updateVideo, videoPatchSchema } = await import("../services/videos");
    const { getShareLock, shareCookieValue, shareUnlocked, verifySharePassword } = await import("../share-lock");
    const { exportOwnerData } = await import("../services/account");
    const v = await createVideo(req);
    const fresh = await getVideo(v.id, undefined, false);
    globalThis.__avatarStudioStore!.put("video", { ...fresh, status: "completed" });
    assert.throws(() => videoPatchSchema.parse({ sharePassword: "abc" }), /at least 4/);
    const locked = await updateVideo(v.id, videoPatchSchema.parse({ sharePassword: "  open sesame " }));
    assert.equal(locked.shareLocked, true);
    assert.equal(JSON.stringify(locked).includes("sesame"), false, "the password never sits on the video");
    const lock = await getShareLock(v.id);
    assert.ok(lock && lock.hash.length === 64 && lock.salt.length === 32);
    // Supabase keeps every kind in one table keyed by id alone: the lock must never share the video's id.
    assert.equal(lock!.id, `sharelock_${v.id}`);
    assert.equal(lock!.videoId, v.id);
    assert.equal((await getVideo(v.id, undefined, false)).shareLocked, true, "the video row survives the lock write");
    assert.equal(await verifySharePassword(v.id, "wrong"), null);
    assert.equal((await verifySharePassword(v.id, "open sesame"))?.videoId, v.id);
    const cookie = shareCookieValue(lock!);
    assert.equal(await shareUnlocked(locked, undefined), false);
    assert.equal(await shareUnlocked(locked, "nope"), false);
    assert.equal(await shareUnlocked(locked, cookie), true);
    assert.equal(await shareUnlocked({ id: "vid_orphan", shareLocked: true }, cookie), false, "marked locked with no lock record stays closed");
    assert.deepEqual(await recordView(v.id), { views: 0, counted: false }, "a beacon without the cookie is not counted");
    assert.deepEqual(await recordView(v.id, () => true, cookie), { views: 1, counted: true });
    // Changing the password invalidates every cookie handed out for the old one.
    await updateVideo(v.id, videoPatchSchema.parse({ sharePassword: "different one" }));
    assert.equal(await shareUnlocked(locked, cookie), false);
    const exported = await exportOwnerData(LOCAL_OWNER);
    const row = exported.sharelock.find((r) => r.videoId === v.id)!;
    assert.ok(row && !("hash" in row) && !("salt" in row), "the export redacts the hash and salt");
    const open = await updateVideo(v.id, videoPatchSchema.parse({ sharePassword: null }));
    assert.equal("shareLocked" in open, false);
    assert.equal(await getShareLock(v.id), null);
    assert.equal(await shareUnlocked(open, undefined), true);
    await updateVideo(v.id, videoPatchSchema.parse({ sharePassword: "back again" }));
    await deleteVideo(v.id);
    assert.equal(await getShareLock(v.id), null, "deleting the video removes its lock");
  });

  it("counts call-to-action clicks only while a completed video carries the button", async () => {
    const { recordCtaClick, updateVideo, videoPatchSchema } = await import("../services/videos");
    const v = await createVideo(req);
    await updateVideo(v.id, videoPatchSchema.parse({ shareCta: { label: "Book", url: "https://example.com" } }));
    assert.deepEqual(await recordCtaClick(v.id), { clicks: 0, counted: false }, "not counted while rendering");
    const fresh = await getVideo(v.id, undefined, false);
    globalThis.__avatarStudioStore!.put("video", { ...fresh, status: "completed" });
    assert.deepEqual(await recordCtaClick(v.id), { clicks: 1, counted: true });
    assert.deepEqual(await recordCtaClick(v.id, () => false), { clicks: 1, counted: false }, "gated repeat is not counted");
    assert.equal((await recordCtaClick(v.id)).clicks, 2);
    assert.ok((await getVideo(v.id, undefined, false)).lastCtaClickAt);
    const removed = await updateVideo(v.id, videoPatchSchema.parse({ shareCta: null }));
    assert.equal(removed.ctaClicks, 2, "the count survives removing the button");
    assert.deepEqual(await recordCtaClick(v.id), { clicks: 2, counted: false }, "no button, no click");
    await assert.rejects(recordCtaClick("vid_missing"), /not found/);
  });
});

describe("send by email", () => {
  it("emails the share link of a live, finished video to de-duplicated recipients", async () => {
    const { shareEmailSchema, shareVideoByEmail, SHARE_EMAILS_PER_HOUR } = await import("../share-email");
    const { updateVideo, videoPatchSchema } = await import("../services/videos");
    const mock = new MockEmailProvider();
    setEmailProvider(mock);
    try {
      const v = await createVideo(videoRequestSchema.parse({ title: "Open <house>", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }));
      const input = shareEmailSchema.parse({ to: [" Jane@Example.com ", "sam@example.com", "jane@example.com"], message: "  Have a look <3 " });
      assert.deepEqual(input.to, ["jane@example.com", "sam@example.com", "jane@example.com"], "trimmed and lower-cased");
      assert.throws(() => shareEmailSchema.parse({ to: [] }), /at least one/);
      assert.throws(() => shareEmailSchema.parse({ to: ["not-an-email"] }), /email address/);
      assert.throws(() => shareEmailSchema.parse({ to: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`) }), /At most 10/);
      const ctx = { origin: "https://studio.example.com/", senderEmail: "alice@example.com", siteName: "Acme" };
      await assert.rejects(shareVideoByEmail(v.id, input, LOCAL_OWNER, ctx), /finished/, "a render in progress has nothing to share yet");
      const fresh = await getVideo(v.id, undefined, false);
      globalThis.__avatarStudioStore!.put("video", { ...fresh, status: "completed", durationSec: 12.4 });
      await updateVideo(v.id, videoPatchSchema.parse({ shareDisabled: true }));
      await assert.rejects(shareVideoByEmail(v.id, input, LOCAL_OWNER, ctx), /off or expired/);
      await updateVideo(v.id, videoPatchSchema.parse({ shareDisabled: false, sharePassword: "letmein1" }));
      const result = await shareVideoByEmail(v.id, input, LOCAL_OWNER, ctx);
      assert.deepEqual(result, { sent: ["jane@example.com", "sam@example.com"], failed: [], delivers: false });
      assert.equal(mock.sent.length, 2);
      const msg = mock.sent[0];
      assert.equal(msg.subject, 'alice@example.com shared a video with you: "Open <house>"');
      assert.match(msg.text, /https:\/\/studio\.example\.com\/share\/vid_/);
      assert.match(msg.text, /\(12s\)/);
      assert.match(msg.text, /Have a look <3/);
      assert.match(msg.text, /password protected/);
      assert.doesNotMatch(msg.text, /letmein1/, "the password never travels in the email");
      assert.match(msg.html, /Open &lt;house&gt;/, "html escapes the title");
      assert.match(msg.html, /Have a look &lt;3/, "html escapes the note");
      assert.match(msg.html, /href="https:\/\/studio\.example\.com\/share\/vid_/);
      assert.equal(msg.replyTo, "alice@example.com", "replies go to the sender, not the app");
      assert.match(msg.text, /You received this because alice@example.com entered your address/);
      await assert.rejects(shareVideoByEmail("vid_missing", input, LOCAL_OWNER, ctx), /not found/);
      await assert.rejects(shareVideoByEmail(v.id, input, "someone-else", ctx), /not found/, "only the owner can send");
      // The hourly allowance counts recipients and is charged to the sender, whatever workspace is active.
      const many = { to: Array.from({ length: 10 }, (_, i) => `r${i}@example.com`) };
      for (let i = 0; i < Math.floor((SHARE_EMAILS_PER_HOUR - 2) / 10); i += 1) await shareVideoByEmail(v.id, many, LOCAL_OWNER, ctx);
      await assert.rejects(shareVideoByEmail(v.id, many, LOCAL_OWNER, ctx), /per hour \(8 left\)/);
      const eight = { to: many.to.slice(0, 8) };
      assert.equal((await shareVideoByEmail(v.id, eight, LOCAL_OWNER, ctx)).sent.length, 8, "a refused batch took nothing: the eight that fit still go");
      await assert.rejects(shareVideoByEmail(v.id, { to: ["one@example.com"] }, LOCAL_OWNER, ctx), /\(0 left\)/);
      const asMember = { ...ctx, senderId: "user_alice" };
      assert.equal((await shareVideoByEmail(v.id, { to: ["one@example.com"] }, LOCAL_OWNER, asMember)).sent.length, 1, "a signed-in sender has their own allowance");
    } finally {
      setEmailProvider(undefined);
      const { resetRateLimit } = await import("../rate-limit");
      for (const key of [`share-email:sender:${LOCAL_OWNER}`, "share-email:sender:user_alice", "share-email:global"]) resetRateLimit(key);
    }
  });

  it("reports recipients the provider refused without failing the rest", async () => {
    const { shareVideoByEmail } = await import("../share-email");
    const flaky = new MockEmailProvider();
    flaky.send = async (m) => {
      if (m.to.startsWith("bad@")) throw new Error("mailbox unavailable");
      flaky.sent.push(m);
    };
    setEmailProvider(flaky);
    try {
      const v = await createVideo(videoRequestSchema.parse({ title: "Partial", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }));
      const fresh = await getVideo(v.id, undefined, false);
      globalThis.__avatarStudioStore!.put("video", { ...fresh, status: "completed" });
      const result = await shareVideoByEmail(v.id, { to: ["good@example.com", "bad@example.com"] }, LOCAL_OWNER, { origin: "http://localhost:3000" });
      assert.deepEqual(result.sent, ["good@example.com"]);
      assert.deepEqual(result.failed, [{ to: "bad@example.com", error: "mailbox unavailable" }]);
      assert.equal(flaky.sent.length, 1);
      assert.doesNotMatch(flaky.sent[0].text, /password/, "no password hint for an open link");
      assert.match(flaky.sent[0].subject, /^Someone shared/);
      assert.equal(flaky.sent[0].replyTo, undefined);
    } finally {
      setEmailProvider(undefined);
      const { resetRateLimit } = await import("../rate-limit");
      for (const key of [`share-email:sender:${LOCAL_OWNER}`, "share-email:global"]) resetRateLimit(key);
    }
  });
});

describe("cover image", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("stores a poster in its own record, serves it back, and removes it with the video", async () => {
    const { updateVideo, videoPatchSchema } = await import("../services/videos");
    const { getCover } = await import("../cover");
    const { exportOwnerData } = await import("../services/account");
    const v = await createVideo(videoRequestSchema.parse({ title: "Cover", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }));
    const set = await updateVideo(v.id, videoPatchSchema.parse({ cover: png }));
    assert.ok(set.cover?.updatedAt);
    assert.equal(set.cover?.mimeType, "image/png");
    assert.equal(set.cover?.bytes, 70);
    assert.equal(JSON.stringify(set).includes("iVBOR"), false, "the bytes never sit on the video");
    const cover = await getCover(v.id);
    assert.equal(cover?.mimeType, "image/png");
    assert.equal(cover?.bytes.byteLength, 70);
    const exported = (await exportOwnerData(LOCAL_OWNER)) as unknown as Record<string, unknown>;
    assert.equal("cover" in exported, false, "the export never loads cover rows");
    const row = (exported.video as { id: string; cover?: { bytes: number } }[]).find((r) => r.id === v.id)!;
    assert.equal(row.cover?.bytes, 70, "the export describes the cover from the video");
    await assert.rejects(updateVideo(v.id, videoPatchSchema.parse({ cover: "data:image/svg+xml;base64,PHN2Zy8+" })), /PNG, JPEG, WebP, or GIF/);
    await assert.rejects(updateVideo(v.id, videoPatchSchema.parse({ cover: "data:image/png,%E0%A4%A" })), /malformed/, "a bad payload is a validation error, not a crash");
    await assert.rejects(updateVideo(v.id, videoPatchSchema.parse({ cover: "data:image/png;base64" })), /malformed/);
    assert.throws(() => videoPatchSchema.parse({ cover: "https://example.com/a.png" }), /uploaded image/);
    const cleared = await updateVideo(v.id, videoPatchSchema.parse({ cover: null }));
    assert.equal("cover" in cleared, false);
    assert.equal(await getCover(v.id), null);
    await updateVideo(v.id, videoPatchSchema.parse({ cover: png }));
    await deleteVideo(v.id);
    assert.equal(await getCover(v.id), null, "deleting the video removes its cover");
  });

  it("refuses a cover over the size limit", async () => {
    const { setCover } = await import("../cover");
    const big = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64")}`;
    await assert.rejects(setCover({ id: "vid_big" }, big), /too large/);
  });
});

describe("favourites", () => {
  it("stars avatars and voices idempotently, keeps the newest 50, and survives an email change", async () => {
    const { getPrefs, toggleFavorite } = await import("../notifications");
    await toggleFavorite({ kind: "avatar", id: "stock_2", on: true }, "fav1");
    await toggleFavorite({ kind: "avatar", id: "stock_2", on: true }, "fav1");
    await toggleFavorite({ kind: "voice", id: "stock_voice_3", on: true }, "fav1");
    assert.deepEqual((await getPrefs("fav1"))?.favoriteAvatarIds, ["stock_2"]);
    assert.deepEqual((await getPrefs("fav1"))?.favoriteVoiceIds, ["stock_voice_3"]);
    await savePrefs({ emailOnComplete: "fav@example.com" }, "fav1");
    assert.deepEqual((await getPrefs("fav1"))?.favoriteAvatarIds, ["stock_2"], "an email change keeps the stars");
    assert.equal((await getPrefs("fav1"))?.emailOnComplete, "fav@example.com");
    for (let i = 0; i < 60; i++) await toggleFavorite({ kind: "avatar", id: `a${i}`, on: true }, "fav1");
    const many = (await getPrefs("fav1"))?.favoriteAvatarIds ?? [];
    assert.equal(many.length, 50);
    assert.equal(many[0], "a10", "the oldest stars fall off first");
    await toggleFavorite({ kind: "voice", id: "stock_voice_3", on: false }, "fav1");
    assert.equal("favoriteVoiceIds" in ((await getPrefs("fav1")) ?? {}), false);
    assert.equal((await getPrefs("someone-else"))?.favoriteAvatarIds, undefined, "stars are per owner");
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
    const videos = [mk(0), mk(0, { title: "b", views: 7, ctaClicks: 3, watch: { q25: 6, q50: 5, q75: 4, q100: 3 } }), mk(13, { views: 2 }), mk(14), mk(20, { status: "failed" }), mk(40), mk(3, { folder: "Listings" }), mk(2, { folder: "Listings", status: "failed" })];
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
    assert.equal(r.totalClicks, 3);
    assert.equal(r.clickRate, 3 / 9);
    assert.equal(computeInsights([], now).clickRate, null, "no views, no rate");
    assert.equal(r.finishRate, 3 / 9, "finishes across the library over views across the library");
    assert.equal(computeInsights([], now).finishRate, null);
    assert.equal(computeInsights([mk(0, { views: 4 })], now).finishRate, null, "views without any watch marks are no data, not 0%");
    assert.equal(computeInsights([mk(0, { views: 4, watch: { q25: 1, q50: 0, q75: 0, q100: 0 } })], now).finishRate, 0, "a mark without a finish is a real 0%");
    assert.equal(finishRateOf(videos[1]), 3 / 7);
    assert.equal(finishRateOf({ views: 0 }), null);
    assert.equal(finishRateOf({ views: 2, watch: { q25: 9, q50: 9, q75: 9, q100: 9 } }), 1, "never above one when counters disagree");
    assert.equal(computeInsights([mk(0, { views: 1, watch: { q25: 5, q50: 5, q75: 5, q100: 5 } })], now).finishRate, 1);
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
    // Account-level actions (wipe, billing) inside the workspace are for owners; personal space is always manageable.
    assert.equal(canManageAccount(ws, alice.id), true);
    assert.equal(canManageAccount(ws, bob.id), false);
    assert.equal(canManageAccount(ws, "stranger"), false);
    assert.equal(canManageAccount(null, bob.id), true);
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
    assert.equal(pub.avatar.name, "Ava Chen", "snapshot of the presenter is stored on the agent");
    assert.equal(agent.avatarImageUrl.startsWith("data:image/svg+xml"), true);
    assert.equal(pub.voiceLanguage, "en-US");
    assert.equal(pub.collectEmail, false);
    const switched = await updateAgent(agent.id, { avatarId: "stock_2" }, "u1");
    assert.equal(switched.avatarName, "Marcus Hill", "changing the avatar refreshes the snapshot");
    assert.equal((await updateAgent(agent.id, { avatarId: "stock_1" }, "u1")).avatarName, "Ava Chen");
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

describe("lead capture and list memo", () => {
  it("stores the visitor on the conversation and notifies the owner's webhook", async () => {
    const calls: string[] = [];
    setNotificationFetch(async (_input, init) => {
      calls.push(String(init?.body));
      return new Response("ok", { status: 200 });
    });
    try {
      await saveNotifySettings({ url: "https://203.0.113.5/hooks/studio" }, "u1");
      const agent = await createAgent(agentSchema.parse({ name: "Dana", avatarId: "stock_1", collectEmail: true }), "u1");
      const turn = await talkToAgent(agent.id, { messages: [{ role: "user", content: "Any open houses?" }] });
      await assert.rejects(captureLead(agent.id, { conversationId: "conv_nope", email: "a@b.co" }), /Conversation not found/);
      await captureLead(agent.id, { conversationId: turn.conversationId, email: "sam@example.com", name: "Sam" });
      const [conv] = await listConversations(agent.id, "u1");
      assert.deepEqual(conv.visitor, { email: "sam@example.com", name: "Sam" });
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0]);
      assert.equal(body.event, "lead.captured");
      assert.equal(body.data.email, "sam@example.com");
      assert.equal(body.data.lastMessage, "Any open houses?");
      await updateAgent(agent.id, { isPublic: false }, "u1");
      await assert.rejects(captureLead(agent.id, { conversationId: turn.conversationId, email: "x@y.co" }), /not available/);
    } finally {
      setNotificationFetch(null);
    }
  });

  it("memoises provider lists for the TTL and dedupes concurrent calls", async () => {
    forgetMemo();
    let n = 0;
    const fn = async () => {
      n += 1;
      return n;
    };
    const [a, b] = await Promise.all([memo("t:x", 1000, fn), memo("t:x", 1000, fn)]);
    assert.equal(a, 1);
    assert.equal(b, 1, "concurrent callers share one fetch");
    assert.equal(await memo("t:x", 1000, fn), 1, "cached within the TTL");
    forgetMemo("t:");
    assert.equal(await memo("t:x", 1000, fn), 2, "refetched after forget");
    await assert.rejects(memo("t:err", 1000, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await memo("t:err", 1000, async () => "recovered"), "recovered", "a failure is not cached");
    assert.ok((await listVoices()).length > 0);
    forgetMemo();
  });
});

describe("script from a web page", () => {
  const HTML = `<!doctype html><html><head><title>12 Maple St &amp; more</title><style>p{}</style><script>var x = "<p>no</p>";</script></head>
<body><nav><a href="/">Home</a> <a href="/about">About</a></nav>
<main><h1>Open house this Saturday</h1><p>This three&#8209;bedroom home sits on a quiet street near the park.</p>
<p>The kitchen was renovated in 2024 with new appliances &amp; quartz counters. Showings start at 10&nbsp;am.</p></main>
<footer>Copyright</footer></body></html>`;

  it("extracts the title and readable text, dropping chrome and scripts", () => {
    const out = extractReadableText(HTML);
    assert.equal(out.title, "12 Maple St & more");
    assert.match(out.text, /^Open house this Saturday\n/);
    assert.match(out.text, /quartz counters/);
    assert.match(out.text, /10 am/);
    assert.doesNotMatch(out.text, /Home|About|Copyright|var x|p\{\}/);
  });

  it("fetches only public HTML pages within limits and feeds the writer", async () => {
    const fake = (async (input: string | URL | Request, _init?: RequestInit) => {
      const u = String(input);
      if (u.endsWith("/listing")) return new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      if (u.endsWith("/pdf")) return new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } });
      if (u.endsWith("/big")) return new Response("x", { status: 200, headers: { "content-type": "text/html", "content-length": "5000000" } });
      if (u.endsWith("/tiny")) return new Response("<html><body>hi</body></html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const page = await fetchPageText("https://203.0.113.5/listing", fake);
    assert.equal(page.title, "12 Maple St & more");
    await assert.rejects(fetchPageText("http://localhost:3000/listing", fake), /public host/);
    await assert.rejects(fetchPageText("https://203.0.113.5/pdf", fake), /not an HTML page/);
    await assert.rejects(fetchPageText("https://203.0.113.5/big", fake), /too large/);
    await assert.rejects(fetchPageText("https://203.0.113.5/tiny", fake), /too little readable text/);
    await assert.rejects(fetchPageText("https://203.0.113.5/missing", fake), /returned 404/);
    // A 3xx under redirect: "error" surfaces as "fetch failed" with the reason on `cause`.
    const redirecting = (async () => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); }) as typeof fetch;
    await assert.rejects(fetchPageText("https://203.0.113.5/moved", redirecting), /That address redirects/);
    // Without an injected client the writer takes the pinned path, which starts with the same host check.
    await assert.rejects(generateScript(scriptSchema.parse({ url: "http://127.0.0.1/listing", lengthSec: 45 })), /public host/);

    const script = await generateScript(scriptSchema.parse({ url: "https://203.0.113.5/listing", lengthSec: 45 }), fake);
    assert.match(script, /12 Maple St & more/, "topic defaults to the page title");
    assert.match(script, /quiet street near the park/, "demo writer reads from the page");
    assert.throws(() => scriptSchema.parse({ topic: "" }), /topic or a page URL/);
    assert.ok(scriptSchema.parse({ url: "https://example.com/x" }));
  });
});

describe("live avatar sessions", () => {
  it("reports unavailable in demo mode and scopes, caps, and expires sessions with a live provider", async () => {
    resetLiveSessions();
    setStreamingProvider(undefined);
    assert.equal(await openLiveSession({ avatarId: "stock_1", scope: "agent_1", clientKey: "c1" }), null, "mock provider: no live video");

    const spoken: string[] = [];
    const stopped: string[] = [];
    let n = 0;
    const fake: StreamingProvider = {
      name: "fake",
      available: true,
      async createSession() {
        n += 1;
        return { providerSessionId: `p${n}`, url: "wss://live.example", accessToken: `t${n}` };
      },
      async speak(id, text) {
        spoken.push(`${id}:${text}`);
      },
      async stop(id) {
        stopped.push(id);
      },
    };
    setStreamingProvider(fake);
    try {
      const t0 = 1_000_000;
      const s = await openLiveSession({ avatarId: "stock_1", scope: "agent_1", clientKey: "c1" }, t0);
      assert.ok(s && s.sessionId.startsWith("live_") && s.url === "wss://live.example");
      await speakLive(s!.sessionId, "agent_1", "Hello", t0 + 1000);
      assert.deepEqual(spoken, ["p1:Hello"]);
      await assert.rejects(speakLive(s!.sessionId, "agent_2", "Hi", t0 + 1000), /not found/, "another presenter cannot drive the session");
      await assert.rejects(speakLive("live_nope", "agent_1", "Hi", t0 + 1000), /not found/);

      for (let i = 1; i < MAX_SESSIONS_PER_SCOPE; i++) await openLiveSession({ avatarId: "stock_1", scope: "agent_1", clientKey: "c1" }, t0);
      await assert.rejects(openLiveSession({ avatarId: "stock_1", scope: "agent_1", clientKey: "c1" }, t0), /Too many live sessions/);
      assert.ok(await openLiveSession({ avatarId: "stock_1", scope: "agent_1", clientKey: "c2" }, t0), "another client is not affected");

      await closeLiveSession(s!.sessionId, "agent_1", t0 + 2000);
      assert.deepEqual(stopped, ["p1"]);
      await assert.rejects(speakLive(s!.sessionId, "agent_1", "Hi", t0 + 2000), /not found/, "closed sessions are gone");

      const late = await openLiveSession({ avatarId: "stock_1", scope: "agent_9", clientKey: "c9" }, t0);
      await assert.rejects(speakLive(late!.sessionId, "agent_9", "Hi", t0 + SESSION_TTL_MS + 1), /not found/, "idle sessions expire");
    } finally {
      setStreamingProvider(undefined);
      resetLiveSessions();
    }
  });
});

describe("voice cloning", () => {
  const sample = `data:audio/webm;base64,${Buffer.from("not really audio, but bytes").toString("base64")}`;

  it("clones with the provider, lists the voice first for its owner, renders with it, and deletes", async () => {
    const voice = await cloneVoice(cloneVoiceSchema.parse({ name: "Dana", samples: [sample], language: "en-US" }), "u1");
    assert.match(voice.id, /^clone_/);
    assert.equal(voice.source, "custom");
    const mine = await listVoices("u1");
    assert.equal(mine[0].id, voice.id, "cloned voices come first");
    assert.equal((await listVoices("u2")).some((v) => v.id === voice.id), false, "private to the owner");
    assert.equal((await listVoices()).some((v) => v.id === voice.id), false, "provider list alone has no clones");

    const video = await createVideo({ title: "V", script: "Hi.", avatarId: "stock_1", voiceId: voice.id, aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, "u1");
    assert.equal(video.voiceName, "Dana");
    await assert.rejects(createVideo({ title: "V", script: "Hi.", avatarId: "stock_1", voiceId: voice.id, aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, "u2"), /not available/);

    await assert.rejects(cloneVoice(cloneVoiceSchema.parse({ name: "x", samples: ["data:image/png;base64,AAAA"] }), "u1"), /audio recordings or files/);
    assert.throws(() => cloneVoiceSchema.parse({ name: "x", samples: [] }));
    await assert.rejects(deleteClonedVoice(voice.id, "u2"), /not found/);
    await deleteClonedVoice(voice.id, "u1");
    assert.equal((await listVoices("u1")).some((v) => v.id === voice.id), false);
  });

  it("shared presenters can use a cloned voice", async () => {
    const voice = await cloneVoice(cloneVoiceSchema.parse({ name: "Dana", samples: [sample], language: "en-GB" }), "u1");
    const agent = await createAgent(agentSchema.parse({ name: "Dana live", avatarId: "stock_1", voiceId: voice.id }), "u1");
    assert.equal(agent.voiceLanguage, "en-GB");
    await assert.rejects(createAgent(agentSchema.parse({ name: "x", avatarId: "stock_1", voiceId: voice.id }), "u2"), /not available/, "another account cannot use it");
  });

  it("caps cloned voices per account", async () => {
    for (let i = 0; i < MAX_CLONED_VOICES; i++) await cloneVoice(cloneVoiceSchema.parse({ name: `v${i}`, samples: [sample] }), "u3");
    await assert.rejects(cloneVoice(cloneVoiceSchema.parse({ name: "one more", samples: [sample] }), "u3"), /At most/);
  });
});

describe("brand kit default quality", () => {
  it("stores a default output quality and rejects unknown values", async () => {
    await saveBrandKit(brandKitSchema.parse({ primaryColor: "#0f766e", defaultResolution: "720p" }), "u-brand-q");
    assert.equal((await getBrandKit("u-brand-q"))?.defaultResolution, "720p");
    assert.equal(brandKitSchema.safeParse({ primaryColor: "#0f766e", defaultResolution: "4k" }).success, false);
    await deleteBrandKit("u-brand-q");
  });
});

describe("retrying a failed render", () => {
  it("submits the same request as a new video, keeps folder and batch row, and refuses other states", async () => {
    const { retryVideo, ConflictError, NotFoundError } = await import("../services");
    const { getStore } = await import("../store");
    const ok = await createVideo({ title: "Fine", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, "u1");
    const failed: Video = { ...ok, id: "vid_failed", status: "failed", error: "provider hiccup", providerJobId: undefined, folder: "Q4", batchId: "batch_1", rowLabel: "Ann", resolution: "720p", scenes: [{ script: "Hi.", background: ok.background }] };
    await getStore().put("video", failed);

    // One store write per retry: a provider webhook can arrive as soon as the job exists, so no second put may overwrite it.
    const store = getStore();
    const originalPut = store.put.bind(store);
    let videoPuts = 0;
    store.put = async (kind, item) => {
      if (kind === "video") videoPuts += 1;
      return originalPut(kind, item);
    };
    let again: Video;
    try {
      again = await retryVideo("vid_failed", "u1");
    } finally {
      store.put = originalPut;
    }
    assert.equal(videoPuts, 1, "retry writes the new video once");
    assert.notEqual(again.id, failed.id);
    assert.equal(again.status, "processing");
    assert.equal(again.title, "Fine");
    assert.equal(again.resolution, "720p");
    assert.deepEqual(again.scenes, failed.scenes);
    assert.equal(again.folder, "Q4");
    assert.equal(again.batchId, "batch_1");
    assert.equal(again.rowLabel, "Ann");
    assert.equal(again.retryOf, "vid_failed");
    assert.equal((await getVideo("vid_failed", "u1", false)).status, "failed", "the original is kept");

    await assert.rejects(retryVideo(ok.id, "u1"), ConflictError);
    await assert.rejects(retryVideo("vid_failed", "u2"), NotFoundError);
  });
});

describe("account data", () => {
  it("exports every kind with secrets redacted and deletes everything for the owner only", async () => {
    await createVideo({ title: "Mine", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, "u1");
    await createVideo({ title: "Theirs", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, "u2");
    await createApiKey("ci", "u1");
    await saveNotifySettings({ url: "https://203.0.113.5/hooks" }, "u1");
    await savePrefs({ emailOnComplete: "dana@example.com" }, "u1");
    await cloneVoice(cloneVoiceSchema.parse({ name: "v", samples: [`data:audio/webm;base64,${Buffer.from("x").toString("base64")}`] }), "u1");
    const exported = await exportOwnerData("u1");
    assert.equal(exported.ownerId, "u1");
    assert.equal((exported.prefs[0] as { emailOnComplete: string }).emailOnComplete, "dana@example.com", "email preferences are personal data");
    assert.equal(exported.video.length, 1);
    assert.equal((exported.video[0] as { title: string }).title, "Mine");
    assert.equal("hash" in exported.apikey[0], false, "key hashes are redacted");
    assert.equal("secret" in exported.notify[0], false, "webhook secret is redacted");
    assert.equal(exported.voice.length, 1);
    const counts = await deleteOwnerData("u1");
    assert.equal(counts.video, 1);
    assert.equal(counts.apikey, 1);
    assert.equal(counts.voice, 1);
    assert.equal(counts.prefs, 1);
    assert.deepEqual(await listVideos("u1"), []);
    assert.equal((await listVideos("u2")).length, 1, "other owners are untouched");
    assert.equal((await exportOwnerData("u1")).video.length, 0);
  });
});

describe("render result emails", () => {
  it("emails the owner on completion and failure when an address is set, and stays quiet otherwise", async () => {
    const mock = new MockEmailProvider();
    setEmailProvider(mock);
    try {
      const video = await createVideo({ title: "Tour <b>", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1 }, "u1");
      await notifyVideoTransition(video, { ...video, status: "completed", videoUrl: "https://cdn/x.mp4", durationSec: 12 });
      assert.equal(mock.sent.length, 0, "no address, no email");
      await savePrefs({ emailOnComplete: "dana@example.com" }, "u1");
      await notifyVideoTransition(video, { ...video, status: "completed", videoUrl: "https://cdn/x.mp4", durationSec: 12 });
      assert.equal(mock.sent.length, 1);
      assert.equal(mock.sent[0].to, "dana@example.com");
      assert.match(mock.sent[0].subject, /is ready/);
      assert.match(mock.sent[0].text, /\/videos\/vid_/);
      assert.match(mock.sent[0].html, /Tour &lt;b&gt;/, "html escapes the title");
      assert.equal(await emailVideoResult({ ...video, status: "failed", error: "Provider quota exceeded" }), true);
      assert.match(mock.sent[1].subject, /could not be rendered/);
      assert.match(mock.sent[1].text, /Provider quota exceeded/);
      await savePrefs({}, "u1");
      assert.equal(await emailVideoResult({ ...video, status: "completed" }), false, "turned off");
      await notifyVideoTransition({ ...video, status: "completed" }, { ...video, status: "completed" });
      assert.equal(mock.sent.length, 2, "no transition, no email");
    } finally {
      setEmailProvider(undefined);
    }
  });
});
