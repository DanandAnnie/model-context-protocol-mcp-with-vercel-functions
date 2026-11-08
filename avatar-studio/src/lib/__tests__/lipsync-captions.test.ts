// Lip sync captions and frame rate: a finished lip sync's captions read from the renderer (HeyGen's `caption_url`, an
// SRT), and how the result's frames are timed (HeyGen `fps_mode`). Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { forgetLipsyncChecks, lipsyncCaptions, lipsyncRequestSchema, startLipsync } from "../services";
import { ConflictError, NotFoundError, UpstreamError, ValidationError } from "../errors";
import { getStore } from "../store";
import { cuesToSrt, cuesToVtt } from "../captions";
import type { LipsyncJob } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetLipsyncChecks();
});

const VIDEO = "https://93.184.216.34/talk.mp4";
const AUDIO = "https://93.184.216.34/take.mp3";
const ask = (extra: Record<string, unknown>) => lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO, ...extra });
const now = () => new Date().toISOString();
async function job(extra: Partial<LipsyncJob>): Promise<LipsyncJob> {
  return getStore().put("lipsync", {
    id: `ls_${Math.random().toString(36).slice(2, 10)}`,
    ownerId: "u1",
    title: "Founder update (lip-synced)",
    sourceUrl: VIDEO,
    audioUrl: AUDIO,
    mode: "speed",
    provider: "mock",
    providerJobId: "mockls_0",
    status: "completed",
    videoUrl: "https://93.184.216.34/synced.mp4",
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  } as LipsyncJob);
}

/** Runs `fn` with HeyGen as the renderer and its API answered by `answer` (anything unanswered is a 500). */
async function withHeyGen(answer: (url: string, init?: RequestInit) => Response | undefined, fn: (calls: Array<{ url: string; body?: unknown }>) => Promise<void>) {
  const { config } = await import("../config");
  const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
  const calls: Array<{ url: string; body?: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return answer(url, init) ?? new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
  }
}

describe("lip sync frame rate", () => {
  it("is constant, variable, or the footage's, left to HeyGen when blank, and kept with the job", async () => {
    assert.equal(ask({ frameRate: "constant" }).frameRate, "constant");
    assert.equal(ask({ frameRate: "" }).frameRate, undefined);
    assert.equal(ask({ frameRate: null }).frameRate, undefined);
    const bad = lipsyncRequestSchema.safeParse({ sourceUrl: VIDEO, audioUrl: AUDIO, frameRate: "60fps" });
    assert.equal(bad.success, false);
    assert.match(bad.error!.issues[0].message, /constant, variable, or source/);
    const started = await startLipsync(ask({ frameRate: "source" }), "u1", { key: "lipsync-frame-1" });
    assert.equal(started.frameRate, "source");
    assert.equal((await startLipsync(ask({ frameRate: "source" }), "u1", { key: "lipsync-frame-1" })).id, started.id);
    await assert.rejects(startLipsync(ask({ frameRate: "constant" }), "u1", { key: "lipsync-frame-1" }), ConflictError);
    await assert.rejects(startLipsync(ask({}), "u1", { key: "lipsync-frame-1" }), ConflictError);
  });

  it("is sent to HeyGen as fps_mode only when chosen", async () => {
    await withHeyGen(
      (url, init) => (url === "https://api.heygen.com/v3/lipsyncs" && init?.method === "POST" ? Response.json({ data: { lipsync_id: "ls_hg" } }) : undefined),
      async (calls) => {
        await startLipsync(ask({ frameRate: "constant" }), "u1");
        await startLipsync(ask({ frameRate: "variable" }), "u1");
        await startLipsync(ask({ frameRate: "source" }), "u1");
        await startLipsync(ask({}), "u1");
        const bodies = calls.filter((c) => c.body).map((c) => (c.body as Record<string, unknown>).fps_mode);
        assert.deepEqual(bodies, ["cfr", "vfr", "passthrough", undefined]);
      },
    );
  });
});

describe("lip sync captions", () => {
  it("come from the demo renderer once the lip sync is finished, as SRT or WebVTT", async () => {
    const done = await job({});
    const { title, cues } = await lipsyncCaptions(done.id, "u1");
    assert.equal(title, "Founder update (lip-synced)");
    assert.equal(cues.length, 3);
    assert.match(cuesToSrt(cues), /^1\n00:00:00,000 --> 00:00:03,800\nThis is the demo lip sync\./);
    assert.match(cuesToVtt(cues), /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:03\.800/);
  });

  it("are refused while syncing, after a failure, for another account, or for an id that is no lip sync's", async () => {
    const running = await job({ status: "processing", videoUrl: undefined });
    await assert.rejects(lipsyncCaptions(running.id, "u1"), (e: unknown) => e instanceof ValidationError && /once the lip sync is finished/.test((e as Error).message));
    const failed = await job({ status: "failed", videoUrl: undefined, error: "No face" });
    await assert.rejects(lipsyncCaptions(failed.id, "u1"), /failed, so it has no captions/);
    const theirs = await job({ ownerId: "u2" });
    await assert.rejects(lipsyncCaptions(theirs.id, "u1"), NotFoundError);
    await assert.rejects(lipsyncCaptions("../etc", "u1"), NotFoundError);
  });

  it("are read from HeyGen's caption link each time, and say when HeyGen has none or cannot give them", async () => {
    const srt = "1\r\n00:00:00,500 --> 00:00:02,000\r\nHello there.\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,250\r\nWelcome back.\r\n";
    let captionStatus = 200;
    let captionUrl: string | null = "https://files.heygen.ai/ls_hg/captions.srt?sig=1";
    await withHeyGen(
      (url) => {
        if (url === "https://api.heygen.com/v3/lipsyncs/ls_hg") return Response.json({ data: { id: "ls_hg", status: "completed", video_url: "https://files.heygen.ai/ls_hg.mp4", caption_url: captionUrl } });
        if (url === "https://api.heygen.com/v3/lipsyncs/ls_gone") return Response.json({ error: { code: "not_found", message: "Lipsync not found." } }, { status: 404 });
        if (url.startsWith("https://files.heygen.ai/ls_hg/captions.srt")) return new Response(captionStatus === 200 ? srt : "nope", { status: captionStatus });
        return undefined;
      },
      async (calls) => {
        const synced = await job({ provider: "heygen", providerJobId: "ls_hg" });
        assert.deepEqual((await lipsyncCaptions(synced.id, "u1")).cues, [
          { startMs: 500, endMs: 2000, text: "Hello there." },
          { startMs: 2000, endMs: 4250, text: "Welcome back." },
        ]);
        await lipsyncCaptions(synced.id, "u1");
        assert.equal(calls.filter((c) => c.url.startsWith("https://files.heygen.ai/")).length, 2, "the link is read afresh each time, never kept");
        captionStatus = 403;
        await assert.rejects(lipsyncCaptions(synced.id, "u1"), (e: unknown) => e instanceof UpstreamError && /could not be read \(403\)/.test((e as Error).message));
        captionUrl = null;
        await assert.rejects(lipsyncCaptions(synced.id, "u1"), (e: unknown) => e instanceof NotFoundError && /no captions for this lip sync/.test((e as Error).message));
        captionUrl = "http://files.heygen.ai/ls_hg/captions.srt";
        await assert.rejects(lipsyncCaptions(synced.id, "u1"), NotFoundError, "only an https link is read");
        const gone = await job({ provider: "heygen", providerJobId: "ls_gone" });
        await assert.rejects(lipsyncCaptions(gone.id, "u1"), NotFoundError);
      },
    );
  });

  it("say only to try again when HeyGen does not answer, never its job id, and are counted only when HeyGen is asked", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      await withHeyGen(
        (url) => {
          if (url === "https://api.heygen.com/v3/lipsyncs/ls_secret_job") return Response.json({ error: { code: "server_error", message: "boom" } }, { status: 500 });
          if (url === "https://api.heygen.com/v3/lipsyncs/ls_slow") return Response.json({ data: { id: "ls_slow", status: "completed", caption_url: "https://files.heygen.ai/slow.srt" } });
          if (url === "https://files.heygen.ai/slow.srt") throw new TypeError("fetch failed");
          return undefined;
        },
        async () => {
          const down = await job({ provider: "heygen", providerJobId: "ls_secret_job" });
          await assert.rejects(lipsyncCaptions(down.id, "u1"), (e: unknown) => e instanceof UpstreamError && /try again/.test((e as Error).message) && !/ls_secret_job|500/.test((e as Error).message));
          const slow = await job({ provider: "heygen", providerJobId: "ls_slow" });
          await assert.rejects(lipsyncCaptions(slow.id, "u1"), (e: unknown) => e instanceof UpstreamError && (e as Error).message === "HeyGen's captions could not be read; try again");
        },
      );
    } finally {
      console.error = quiet;
    }
    let admitted = 0;
    const admit = () => void admitted++;
    const running = await job({ status: "processing", videoUrl: undefined });
    await assert.rejects(lipsyncCaptions(running.id, "u1", { admit }), ValidationError);
    await assert.rejects(lipsyncCaptions("ls_missing123", "u1", { admit }), NotFoundError);
    assert.equal(admitted, 0, "a refused request is not counted");
    await lipsyncCaptions((await job({})).id, "u1", { admit });
    assert.equal(admitted, 1);
    await assert.rejects(
      lipsyncCaptions((await job({})).id, "u1", {
        admit: () => {
          throw new ConflictError("over");
        },
      }),
      ConflictError,
      "a refused admit stops before the renderer is asked",
    );
  });
});
