// Videos HeyGen's Video Agent directs: a brief (the request, its length and language, and any page or document) handed
// to HeyGen, which writes, casts, and renders the whole video; followed as the agent's session until it names its
// render, then as that render; and, with no script kept here, not resized, subtitled, captioned, copied, or saved as a
// template. And the requests HeyGen's Video Agent gets.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addSubtitles, agentConversation, answerAgent, applyAvatarWebhook, createTemplate, directAgentVideo, directedVideoScenes, editDirectedVideo, sceneEditSchema, getAvatar, getVideo, queryVideos, resizeVideo, retryVideo, saveCaptionCues, videoAgentSchema, videoQuerySchema } from "../services";
import { asksForPortrait, generateAgentVideo, listAgentStyles, planVideo } from "../services/video-agent";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
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
    // The shape named outright, and the platform named first, decide.
    for (const vertical of ["A vertical video for YouTube", "9:16 teaser for our YouTube channel", "A TikTok promoting our YouTube channel", "A portrait video, not landscape", "Instagram Reels, vertical, no horizontal footage", "A YouTube-Shorts teaser"]) assert.equal(asksForPortrait(vertical), true, vertical);
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

  it("leaves a job a webhook moved alone when a check of the old one answers late", async () => {
    const { refreshStatus } = await import("../services");
    const video = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
    const stale = { ...video, providerJobId: `mockagent_${Date.now() - 7_000}` };
    await getStore().put("video", { ...video, providerJobId: "hg_render_1" });
    const after = await refreshStatus(stale);
    assert.equal(after.providerJobId, "hg_render_1");
    assert.equal((await getStore().get<Video>("video", video.id))!.providerJobId, "hg_render_1", "the stale answer is not stored");
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
      const started = await provider.startDirected(req, photo, voice, "vid_studio_1");
      assert.match(started.providerJobId, /^agent_\d+_sess_1$/, "the session, with when it started");
      assert.deepEqual(calls[0].body, { prompt: "The brief.", mode: "generate", orientation: "portrait", avatar_id: "look_dana", voice_id: "hg_voice" }, "the photo avatar's HeyGen look, and HeyGen's own voice id");
      await provider.startDirected({ ...req, directed: { ...req.directed, orientation: "landscape" } }, null, null, "vid_studio_2");
      assert.deepEqual(calls[1].body, { prompt: "The brief.", mode: "generate", orientation: "landscape" }, "HeyGen chooses the presenter and voice when none is named");
      assert.deepEqual(await provider.getStatus(started.providerJobId), { status: "processing", agentWaiting: false });
      session = { ...session, status: "generating", video_id: "hg_vid_1" };
      assert.deepEqual(await provider.getStatus(started.providerJobId), { status: "completed", videoUrl: "https://cdn/v.mp4", thumbnailUrl: "https://cdn/v.jpg", durationSec: 44, providerJobId: "hg_vid_1", agentWaiting: false });
      session = { session_id: "sess_1", status: "failed", video_id: null, failure_message: "The brief broke a content rule" };
      assert.deepEqual(await provider.getStatus(started.providerJobId), { status: "failed", error: "The brief broke a content rule" });
      // A session that finished without a video, one HeyGen no longer has, or one that never started a render, has failed.
      session = { session_id: "sess_1", status: "completed", video_id: null };
      assert.match((await provider.getStatus(started.providerJobId)).error ?? "", /finished without a video/);
      assert.match((await provider.getStatus(`agent_${Date.now()}_sess_gone`)).error ?? "", /no longer has this Video Agent session/);
      session = { session_id: "sess_1", status: "thinking", video_id: null };
      assert.match((await provider.getStatus(`agent_${Date.now() - 4 * 60 * 60 * 1000}_sess_1`)).error ?? "", /did not start a render in three hours/);
      refuse = true;
      await assert.rejects(provider.startDirected(req, null, null, "vid_studio_3"), (e: unknown) => e instanceof ValidationError && /HeyGen's Video Agent could not take that brief: prompt is too vague/.test((e as Error).message));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("is composed in one of HeyGen's curated styles, whose shape it takes when the shape is left to it", async () => {
    const styles = await listAgentStyles();
    assert.deepEqual(styles.map((x) => x.id), ["demo_style_noir", "demo_style_crt", "demo_style_pop", "demo_style_paper", "demo_style_press"]);
    assert.ok(styles.every((x) => x.thumbnailUrl?.startsWith("data:image/svg+xml") && x.tags.length));
    const paper = await directAgentVideo(videoAgentSchema.parse({ ...ASK, styleId: "demo_style_paper" }), "u1");
    assert.deepEqual([paper.directed?.styleId, paper.directed?.styleName, paper.directed?.orientation, paper.directed?.autoOrientation, paper.aspect], ["demo_style_paper", "Paper cut-out", "portrait", true, "9:16"], "a portrait style makes a portrait video");
    assert.equal((await directAgentVideo(videoAgentSchema.parse({ ...ASK, styleId: "demo_style_paper", orientation: "landscape" }), "u1")).directed?.orientation, "landscape", "a shape asked for wins");
    assert.equal((await directAgentVideo(videoAgentSchema.parse({ ...ASK, prompt: "An Instagram Reels tour of the clinic", styleId: "demo_style_noir" }), "u1")).directed?.orientation, "portrait", "and so does one the request asks for");
    assert.equal((await directAgentVideo(videoAgentSchema.parse({ ...ASK, prompt: "A widescreen tour of the clinic", styleId: "demo_style_paper" }), "u1")).directed?.orientation, "landscape", "a wide shape too");
    assert.equal((await directAgentVideo(videoAgentSchema.parse({ ...ASK, prompt: "A YouTube video about the clinic", styleId: "demo_style_paper" }), "u1")).directed?.orientation, "landscape", "or a wide platform");
    assert.equal((await directAgentVideo(videoAgentSchema.parse(ASK), "u1")).directed?.styleId, undefined, "none unless chosen");
    // A style HeyGen no longer offers, or one that cannot be a style, is refused before anything starts.
    await assert.rejects(directAgentVideo(videoAgentSchema.parse({ ...ASK, styleId: "style_retired" }), "u1"), /no longer offers that style/);
    assert.throws(() => videoAgentSchema.parse({ ...ASK, styleId: "../styles" }), /Unknown style/);
    // This studio's own agent has no styles: one sent with it is refused rather than ignored.
    await assert.rejects(planVideo(videoAgentSchema.parse({ ...ASK, mode: "plan", styleId: "demo_style_noir" }), "u1"), /style is for HeyGen's Video Agent/);
    await assert.rejects(generateAgentVideo(videoAgentSchema.parse({ ...ASK, mode: "generate", styleId: "demo_style_noir" }), "u1"), /style is for HeyGen's Video Agent/);
  });

  it("lists HeyGen's styles, every page, keeping only what the studio can show, and sends the one chosen", async () => {
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url === "https://api.heygen.com/v3/video-agents/styles?limit=100")
        return Response.json({
          data: [
            { style_id: "style_noir", name: "Noir Detective", thumbnail_url: "https://files.heygen.ai/noir.jpg", preview_video_url: "https://files.heygen.ai/noir.mp4", tags: ["cinematic", "spooky"], aspect_ratio: "16:9" },
            { style_id: "style_plain", name: " Plain ", thumbnail_url: "http://files.heygen.ai/plain.jpg", preview_video_url: null, tags: null, aspect_ratio: "4:3" },
            { style_id: "", name: "No id" },
            { style_id: "style_nameless" },
          ],
          has_more: true,
          next_token: "page 2",
        });
      if (url === "https://api.heygen.com/v3/video-agents/styles?limit=100&token=page%202") return Response.json({ data: [{ style_id: "style_noir", name: "Noir again" }, { style_id: "style_reel", name: "Reel", tags: ["pop-culture"], aspect_ratio: "9:16" }], has_more: false });
      if (url === "https://api.heygen.com/v3/video-agents" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ data: { session_id: "sess_s", status: "thinking", video_id: null } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    try {
      const provider = new HeyGenAvatarProvider("hg_key");
      assert.deepEqual(await provider.listAgentStyles(), [
        { id: "style_noir", name: "Noir Detective", thumbnailUrl: "https://files.heygen.ai/noir.jpg", previewUrl: "https://files.heygen.ai/noir.mp4", tags: ["cinematic"], aspect: "16:9" },
        { id: "style_plain", name: "Plain", tags: [] },
        { id: "style_reel", name: "Reel", tags: ["pop-culture"], aspect: "9:16" },
      ]);
      assert.equal(asked.length, 2, "both pages");
      const req = { title: "x", script: "", avatarId: "", voiceId: "", aspect: "16:9" as const, resolution: "1080p" as const, background: { type: "color" as const, value: "#000000" }, captions: false, speed: 1, directed: { brief: "The brief.", prompt: "The brief.", orientation: "landscape" as const, lengthSec: 60, language: "English", styleId: "style_noir", styleName: "Noir Detective" } };
      await provider.startDirected(req, null, null, "vid_styled");
      assert.deepEqual(bodies[0], { prompt: "The brief.", mode: "generate", orientation: "landscape", style_id: "style_noir" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("edits a finished video's scenes into a new cut, keeping the video it edits, in the session it was made in", async () => {
    const started = await directAgentVideo(videoAgentSchema.parse({ ...ASK, styleId: "demo_style_noir" }), "u1");
    assert.match(started.agentSessionId ?? "", /^mocksess_\d+$/, "the agent's session is kept from the start");
    await assert.rejects(directedVideoScenes(started.id, "u1"), /once the video is ready/);
    // Finished: the session's render, a while ago.
    const done: Video = { ...started, status: "completed", providerJobId: `mock_${Date.now() - 60_000}_30`, videoUrl: "/demo/render.webm" };
    await getStore().put("video", done);
    const { editVersion, scenes } = await directedVideoScenes(done.id, "u1");
    assert.equal(scenes.length, 3);
    assert.match(scenes[0].script, /Welcome/);
    await assert.rejects(directedVideoScenes(done.id, "u2"), NotFoundError, "another account's reads as not found");
    // The request: one change per scene, described in a few words, at most 50.
    const ask = (edits: unknown, version = editVersion) => sceneEditSchema.parse({ editVersion: version, edits });
    assert.throws(() => ask([]), /at least one scene/);
    assert.throws(() => ask([{ sceneId: scenes[0].id, text: "ok" }]), /in a few words/);
    assert.throws(() => ask([{ sceneId: scenes[0].id, text: "Darker room" }, { sceneId: scenes[0].id, text: "Brighter room" }]), /each scene's change once/);
    assert.throws(() => ask(Array.from({ length: 51 }, (_, i) => ({ sceneId: `s${i}`, text: "Change it" }))), /at most 50 scenes/);
    assert.throws(() => sceneEditSchema.parse({ editVersion, edits: [{ sceneId: scenes[0].id, text: "Darker", extra: 1 }] }), /extra/);
    // Read against an older version, or naming a scene that is not the video's: refused before anything is sent.
    await assert.rejects(editDirectedVideo(done.id, ask([{ sceneId: scenes[1].id, text: "Make the room darker" }], "mockev_1"), "u1"), ConflictError);
    await assert.rejects(editDirectedVideo(done.id, ask([{ sceneId: "mockscene_0_9", text: "Make the room darker" }]), "u1"), /not one of this video's/);
    assert.equal((await getStore().list<Video>("video", "u1")).length, 1, "neither left a cut behind");
    const cut = await editDirectedVideo(done.id, ask([{ sceneId: scenes[2].id, text: "End on: available now." }, { sceneId: scenes[1].id, text: "Make the room darker; keep the narration." }]), "u1");
    assert.equal(cut.status, "processing");
    assert.notEqual(cut.id, done.id);
    assert.match(cut.providerJobId ?? "", /^mock_\d+_30$/, "the new cut is a render to follow");
    assert.deepEqual([cut.title, cut.agentSessionId, cut.aspect, cut.directed?.styleName], [`${done.title} (edited)`, done.agentSessionId, done.aspect, "Noir detective"]);
    assert.deepEqual(cut.directed?.editOf, { videoId: done.id, title: done.title, edits: [{ scene: 2, text: "Make the room darker; keep the narration." }, { scene: 3, text: "End on: available now." }] }, "numbered, in order");
    assert.equal((await getVideo(done.id, "u1", false)).status, "completed", "the video edited is kept as it was");
    // An edit of an edit stays named once; a failed cut is not retried from the brief.
    const again = await editDirectedVideo(cut.id, ask([{ sceneId: `mockscene_${cut.providerJobId!.split("_")[1]}_1`, text: "A warmer welcome" }], `mockev_${cut.providerJobId!.split("_")[1]}`), "u1").catch((e) => e);
    assert.match(String(again), /once the video is ready/, "a cut still rendering cannot be edited yet");
    await getStore().put("video", { ...cut, status: "completed", providerJobId: `mock_${Date.now() - 60_000}_30` });
    const chained = await directedVideoScenes(cut.id, "u1");
    assert.equal((await editDirectedVideo(cut.id, ask([{ sceneId: chained.scenes[0].id, text: "A warmer welcome" }], chained.editVersion), "u1")).title, `${done.title} (edited)`);
    await getStore().put("video", { ...cut, status: "failed", error: "HeyGen gave up" });
    await assert.rejects(retryVideo(cut.id, "u1"), /edit the scenes of/);
    // Not directed, or directed before sessions were kept, or in the trash: nothing to edit.
    const { agentSessionId: _s, ...old } = done;
    void _s;
    await getStore().put("video", { ...old, id: "vid_old" });
    await assert.rejects(directedVideoScenes("vid_old", "u1"), /before its Video Agent session was kept/);
    await getStore().put("video", { ...done, id: "vid_binned", deletedAt: new Date().toISOString() });
    await assert.rejects(directedVideoScenes("vid_binned", "u1"), /from the trash/);
    const { directed: _d, ...plain } = done;
    void _d;
    await getStore().put("video", { ...plain, id: "vid_plain" });
    await assert.rejects(directedVideoScenes("vid_plain", "u1"), /Only a video HeyGen's Video Agent directed/);
  });

  it("answers HeyGen refusing the changes as such, with no failed cut left behind, and keeps a cut it started", async () => {
    const { config } = await import("../config");
    const saved = { key: config.heygenApiKey };
    const realFetch = globalThis.fetch;
    let editAnswer = () => Response.json({ error: { code: "stale_edit_version", message: "stale" } }, { status: 409 });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.heygen.com/v3/videos/hg_vid_1/scenes") return Response.json({ data: { edit_version: "ev_1", scenes: [{ id: "sc_a", script: [{ type: "text", text: "Hi." }] }] } });
      if (url === "https://api.heygen.com/v3/video-agents/sess_1" && init?.method === "POST") return editAnswer();
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { heygenApiKey: "hg_key" });
    try {
      const source: Video = { id: "vid_hg", ownerId: "u1", title: "Bakery welcome", script: "", avatarId: "", voiceId: "", aspect: "16:9", resolution: "1080p", background: { type: "color", value: "#000000" }, captions: false, speed: 1, status: "completed", provider: "heygen", providerJobId: "hg_vid_1", agentSessionId: "sess_1", directed: { brief: "b", prompt: "b", orientation: "landscape", lengthSec: 60, language: "English" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await getStore().put("video", source);
      const plan = sceneEditSchema.parse({ editVersion: "ev_1", edits: [{ sceneId: "sc_a", text: "Make it warmer" }] });
      await assert.rejects(editDirectedVideo("vid_hg", plan, "u1"), ConflictError, "HeyGen's stale version is a conflict to read again");
      editAnswer = () => Response.json({ error: { code: "invalid_parameter", message: "scene_id not in snapshot" } }, { status: 400 });
      await assert.rejects(editDirectedVideo("vid_hg", plan, "u1"), /could not make those changes: scene_id not in snapshot/);
      assert.deepEqual((await getStore().list<Video>("video", "u1")).map((v) => v.id), ["vid_hg"], "no failed cut is left in the library");
      // Trouble at HeyGen's end is kept as a failed cut, like any start; the same edit sent again is that cut, not another.
      editAnswer = () => new Response("upstream", { status: 503 });
      const failed = await editDirectedVideo("vid_hg", plan, "u1");
      assert.equal(failed.status, "failed");
      assert.equal((await editDirectedVideo("vid_hg", plan, "u1")).id, failed.id);
      editAnswer = () => Response.json({ data: { session_id: "sess_1", video_id: "hg_cut_2" } });
      const other = sceneEditSchema.parse({ editVersion: "ev_1", edits: [{ sceneId: "sc_a", text: "Make it cooler" }] });
      const cut = await editDirectedVideo("vid_hg", other, "u1");
      assert.deepEqual([cut.status, cut.providerJobId, cut.agentSessionId], ["processing", "hg_cut_2", "sess_1"]);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { heygenApiKey: saved.key });
    }
  });

  it("stops at the storyboard for review, answered on the video's page until the go-ahead renders it", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    await assert.rejects(planVideo(videoAgentSchema.parse({ ...ASK, mode: "plan", review: true }), "u1"), /review its plan in the editor/);
    const video = await directAgentVideo(videoAgentSchema.parse({ ...ASK, review: true }), "u1");
    assert.equal(video.directed?.review, true);
    // Working on the brief first: nothing to answer yet.
    let talk = await agentConversation(video.id, "u1");
    assert.deepEqual([talk.waiting, talk.messages.map((m) => m.from)], [false, ["you"]]);
    await assert.rejects(answerAgent(video.id, "Make it shorter", "u1"), ConflictError, "not while the agent is working");
    t.mock.timers.tick(3000);
    talk = await agentConversation(video.id, "u1");
    assert.equal(talk.waiting, true);
    assert.match(talk.messages[1].text, /drafted a storyboard/);
    assert.match(talk.messages[1].attachments?.[0].thumbnailUrl ?? "", /^data:image\/svg\+xml/);
    assert.equal((await getVideo(video.id, "u1")).agentWaiting, true, "the video says it is waiting for an answer");
    // Feedback: the agent works on it, then answers again.
    assert.ok(!(await answerAgent(video.id, "Add a scene about parking", "u1")).agentWaiting);
    assert.equal((await agentConversation(video.id, "u1")).waiting, false);
    t.mock.timers.tick(3000);
    talk = await agentConversation(video.id, "u1");
    assert.deepEqual(talk.messages.map((m) => m.from), ["you", "agent", "you", "agent"]);
    assert.match(talk.messages[3].text, /updated the storyboard: Add a scene about parking/);
    // The go-ahead: the video follows its render from then on, and there is nothing left to answer.
    await answerAgent(video.id, "Looks good, go ahead and make the video.", "u1");
    const making = await getVideo(video.id, "u1");
    assert.match(making.providerJobId ?? "", /^mock_\d+_30$/);
    assert.equal(making.agentWaiting, false);
    await assert.rejects(answerAgent(video.id, "One more change", "u1"), /already being made/);
    assert.equal((await agentConversation(video.id, "u1")).waiting, false, "the conversation stays as the record");
    // A stale look that still said "waiting" is cleared once the video follows its render, however the news arrives.
    await getStore().put("video", { ...making, providerJobId: `mock_${Date.now() - 120_000}_30`, agentWaiting: true });
    const done = await getVideo(video.id, "u1");
    assert.deepEqual([done.status, done.agentWaiting], ["completed", false]);
    // Another account's reads as not found; a video not under review has no conversation; an answer is a few words.
    await assert.rejects(agentConversation(video.id, "u2"), NotFoundError);
    const plain = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
    await assert.rejects(agentConversation(plain.id, "u1"), /drafts for review/);
    const { agentAnswerSchema } = await import("../services");
    assert.throws(() => agentAnswerSchema.parse({ text: " " }), /Write an answer/);
    assert.throws(() => agentAnswerSchema.parse({ text: "x".repeat(10_001) }), /at most 10,000/);
  });

  it("asks HeyGen's agent to stop for review, reads its conversation and storyboard, and sends answers", async () => {
    const realFetch = globalThis.fetch;
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    let session: Record<string, unknown> = { session_id: "sess_r", status: "reviewing", progress: 45, video_id: null, messages: [] };
    let answer = () => Response.json({ data: { session_id: "sess_r", run_id: "run_1" } });
    const resourceCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.heygen.com/v3/video-agents" && init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ data: { session_id: "sess_r", status: "thinking", video_id: null } });
      }
      if (url === "https://api.heygen.com/v3/video-agents/sess_r" && init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return answer();
      }
      if (url === "https://api.heygen.com/v3/video-agents/sess_r") return Response.json({ data: session });
      if (url.startsWith("https://api.heygen.com/v3/video-agents/sess_r/resources/")) {
        const id = url.split("/").at(-1)!;
        resourceCalls.push(id);
        if (id === "res_board") return Response.json({ data: { resource_id: id, resource_type: "image", url: "https://files.heygen.ai/board.png", thumbnail_url: "https://files.heygen.ai/board_t.png" } });
        if (id === "res_http") return Response.json({ data: { resource_id: id, resource_type: "image", url: "http://files.heygen.ai/x.png" } });
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    try {
      const provider = new HeyGenAvatarProvider("hg_key");
      const req = { title: "x", script: "", avatarId: "", voiceId: "", aspect: "16:9" as const, resolution: "1080p" as const, background: { type: "color" as const, value: "#000000" }, captions: false, speed: 1, directed: { brief: "b", prompt: "b", orientation: "landscape" as const, lengthSec: 60, language: "English", review: true as const } };
      const started = await provider.startDirected(req, null, null, "vid_r");
      assert.equal(posts[0].body.mode, "chat", "under review, HeyGen's agent is asked to stop at its storyboard");
      assert.deepEqual(await provider.getStatus(started.providerJobId), { status: "processing", agentWaiting: true });
      const now = Math.floor(Date.now() / 1000);
      session = {
        ...session,
        messages: [
          { role: "model", content: "I've drafted a storyboard with 4 scenes. Shall I proceed?", type: "text", created_at: now, resource_ids: ["res_board", "res_http", "res_gone"] },
          { role: "user", content: "A welcome for new staff", type: "text", created_at: now - 60, resource_ids: null },
          { role: "model", content: "", type: "text", created_at: now - 30, resource_ids: null },
        ],
      };
      const talk = await provider.agentConversation("sess_r");
      assert.deepEqual(talk, {
        waiting: true,
        progress: 45,
        messages: [
          { from: "you", text: "A welcome for new staff", at: new Date((now - 60) * 1000).toISOString() },
          { from: "agent", text: "I've drafted a storyboard with 4 scenes. Shall I proceed?", at: new Date(now * 1000).toISOString(), attachments: [{ kind: "image", url: "https://files.heygen.ai/board.png", thumbnailUrl: "https://files.heygen.ai/board_t.png" }] },
        ],
      }, "oldest first, empty turns left out, only https links, a resource HeyGen no longer has dropped");
      await provider.agentConversation("sess_r");
      assert.deepEqual(resourceCalls.filter((id) => id === "res_board"), ["res_board"], "a resource is looked up once");
      await provider.sendAgentMessage("sess_r", "Add a parking scene");
      assert.deepEqual(posts[1].body, { message: "Add a parking scene" });
      answer = () => Response.json({ error: { code: "conflict" } }, { status: 409 });
      await assert.rejects(provider.sendAgentMessage("sess_r", "Again"), ConflictError);
      // Working on an answer given hours after the start: the three hours run from the latest turn.
      session = { ...session, status: "thinking", messages: [{ role: "user", content: "Go", type: "text", created_at: now }] };
      assert.deepEqual(await provider.getStatus(`agent_${Date.now() - 5 * 60 * 60 * 1000}_sess_r`), { status: "processing", agentWaiting: false });
      session = { ...session, messages: [{ role: "user", content: "Go", type: "text", created_at: now - 4 * 60 * 60 }] };
      assert.match((await provider.getStatus(`agent_${Date.now() - 5 * 60 * 60 * 1000}_sess_r`)).error ?? "", /three hours/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("reads a render's scenes from HeyGen and sends the changes as an edit plan against that render", async () => {
    const realFetch = globalThis.fetch;
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    let editAnswer: Response = Response.json({ data: { session_id: "sess_1", video_id: "hg_cut_2" } });
    let scenesAnswer: () => Response = () =>
      Response.json({
        data: {
          video_id: "hg_vid_1",
          edit_version: "ev_1",
          scenes: [
            { id: "sc_a", script: [{ type: "text", text: "Hello there. " }, { type: "silence", duration: 1 }, { type: "text", text: "Welcome in." }] },
            { id: "sc_b", script: [{ type: "audio", audio_url: "https://x/a.mp3" }] },
            { script: [{ type: "text", text: "No id" }] },
          ],
        },
      });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.heygen.com/v3/videos/hg_vid_1/scenes") return scenesAnswer();
      if (url === "https://api.heygen.com/v3/video-agents/sess_1" && init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return editAnswer;
      }
      if (url === "https://api.heygen.com/v3/video-agents" && init?.method === "POST") return Response.json({ data: { session_id: "sess_1", status: "thinking", video_id: null } });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    try {
      const provider = new HeyGenAvatarProvider("hg_key");
      const req = { title: "x", script: "", avatarId: "", voiceId: "", aspect: "16:9" as const, resolution: "1080p" as const, background: { type: "color" as const, value: "#000000" }, captions: false, speed: 1, directed: { brief: "b", prompt: "b", orientation: "landscape" as const, lengthSec: 60, language: "English" } };
      assert.equal((await provider.startDirected(req, null, null, "vid_x")).agentSessionId, "sess_1", "the session comes back with the start");
      assert.deepEqual(await provider.directedScenes("hg_vid_1"), { editVersion: "ev_1", scenes: [{ id: "sc_a", script: "Hello there. Welcome in." }, { id: "sc_b", script: "" }] }, "spoken words only; a scene without an id is left out");
      assert.deepEqual(await provider.editDirectedScenes({ sessionId: "sess_1", renderJobId: "hg_vid_1", editVersion: "ev_1", edits: [{ sceneId: "sc_b", text: "Darker" }] }), { providerJobId: "hg_cut_2" });
      assert.deepEqual(posts[0].body, { edit_plan: [{ scene_id: "sc_b", text: "Darker", scene_snapshot_video_id: "hg_vid_1", edit_version: "ev_1" }] });
      const plan = { sessionId: "sess_1", renderJobId: "hg_vid_1", editVersion: "ev_1", edits: [{ sceneId: "sc_b", text: "Darker" }] };
      editAnswer = Response.json({ error: { code: "stale_edit_version", message: "stale" } }, { status: 409 });
      await assert.rejects(provider.editDirectedScenes(plan), ConflictError);
      editAnswer = Response.json({ error: { code: "invalid_parameter", message: "scene_id not in snapshot" } }, { status: 400 });
      await assert.rejects(provider.editDirectedScenes(plan), /could not make those changes: scene_id not in snapshot/);
      editAnswer = Response.json({ data: { session_id: "sess_1", video_id: null } });
      await assert.rejects(provider.editDirectedScenes(plan), /named no new cut/);
      scenesAnswer = () => Response.json({ error: { code: "resource_not_ready" } }, { status: 409 });
      await assert.rejects(provider.directedScenes("hg_vid_1"), /still preparing this video's scenes/);
      scenesAnswer = () => Response.json({ error: { code: "video_not_found" } }, { status: 404 });
      await assert.rejects(provider.directedScenes("hg_vid_1"), /no scenes to edit/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("finds a directed video by its own id when HeyGen's webhook names a render it does not follow yet", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey, secret: config.webhookSecret };
    const realFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      // The render a session names: hg_v15 finished before its session's webhook came; the others are still rendering.
      if (String(_input).endsWith("/v3/videos/hg_v15")) return Response.json({ data: { status: "completed", video_url: "https://cdn/v15.mp4", duration: 30 } });
      if (/\/v3\/videos\/hg_v/.test(String(_input))) return Response.json({ data: { status: "processing" } });
      return Response.json({ data: { session_id: "sess_9", status: "thinking", video_id: null } });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key", webhookSecret: "s3cret" });
    try {
      const video = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
      assert.match(video.providerJobId ?? "", /^agent_\d+_sess_9$/);
      assert.equal(bodies[0].callback_id, video.id, "HeyGen is told the studio's video id");
      assert.match(String(bodies[0].callback_url), /\/api\/webhooks\/heygen\?secret=s3cret$/);
      // The session's webhook names its render: the video follows it from now on, still processing.
      const moved = await applyAvatarWebhook("heygen", { event_type: "video_agent.success", event_data: { session_id: "sess_9", video_id: "hg_v9", callback_id: video.id } });
      assert.deepEqual([moved?.status, moved?.providerJobId], ["processing", "hg_v9"]);
      // The render's own webhook then matches it by its job, and finishes it.
      const done = await applyAvatarWebhook("heygen", { event_type: "avatar_video.success", event_data: { video_id: "hg_v9", url: "https://cdn/v9.mp4" } });
      assert.deepEqual([done?.id, done?.status, done?.videoUrl], [video.id, "completed", "https://cdn/v9.mp4"]);
      // A render's webhook that comes first finishes it straight away.
      const other = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
      const finished = await applyAvatarWebhook("heygen", { event_type: "avatar_video.success", event_data: { video_id: "hg_v10", url: "https://cdn/v10.mp4", callback_id: other.id } });
      assert.deepEqual([finished?.status, finished?.providerJobId], ["completed", "hg_v10"]);
      // A failed session fails it.
      const third = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
      const failed = await applyAvatarWebhook("heygen", { event_type: "video_agent.fail", event_data: { session_id: "sess_9", callback_id: third.id, failure_message: "Brief refused" } });
      assert.deepEqual([failed?.status, failed?.error], ["failed", "Brief refused"]);
      // The id of a video that is not a directed one waiting on its session matches nothing.
      await getStore().put("video", { ...other, id: "vid_plain", directed: undefined, providerJobId: "agent_1_sess_x", status: "processing" } as Video);
      assert.equal(await applyAvatarWebhook("heygen", { event_type: "avatar_video.success", event_data: { video_id: "hg_v11", url: "https://cdn/v.mp4", callback_id: "vid_plain" } }), null);
      assert.equal(await applyAvatarWebhook("heygen", { event_type: "avatar_video.success", event_data: { video_id: "hg_v12", url: "https://cdn/v.mp4", callback_id: done!.id } }), null, "one that follows its render already");
      // Nor does another renderer's directed video.
      const demo = { ...third, id: "vid_demo_directed", provider: "mock", providerJobId: "mockagent_1", status: "processing" as const, error: undefined };
      await getStore().put("video", demo);
      assert.equal(await applyAvatarWebhook("heygen", { event_type: "video_agent.success", event_data: { video_id: "hg_v13", callback_id: demo.id } }), null);
      // A session's success with a link only moves the job: the render's webhook, or a check, finishes it.
      const fourth = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
      const linked = await applyAvatarWebhook("heygen", { event_type: "video_agent.success", event_data: { video_id: "hg_v14", url: "https://app.heygen.com/session/x", callback_id: fourth.id } });
      assert.deepEqual([linked?.status, linked?.providerJobId, linked?.videoUrl], ["processing", "hg_v14", undefined]);
      // A render whose own webhook came first (without the id, matching nothing) is asked about when the session names it.
      const fifth = await directAgentVideo(videoAgentSchema.parse(ASK), "u1");
      assert.equal(await applyAvatarWebhook("heygen", { event_type: "avatar_video.success", event_data: { video_id: "hg_v15", url: "https://cdn/v15.mp4" } }), null);
      const caught = await applyAvatarWebhook("heygen", { event_type: "video_agent.success", event_data: { video_id: "hg_v15", callback_id: fifth.id } });
      assert.deepEqual([caught?.status, caught?.videoUrl, caught?.providerJobId], ["completed", "https://cdn/v15.mp4", "hg_v15"]);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key, webhookSecret: saved.secret });
    }
  });
});
