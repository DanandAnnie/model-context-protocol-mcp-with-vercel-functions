// Videos HeyGen's Video Agent directs: a brief (the request, its length and language, and any page or document) handed
// to HeyGen, which writes, casts, and renders the whole video; followed as the agent's session until it names its
// render, then as that render; and, with no script kept here, not resized, subtitled, captioned, copied, or saved as a
// template. And the requests HeyGen's Video Agent gets.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addSubtitles, createTemplate, directAgentVideo, getAvatar, getVideo, queryVideos, resizeVideo, retryVideo, saveCaptionCues, videoAgentSchema, videoQuerySchema } from "../services";
import { asksForPortrait } from "../services/video-agent";
import { NotFoundError, ValidationError } from "../errors";
import { shareBodyFor } from "../share-body";
import { providerStatus } from "../providers";
import { HEYGEN_LOOK_KEY, HeyGenAvatarProvider } from "../providers/avatar/heygen";
import { getStore } from "../store";
import { MAX_DIRECTED_BRIEF, type Avatar, type Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const ASK = { prompt: "A one-minute welcome for new customers of our dental clinic: what the first visit is like.", mode: "direct" as const };

describe("videos HeyGen's Video Agent directs", () => {
  it("hands the brief over as a library video with no script, captions, or presenter of its own", async () => {
    assert.equal(providerStatus().directedVideos, true);
    const video = await directAgentVideo(videoAgentSchema.parse({ ...ASK, lengthSec: 90, language: "Spanish" }), "u1");
    assert.equal(video.status, "processing");
    assert.match(video.providerJobId ?? "", /^mockagent_\d+$/, "followed as the agent's session first");
    assert.deepEqual([video.script, video.captions, video.aspect, video.avatarId, video.voiceId, video.avatarName], ["", false, "16:9", "", "", undefined]);
    assert.deepEqual(video.directed, { brief: `Length: about 90 seconds. Language: Spanish.\n\n${ASK.prompt}`, prompt: ASK.prompt, orientation: "landscape", autoOrientation: true, lengthSec: 90, language: "Spanish" });
    assert.equal(video.title, ASK.prompt.slice(0, 79).replace(/\s+\S*$/, "") + "…", "named after the request's first words");
  });

  it("names the presenter and voice it was told to use, as the account's own", async () => {
    const avatar = await getAvatar("stock_2", "u1");
    const video = await directAgentVideo(videoAgentSchema.parse({ ...ASK, avatarId: "stock_2", voiceId: "stock_voice_2", orientation: "portrait" }), "u1");
    assert.deepEqual([video.avatarId, video.avatarName, video.directed?.avatarName, video.aspect, video.directed?.orientation], ["stock_2", avatar.name, avatar.name, "9:16", "portrait"]);
    assert.ok(video.directed?.voiceName);
    const theirs: Avatar = { id: "av_theirs", name: "Theirs", imageUrl: "https://93.184.216.34/p.png", source: "custom", provider: "mock", ownerId: "u2", createdAt: new Date().toISOString() };
    await getStore().put("avatar", theirs);
    await assert.rejects(directAgentVideo(videoAgentSchema.parse({ ...ASK, avatarId: "av_theirs" }), "u1"), NotFoundError);
    await assert.rejects(directAgentVideo(videoAgentSchema.parse({ ...ASK, voiceId: "voice_nobody_has" }), "u1"), ValidationError);
    assert.equal((await getStore().list<Video>("video", "u1")).length, 1, "nothing is stored for a refused start");
  });

  it("makes landscape or portrait only, reading a vertical format from the request when left to it", async () => {
    await assert.rejects(directAgentVideo(videoAgentSchema.parse({ ...ASK, orientation: "square" }), "u1"), /landscape or portrait/);
    const tiktok = await directAgentVideo(videoAgentSchema.parse({ ...ASK, prompt: "A TikTok with three quick tips for staging a home" }), "u1");
    assert.deepEqual([tiktok.aspect, tiktok.directed?.orientation], ["9:16", "portrait"]);
    assert.equal(asksForPortrait("Instagram Reels about our menu"), true);
    assert.equal(asksForPortrait("A product update for the team"), false);
    // Words that only sound like a vertical format are not one.
    for (const landscape of ["Three customer success stories", "A highlight reel of our conference", "Our summer shorts line", "A portrait of our founder"]) assert.equal(asksForPortrait(landscape), false, landscape);
    // A wide format named outright wins over a platform mentioned in passing.
    for (const wide of ["A landscape explainer, not a TikTok", "A YouTube video about our TikTok strategy"]) assert.equal(asksForPortrait(wide), false, wide);
    for (const vertical of ["A YouTube Shorts teaser", "Instagram stories for the launch", "A vertical video for the lobby screen", "9:16 please"]) assert.equal(asksForPortrait(vertical), true, vertical);
  });

  it("folds an attached document into the brief, within what HeyGen takes", async () => {
    const text = "Our clinic opens at eight. ".repeat(400).trim();
    const video = await directAgentVideo(videoAgentSchema.parse({ ...ASK, document: { name: "faq.txt", text } }), "u1");
    const brief = video.directed!.brief;
    assert.ok(brief.length <= MAX_DIRECTED_BRIEF);
    assert.match(brief, /^Length: about 60 seconds\. Language: English\.\n\nA one-minute welcome[^\n]*\n\nWrite from these sources, using only their facts:\nOur clinic opens at eight\./);
    assert.equal(video.directed!.documentName, "faq.txt", "the document is named, so asking again can say it was not kept");
    assert.ok(brief.endsWith("."), "cut at a sentence end");
    assert.equal(video.directed!.prompt, ASK.prompt, "the page shows the request as typed");
  });

  it("refuses a request too long for the brief, rather than cutting it or dropping its sources", async () => {
    const long = "word ".repeat(1995).trim();
    await assert.rejects(directAgentVideo(videoAgentSchema.parse({ ...ASK, prompt: long }), "u1"), /shorten the request by \d+/);
    const nearly = "word ".repeat(1900).trim();
    await assert.rejects(directAgentVideo(videoAgentSchema.parse({ ...ASK, prompt: nearly, document: { name: "notes.txt", text: "Important fact." } }), "u1"), /no room for the attached document[\s\S]*remove the document/);
    assert.equal((await getStore().list<Video>("video", "u1")).length, 0, "nothing is started or counted");
    const fits = await directAgentVideo(videoAgentSchema.parse({ ...ASK, prompt: nearly }), "u1");
    assert.ok(fits.directed!.brief.endsWith("word"), "a request that fits is sent whole");
  });

  it("follows the session until it names its render, then the render, to the finished video", async () => {
    const video = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
    const started = Number(/^mockagent_(\d+)$/.exec(video.providerJobId!)![1]);
    // Halfway, the session names its render; the stored job moves to it.
    await getStore().put("video", { ...video, providerJobId: `mockagent_${started - 7_000}` });
    const moved = await getVideo(video.id, "u1");
    assert.deepEqual([moved.status, moved.providerJobId], ["processing", `mock_${started - 7_000}_30`]);
    assert.equal((await getStore().get<Video>("video", video.id))!.providerJobId, `mock_${started - 7_000}_30`, "stored, so the next check follows the render");
    // Once that render is done, the video is.
    await getStore().put("video", { ...moved, providerJobId: `mock_${started - 20_000}_30` });
    const done = await getVideo(video.id, "u1");
    assert.equal(done.status, "completed");
    assert.ok(done.videoUrl);
  });

  it("is retried with the same brief, and is not resized, subtitled, captioned, copied, or saved as a template", async () => {
    const video = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
    await assert.rejects(resizeVideo(video.id, { aspects: ["9:16"] }, "u1"), /made for its own shape/);
    await assert.rejects(createTemplate({ fromVideoId: video.id }, "u1"), /no script here to save as a template/);
    await assert.rejects(addSubtitles(video.id, "Spanish", "u1", async () => "x"), /no script here to subtitle/);
    await assert.rejects(saveCaptionCues(video.id, { cues: [{ startMs: 0, endMs: 1000, text: "Hi" }] }, "u1"), /no captions to edit/);
    await getStore().put("video", { ...video, id: "vid_directed_failed", status: "failed", error: "boom", providerJobId: undefined });
    const retried = await retryVideo("vid_directed_failed", "u1");
    assert.equal(retried.status, "processing");
    assert.deepEqual(retried.directed, video.directed);
  });

  it("is found by its request, and shows no transcript when shared", async () => {
    const video = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
    assert.deepEqual((await queryVideos("u1", videoQuerySchema.parse({ q: "dental clinic" }))).videos.map((v) => v.id), [video.id]);
    await getStore().put("video", { ...video, status: "completed", videoUrl: "https://93.184.216.34/v.mp4" });
    const body = shareBodyFor((await getStore().get<Video>("video", video.id))!, null) as unknown as Record<string, unknown>;
    assert.equal("transcripts" in body, false);
    assert.equal("script" in body, false);
  });

  it("is refused by a renderer without HeyGen's Video Agent", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().directedVideos, false);
      await assert.rejects(directAgentVideo(videoAgentSchema.parse(ASK), "u1"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });

  it("asks HeyGen's Video Agent for a one-shot video, and follows its session to the video it renders", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const realFetch = globalThis.fetch;
    let refuse = false;
    let session: Record<string, unknown> = { session_id: "sess_1", status: "thinking", video_id: null };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "https://api.heygen.com/v3/video-agents" && init?.method === "POST") {
        if (refuse) return Response.json({ error: { code: "invalid_parameter", message: "prompt is too vague" } }, { status: 400 });
        return Response.json({ data: { session_id: "sess_1", status: "thinking", video_id: null } });
      }
      if (url === "https://api.heygen.com/v3/video-agents/sess_1") return Response.json({ data: session });
      if (url === "https://api.heygen.com/v3/video-agents/sess_gone") return Response.json({ error: { code: "not_found" } }, { status: 404 });
      if (url === "https://api.heygen.com/v3/videos/hg_vid_1") return Response.json({ data: { status: "completed", video_url: "https://cdn/v.mp4", thumbnail_url: "https://cdn/v.jpg", duration: 44 } });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    try {
      const provider = new HeyGenAvatarProvider("hg_key");
      const photo: Avatar = { id: "av_photo", name: "Dana", imageUrl: "https://93.184.216.34/d.png", source: "custom", provider: "heygen", ownerId: "u1", providerAssetIds: { [HEYGEN_LOOK_KEY]: "look_dana" }, createdAt: new Date().toISOString() };
      const req = { title: "x", script: "", avatarId: "av_photo", voiceId: "hg_voice", aspect: "9:16" as const, resolution: "1080p" as const, background: { type: "color" as const, value: "#000000" }, captions: false, speed: 1, directed: { brief: "The brief.", prompt: "The brief.", orientation: "portrait" as const, lengthSec: 60, language: "English" } };
      const voice = { id: "hg_voice", name: "June", provider: "heygen", gender: "female" as const, language: "English" };
      const started = await provider.startDirected(req, photo, voice);
      assert.match(started.providerJobId, /^agent_\d+_sess_1$/, "the session, with when it started");
      assert.deepEqual(calls[0].body, { prompt: "The brief.", mode: "generate", orientation: "portrait", avatar_id: "look_dana", voice_id: "hg_voice" }, "the photo avatar's HeyGen look, and HeyGen's own voice id");
      await provider.startDirected({ ...req, directed: { ...req.directed, orientation: "landscape" } }, null, null);
      assert.deepEqual(calls[1].body, { prompt: "The brief.", mode: "generate", orientation: "landscape" }, "HeyGen chooses the presenter and voice when none is named");
      assert.deepEqual(await provider.getStatus(started.providerJobId), { status: "processing" });
      session = { ...session, status: "generating", video_id: "hg_vid_1" };
      assert.deepEqual(await provider.getStatus(started.providerJobId), { status: "completed", videoUrl: "https://cdn/v.mp4", thumbnailUrl: "https://cdn/v.jpg", durationSec: 44, providerJobId: "hg_vid_1" });
      session = { session_id: "sess_1", status: "failed", video_id: null, failure_message: "The brief broke a content rule" };
      assert.deepEqual(await provider.getStatus(started.providerJobId), { status: "failed", error: "The brief broke a content rule" });
      // A session that finished without a video, one HeyGen no longer has, or one that never started a render, has failed.
      session = { session_id: "sess_1", status: "completed", video_id: null };
      assert.match((await provider.getStatus(started.providerJobId)).error ?? "", /finished without a video/);
      assert.match((await provider.getStatus(`agent_${Date.now()}_sess_gone`)).error ?? "", /no longer has this Video Agent session/);
      session = { session_id: "sess_1", status: "thinking", video_id: null };
      assert.match((await provider.getStatus(`agent_${Date.now() - 4 * 60 * 60 * 1000}_sess_1`)).error ?? "", /did not start a render in three hours/);
      refuse = true;
      await assert.rejects(provider.startDirected(req, null, null), (e: unknown) => e instanceof ValidationError && /HeyGen's Video Agent could not take that brief: prompt is too vague/.test((e as Error).message));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
