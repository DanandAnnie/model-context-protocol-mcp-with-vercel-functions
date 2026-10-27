// Highlight clips (HeyGen AI Clipping): a finished video cut into short clips. What is accepted, what HeyGen is asked,
// how a job is followed and its signed links renewed, and that the jobs go with the video and the account.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_HIGHLIGHT_JOBS, deleteHighlights, deleteOwnerData, deleteVideo, exportOwnerData, highlightRequestSchema, listHighlights, startHighlights } from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { getStore } from "../store";
import type { HighlightJob, Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const now = () => new Date().toISOString();
async function finished(owner: string, extra: Partial<Video> = {}): Promise<Video> {
  const video: Video = {
    id: `vid_${Math.random().toString(36).slice(2, 10)}`,
    ownerId: owner,
    title: "Open house tour",
    script: "Welcome in.",
    avatarId: "stock_1",
    voiceId: "stock_voice_1",
    aspect: "16:9",
    background: { type: "color", value: "#000000" },
    captions: false,
    speed: 1,
    status: "completed",
    provider: "mock",
    videoUrl: "https://cdn.example.com/tour.mp4",
    durationSec: 240,
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  } as Video;
  return getStore().put("video", video);
}

const clipMs = MockAvatarProvider as unknown as { CLIP_MS: number };

describe("highlight clips", () => {
  it("checks the lengths, framing, and what to look for", () => {
    assert.deepEqual(highlightRequestSchema.parse({ lengths: ["60", "30", "30"] }), { lengths: ["30", "60"], frame: "9:16", captions: true });
    assert.throws(() => highlightRequestSchema.parse({ lengths: [] }), /at least one clip length/);
    assert.throws(() => highlightRequestSchema.parse({ lengths: ["45"] }), /30, 60, or 180/);
    assert.throws(() => highlightRequestSchema.parse({ lengths: ["30"], frame: "4:5" }), /9:16, 16:9, or 1:1/);
    assert.equal(highlightRequestSchema.parse({ lengths: ["30"], prompt: "  pricing \n and  growth " }).prompt, "pricing and growth");
    assert.equal(highlightRequestSchema.parse({ lengths: ["30"], prompt: "   " }).prompt, undefined, "blank is none");
    assert.throws(() => highlightRequestSchema.parse({ lengths: ["30"], prompt: "x".repeat(501) }), /at most 500/);
  });

  it("cuts a finished video in demo mode, followed until the clips are ready, for the account that asked only", async () => {
    assert.equal(providerStatus().highlightClips, true);
    const video = await finished("u1");
    const saved = clipMs.CLIP_MS;
    try {
      clipMs.CLIP_MS = 60_000;
      const job = await startHighlights(video.id, highlightRequestSchema.parse({ lengths: ["30", "60"], frame: "1:1", captions: false, prompt: "the kitchen" }), "u1");
      assert.match(job.id, /^hl_/, "the studio's own id, not the renderer's");
      assert.deepEqual([job.status, job.lengths, job.frame, job.captions, job.prompt, job.clips], ["processing", ["30", "60"], "1:1", false, "the kitchen", []]);
      const [running] = await listHighlights(video.id, "u1");
      assert.equal(running.status, "processing");
      assert.equal(typeof running.progress, "number");
      clipMs.CLIP_MS = 0;
      const [done] = await listHighlights(video.id, "u1");
      assert.equal(done.status, "completed");
      assert.equal(done.progress, undefined);
      assert.deepEqual(done.clips.map((c) => [c.status, c.durationSec]), [["completed", 30], ["completed", 60]]);
      assert.ok(done.clips.every((c) => c.videoUrl && c.title && typeof c.viralityScore === "number"));
      await assert.rejects(listHighlights(video.id, "u2"), NotFoundError, "another account cannot see them");
      await assert.rejects(deleteHighlights(video.id, done.id, "u2"), NotFoundError);
      await deleteHighlights(video.id, done.id, "u1");
      assert.deepEqual(await listHighlights(video.id, "u1"), []);
    } finally {
      clipMs.CLIP_MS = saved;
    }
  });

  it("refuses a video that is not finished, too short for a length, trashed, or already holding the most sets", async () => {
    const input = highlightRequestSchema.parse({ lengths: ["60"] });
    const rendering = await finished("u1", { status: "processing", videoUrl: undefined });
    await assert.rejects(startHighlights(rendering.id, input, "u1"), (e: unknown) => e instanceof ValidationError && /finished video/.test((e as Error).message));
    const short = await finished("u1", { durationSec: 45 });
    await assert.rejects(startHighlights(short.id, highlightRequestSchema.parse({ lengths: ["30", "60", "180"] }), "u1"), /runs 45 seconds, so it has no 60-second or 180-second highlight/);
    assert.equal((await startHighlights(short.id, highlightRequestSchema.parse({ lengths: ["30"] }), "u1")).status, "processing");
    const trashed = await finished("u1", { deletedAt: now() });
    await assert.rejects(startHighlights(trashed.id, input, "u1"), /Restore the video/);
    await assert.rejects(startHighlights(short.id, input, "u2"), NotFoundError);
    const full = await finished("u1");
    for (let i = 0; i < MAX_HIGHLIGHT_JOBS; i++) await startHighlights(full.id, input, "u1");
    await assert.rejects(startHighlights(full.id, input, "u1"), ConflictError);
    // A job id of another video is refused.
    const other = (await listHighlights(short.id, "u1"))[0];
    await assert.rejects(deleteHighlights(full.id, other.id, "u1"), /another video/);
    await assert.rejects(deleteHighlights(full.id, "../x", "u1"), /Unknown clipping job/);
  });

  it("goes with the video when it is deleted for good, and with the account", async () => {
    const video = await finished("u1");
    await startHighlights(video.id, highlightRequestSchema.parse({ lengths: ["30"] }), "u1");
    assert.equal((await exportOwnerData("u1")).highlight.length, 1);
    await deleteVideo(video.id, "u1");
    assert.equal((await getStore().list("highlight", "u1")).length, 1, "the trash keeps them, as it keeps the video");
    await deleteVideo(video.id, "u1", true);
    assert.equal((await getStore().list("highlight", "u1")).length, 0);
    const again = await finished("u1");
    await startHighlights(again.id, highlightRequestSchema.parse({ lengths: ["30"] }), "u1");
    const counts = await deleteOwnerData("u1");
    assert.equal(counts.highlight, 1);
  });

  it("asks HeyGen for the clips with a fresh link to the video, follows the job, and renews old links", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let clipping: Record<string, unknown> = { data: { status: "running", progress: 40, clips: [] } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "https://api.heygen.com/v3/videos/hg_video") return Response.json({ data: { status: "completed", video_url: "https://files.heygen.ai/fresh.mp4?sig=1" } });
      if (url === "https://api.heygen.com/v3/ai-clipping" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { output_settings: { prompt?: string } };
        if (body.output_settings.prompt === "refuse") return Response.json({ error: { code: "invalid_parameter", message: "The video is too short to clip." } }, { status: 400 });
        return Response.json({ data: { ai_clipping_id: "clip_job_1" } });
      }
      if (url === "https://api.heygen.com/v3/ai-clipping/clip_job_1") return Response.json(clipping);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const video = await finished("u1", { provider: "heygen", providerJobId: "hg_video", videoUrl: "https://files.heygen.ai/old.mp4?sig=expired" });
      const job = await startHighlights(video.id, highlightRequestSchema.parse({ lengths: ["30", "180"], frame: "16:9", captions: false, prompt: "pricing" }), "u1");
      const post = calls.find((c) => c.method === "POST")!;
      assert.deepEqual(post.body, {
        video: { type: "url", url: "https://files.heygen.ai/fresh.mp4?sig=1" },
        title: "Open house tour",
        output_settings: { duration_types: ["30", "180"], aspect_ratio: "landscape", captions: false, prompt: "pricing" },
      });
      assert.equal(((await getStore().get("highlight", job.id)) as HighlightJob).providerJobId, "clip_job_1");
      await assert.rejects(startHighlights(video.id, highlightRequestSchema.parse({ lengths: ["30"], prompt: "refuse" }), "u1"), (e: unknown) => e instanceof ValidationError && /could not clip that video: The video is too short to clip\./.test((e as Error).message));
      assert.equal((await listHighlights(video.id, "u1"))[0].progress, 40);
      clipping = {
        data: {
          status: "completed",
          progress: 100,
          clips: [{ id: "c1", status: "completed", title: "Why we changed our pricing", duration_seconds: 26.4, virality_score: 65, thumbnail_url: "https://r.heygen.ai/c1.jpeg", video_url: "https://r.heygen.ai/c1.mp4?sig=a" }],
        },
      };
      const [done] = await listHighlights(video.id, "u1");
      assert.deepEqual(done.clips, [{ id: "c1", status: "completed", title: "Why we changed our pricing", durationSec: 26.4, viralityScore: 65, thumbnailUrl: "https://r.heygen.ai/c1.jpeg", videoUrl: "https://r.heygen.ai/c1.mp4?sig=a" }]);
      // Read again soon after, HeyGen is not asked; once the links are old, they are renewed.
      const asked = calls.length;
      await listHighlights(video.id, "u1");
      assert.equal(calls.length, asked);
      await getStore().put("highlight", { ...done, checkedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() });
      (clipping.data as { clips: Array<{ video_url: string }> }).clips[0].video_url = "https://r.heygen.ai/c1.mp4?sig=b";
      assert.equal((await listHighlights(video.id, "u1"))[0].clips[0].videoUrl, "https://r.heygen.ai/c1.mp4?sig=b");
      // A failed job keeps its reason; a check HeyGen cannot answer keeps what was known.
      clipping = { data: { status: "failed", failure_message: "The source video could not be read.", clips: [] } };
      await getStore().put("highlight", { ...(await getStore().get<HighlightJob>("highlight", job.id))!, status: "processing" });
      const [failed] = await listHighlights(video.id, "u1");
      assert.deepEqual([failed.status, failed.error], ["failed", "The source video could not be read."]);
      clipping = { error: { message: "down" } };
      await getStore().put("highlight", { ...failed, status: "processing" });
      assert.equal((await listHighlights(video.id, "u1"))[0].status, "processing");
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("is not offered by a renderer without it", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().highlightClips, false);
      const video = await finished("u1");
      await assert.rejects(startHighlights(video.id, highlightRequestSchema.parse({ lengths: ["30"] }), "u1"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
