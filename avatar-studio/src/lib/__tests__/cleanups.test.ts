// Cleaned recordings (HeyGen filler word removal): filler words and long silences cut out of a recording, from a public
// link or a library video. What is accepted, what HeyGen is asked, how a job is followed, and that it goes with the account.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_CLEANUPS, cleanupRequestSchema, deleteCleanup, deleteOwnerData, exportOwnerData, forgetCleanupChecks, listCleanups, publicCleanup, startCleanup } from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { getStore } from "../store";
import type { CleanupJob, Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetCleanupChecks();
});

const now = () => new Date().toISOString();
async function finished(owner: string, extra: Partial<Video> = {}): Promise<Video> {
  const video = {
    id: `vid_${Math.random().toString(36).slice(2, 10)}`,
    ownerId: owner,
    title: "Q3 webinar",
    script: "Welcome in.",
    avatarId: "stock_1",
    voiceId: "stock_voice_1",
    aspect: "16:9",
    background: { type: "color", value: "#000000" },
    captions: false,
    speed: 1,
    status: "completed",
    provider: "mock",
    videoUrl: "https://93.184.216.34/webinar.mp4",
    durationSec: 512,
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  } as Video;
  return getStore().put("video", video);
}

const clipMs = MockAvatarProvider as unknown as { CLIP_MS: number };
const PUBLIC = "https://93.184.216.34/webinar.mp4";

describe("cleaned recordings", () => {
  it("takes one of a library video or a public https link", async () => {
    assert.throws(() => cleanupRequestSchema.parse({}), /Choose one of your videos or paste a link/);
    assert.throws(() => cleanupRequestSchema.parse({ videoId: "vid_1", sourceUrl: PUBLIC }), /Choose one/);
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: "http://93.184.216.34/a.mp4" }), "u1"), /public https link/);
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: "https://127.0.0.1/a.mp4" }), "u1"), (e: unknown) => e instanceof ValidationError && /public host/.test((e as Error).message));
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: "https://10.0.0.5/a.mp4" }), "u1"), ValidationError);
  });

  it("cleans a recording in demo mode, followed until ready, for the account that asked only", async () => {
    assert.equal(providerStatus().fillerRemoval, true);
    const saved = clipMs.CLIP_MS;
    try {
      clipMs.CLIP_MS = 60_000;
      const job = await startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC, title: " Webinar " }), "u1");
      assert.match(job.id, /^cu_/);
      assert.deepEqual([job.status, job.title, job.sourceUrl, job.videoId], ["processing", "Webinar", PUBLIC, undefined]);
      assert.deepEqual(Object.keys(publicCleanup(job)).filter((k) => ["ownerId", "provider", "providerJobId"].includes(k)), [], "the renderer and its job id stay on the server");
      assert.equal((await listCleanups("u1"))[0].status, "processing");
      clipMs.CLIP_MS = 0;
      assert.equal((await listCleanups("u1"))[0].status, "processing", "asked again at once, it is not checked twice");
      forgetCleanupChecks();
      const [done] = await listCleanups("u1");
      assert.deepEqual([done.status, done.cuts, done.originalSec, done.outputSec, done.reductionPct, done.progress], ["completed", 7, 64, 58.5, 8.6, undefined]);
      assert.match(done.videoUrl!, /\/demo\/render\.webm$/);
      assert.deepEqual(await listCleanups("u2"), [], "another account sees none");
      await assert.rejects(deleteCleanup(done.id, "u2"), NotFoundError);
      await deleteCleanup(done.id, "u1");
      assert.deepEqual(await listCleanups("u1"), []);
      await assert.rejects(deleteCleanup("../x", "u1"), /Unknown cleanup/);
    } finally {
      clipMs.CLIP_MS = saved;
    }
  });

  it("cleans a finished library video under its title, and refuses one that is not finished, trashed, or another account's", async () => {
    const video = await finished("u1");
    const job = await startCleanup(cleanupRequestSchema.parse({ videoId: video.id }), "u1");
    assert.deepEqual([job.title, job.videoId, job.sourceUrl], ["Q3 webinar (cleaned)", video.id, undefined]);
    const rendering = await finished("u1", { status: "processing", videoUrl: undefined });
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ videoId: rendering.id }), "u1"), /Only a finished video/);
    const trashed = await finished("u1", { deletedAt: now() });
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ videoId: trashed.id }), "u1"), /Restore the video/);
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ videoId: video.id }), "u2"), NotFoundError);
  });

  it("keeps at most the account's limit, and goes with the account", async () => {
    for (let i = 0; i < MAX_CLEANUPS; i++) {
      await getStore().put("cleanup", { id: `cu_old${i}`, ownerId: "u1", title: "Old", provider: "mock", providerJobId: "x", status: "failed", createdAt: now(), updatedAt: now() } satisfies CleanupJob);
    }
    await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC }), "u1"), ConflictError);
    assert.equal((await exportOwnerData("u1")).cleanup.length, MAX_CLEANUPS);
    assert.equal((await deleteOwnerData("u1")).cleanup, MAX_CLEANUPS);
  });

  it("asks HeyGen to clean the recording with a fresh link and an idempotency key, follows the job, and maps its answers", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
    let removal: Record<string, unknown> = { data: { status: "running", progress: 30 } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/videos/hg_video") return Response.json({ data: { status: "completed", video_url: "https://files.heygen.ai/fresh.mp4?sig=1" } });
      if (url === "https://api.heygen.com/v3/filler-word-removals" && init?.method === "POST") {
        if ((JSON.parse(String(init.body)) as { title: string }).title === "refuse") return Response.json({ error: { code: "invalid_parameter", message: "The video has no speech." } }, { status: 400 });
        return Response.json({ data: { filler_word_removal_id: "fwr_1" } });
      }
      if (url === "https://api.heygen.com/v3/filler-word-removals/fwr_1") return removal.gone ? Response.json({ error: { code: "not_found" } }, { status: 404 }) : Response.json(removal);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const video = await finished("u1", { provider: "heygen", providerJobId: "hg_video", videoUrl: "https://files.heygen.ai/old.mp4?sig=expired" });
      const job = await startCleanup(cleanupRequestSchema.parse({ videoId: video.id }), "u1");
      const post = calls.find((c) => c.method === "POST")!;
      assert.deepEqual(post.body, { video: { type: "url", url: "https://files.heygen.ai/fresh.mp4?sig=1" }, title: "Q3 webinar (cleaned)" });
      assert.equal(post.idem, job.id, "the studio's id makes a retried start return the same job");
      await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC, title: "refuse" }), "u1"), (e: unknown) => e instanceof ValidationError && /could not clean that recording: The video has no speech\./.test((e as Error).message));
      assert.equal((await listCleanups("u1"))[0].progress, 30);
      removal = { data: { status: "completed", progress: 100, video_url: "https://files2.heygen.ai/out.mp4?sig=a", thumbnail_url: "https://r.heygen.ai/t.webp", original_duration: 512.6, output_duration: 471.9, num_cuts: 23, reduction_pct: 7.9 } };
      forgetCleanupChecks();
      const [done] = await listCleanups("u1");
      assert.deepEqual(
        { status: done.status, videoUrl: done.videoUrl, thumbnailUrl: done.thumbnailUrl, originalSec: done.originalSec, outputSec: done.outputSec, cuts: done.cuts, reductionPct: done.reductionPct },
        { status: "completed", videoUrl: "https://files2.heygen.ai/out.mp4?sig=a", thumbnailUrl: "https://r.heygen.ai/t.webp", originalSec: 512.6, outputSec: 471.9, cuts: 23, reductionPct: 7.9 },
      );
      // A finished job without a cleaned video, a failed one, and one HeyGen no longer has each fail with a reason.
      const reset = async () => {
        await getStore().put("cleanup", { ...(await getStore().get<CleanupJob>("cleanup", job.id))!, status: "processing" });
        forgetCleanupChecks();
      };
      removal = { data: { status: "completed", video_url: "javascript:alert(1)" } };
      await reset();
      assert.deepEqual([(await listCleanups("u1"))[0].status, (await listCleanups("u1"))[0].error], ["failed", "HeyGen finished without a cleaned video"]);
      removal = { data: { status: "failed", failure_message: "No speech was found." } };
      await reset();
      const [failed] = await listCleanups("u1");
      assert.deepEqual([failed.status, failed.error, failed.videoUrl], ["failed", "No speech was found.", undefined], "a failure drops the old link");
      removal = { gone: true };
      await reset();
      assert.match((await listCleanups("u1"))[0].error!, /no longer available from HeyGen/);
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
      assert.equal(providerStatus().fillerRemoval, false);
      await assert.rejects(startCleanup(cleanupRequestSchema.parse({ sourceUrl: PUBLIC }), "u1"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
