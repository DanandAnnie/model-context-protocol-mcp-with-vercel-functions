// Lip sync options (HeyGen POST /v3/lipsyncs): only part of the footage, its music taken out, the speech cleaned up, the
// video's length or format kept. What is accepted, checked against a library video's length, kept with the job, and sent.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { forgetLipsyncChecks, lipsyncRequestSchema, startLipsync } from "../services";
import { ConflictError, ValidationError } from "../errors";
import { getStore } from "../store";
import type { Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetLipsyncChecks();
});

const VIDEO = "https://93.184.216.34/talk.mp4";
const AUDIO = "https://93.184.216.34/take.mp3";
const now = () => new Date().toISOString();
async function finished(owner: string, extra: Partial<Video> = {}): Promise<Video> {
  return getStore().put("video", {
    id: `vid_${Math.random().toString(36).slice(2, 10)}`,
    ownerId: owner,
    title: "Founder update",
    script: "Hello.",
    avatarId: "stock_1",
    voiceId: "stock_voice_1",
    aspect: "16:9",
    background: { type: "color", value: "#000000" },
    captions: false,
    speed: 1,
    status: "completed",
    provider: "mock",
    videoUrl: "https://93.184.216.34/update.mp4",
    durationSec: 40,
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  } as Video);
}
const ask = (extra: Record<string, unknown>) => lipsyncRequestSchema.parse({ sourceUrl: VIDEO, audioUrl: AUDIO, ...extra });

describe("lip sync options", () => {
  it("take a part of the footage in seconds, to a tenth, and options that are on or left out", () => {
    const part = ask({ startSec: 12.34, endSec: "", removeMusic: true, enhanceSpeech: false, keepLength: true, keepFormat: true });
    assert.deepEqual([part.startSec, part.endSec, part.removeMusic, part.enhanceSpeech, part.keepLength, part.keepFormat], [12.3, undefined, true, undefined, true, true]);
    assert.equal(ask({ startSec: 0, endSec: 8 }).startSec, undefined, "from the start is no start");
    assert.equal(ask({ endSec: 8 }).endSec, 8);
    assert.equal(ask({ removeMusic: null, startSec: null }).removeMusic, undefined, "null is an option left out");
    for (const [bad, message] of [
      [{ startSec: -1 }, /from the start of the video/],
      [{ startSec: 5, endSec: 5.5 }, /at least 1 second after its start/],
      [{ endSec: 0.5 }, /at least 1 second after its start/],
      [{ startSec: "ten" }, /number of seconds/],
      [{ endSec: 5 * 3600 }, /first 4 hours/],
      [{ removeMusic: "yes" }, /true or false/],
    ] as const) {
      const out = lipsyncRequestSchema.safeParse({ sourceUrl: VIDEO, audioUrl: AUDIO, ...bad });
      assert.equal(out.success, false, JSON.stringify(bad));
      assert.match(out.error!.issues[0].message, message);
    }
  });

  it("are kept with the job, checked against a library video's length, and part of what a repeated key must match", async () => {
    const job = await startLipsync(ask({ startSec: 3, endSec: 9.5, removeMusic: true, keepFormat: true }), "u1");
    assert.deepEqual([job.startSec, job.endSec, job.removeMusic, job.enhanceSpeech, job.keepLength, job.keepFormat], [3, 9.5, true, undefined, undefined, true]);
    const video = await finished("u1");
    const fromLibrary = (extra: Record<string, unknown>) => lipsyncRequestSchema.parse({ videoId: video.id, audioUrl: AUDIO, ...extra });
    await assert.rejects(startLipsync(fromLibrary({ startSec: 39.5 }), "u1"), (e: unknown) => e instanceof ValidationError && /The video is 40 seconds long; start the part before 39 seconds/.test((e as Error).message));
    await assert.rejects(startLipsync(fromLibrary({ endSec: 41 }), "u1"), /The video is 40 seconds long; end the part by then/);
    assert.equal((await startLipsync(fromLibrary({ endSec: 40.4 }), "u1")).endSec, 40.4, "within half a second of the end is the end");
    // The moment named is one that is taken, though the video's length is not a whole second.
    const odd = await finished("u1", { durationSec: 40.6 });
    await assert.rejects(startLipsync(lipsyncRequestSchema.parse({ videoId: odd.id, audioUrl: AUDIO, startSec: 39.7 }), "u1"), /start the part before 39 seconds/);
    assert.equal((await startLipsync(lipsyncRequestSchema.parse({ videoId: odd.id, audioUrl: AUDIO, startSec: 38.9 }), "u1")).startSec, 38.9);
    const keyed = await startLipsync(ask({ removeMusic: true }), "u1", { key: "lipsync-options-1" });
    assert.equal((await startLipsync(ask({ removeMusic: true }), "u1", { key: "lipsync-options-1" })).id, keyed.id);
    await assert.rejects(startLipsync(ask({ removeMusic: true, enhanceSpeech: true }), "u1", { key: "lipsync-options-1" }), ConflictError);
    await assert.rejects(startLipsync(ask({ removeMusic: true, startSec: 2 }), "u1", { key: "lipsync-options-1" }), ConflictError);
  });

  it("are sent to HeyGen only when asked for, HeyGen's defaults standing otherwise", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const bodies: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.heygen.com/v3/lipsyncs" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ data: { lipsync_id: `ls_hg${bodies.length}` } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      await startLipsync(ask({ startSec: 3, endSec: 9.5, removeMusic: true, enhanceSpeech: true, keepLength: true, keepFormat: true }), "u1");
      assert.deepEqual(bodies[0], {
        video: { type: "url", url: VIDEO },
        audio: { type: "url", url: AUDIO },
        mode: "speed",
        title: "Lip-synced video",
        start_time: 3,
        end_time: 9.5,
        disable_music_track: true,
        enable_speech_enhancement: true,
        enable_dynamic_duration: false,
        keep_the_same_format: true,
      });
      await startLipsync(ask({ endSec: 20, mode: "precision" }), "u1");
      assert.deepEqual(bodies[1], { video: { type: "url", url: VIDEO }, audio: { type: "url", url: AUDIO }, mode: "precision", title: "Lip-synced video", end_time: 20 });
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });
});
