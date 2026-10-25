// Corrected captions: validation, what the downloads serve, and how edits interact with other writes.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import {
  captionCuesFor,
  captionCuesSchema,
  createVideo,
  deleteVideo,
  getVideo,
  resetCaptionCues,
  reviewActionSchema,
  reviewVideo,
  saveCaptionCues,
  updateVideo,
  videoPatchSchema,
  videoRequestSchema,
} from "../services";
import { cuesToSrt, cuesToVtt } from "../captions";
import { createWorkspace } from "../workspaces";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

async function finishedVideo(ownerId?: string): Promise<Video> {
  const v = await createVideo(videoRequestSchema.parse({ title: "Open house", script: "Welcome to the open house. The kitchen was redone last year.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), ownerId);
  return getStore().put("video", { ...v, status: "completed" as const, durationSec: 10 });
}

const two = (first = "Welcome to the open house.") => captionCuesSchema.parse({ cues: [{ startMs: 0, endMs: 4000, text: first }, { startMs: 4000, endMs: 10000, text: "The kitchen was redone in 2024." }] });

describe("caption edits", () => {
  it("accepts lines in order and refuses overlaps, empty lines, and lines that end before they start", () => {
    assert.equal(two().cues.length, 2);
    const parse = (cues: unknown[]) => captionCuesSchema.safeParse({ cues });
    assert.match(JSON.stringify(parse([{ startMs: 0, endMs: 4000, text: "a" }, { startMs: 3000, endMs: 5000, text: "b" }]).error?.issues), /Line 2 starts before line 1 ends/);
    assert.match(JSON.stringify(parse([{ startMs: 2000, endMs: 2000, text: "a" }]).error?.issues), /Line 1 must end after it starts/);
    assert.match(JSON.stringify(parse([{ startMs: 0, endMs: 1000, text: "a" }, { startMs: 1000, endMs: 2000, text: "   " }]).error?.issues), /Line 2 needs some text/);
    assert.equal(parse([]).success, false, "an empty list is a reset, which has its own route");
    assert.equal(parse([{ startMs: -1, endMs: 1000, text: "a" }]).success, false);
    assert.equal(parse([{ startMs: 0.5, endMs: 1000, text: "a" }]).success, false, "whole milliseconds only");
  });

  it("serves the corrections instead of the script's lines, and goes back to the script on reset", async () => {
    const v = await finishedVideo();
    const auto = captionCuesFor(v);
    assert.equal(auto.edited, false);
    assert.equal(auto.cues[0].text, "Welcome to the open house.");
    assert.equal(auto.cues.at(-1)?.endMs, 10000);
    const saved = await saveCaptionCues(v.id, two());
    assert.deepEqual(captionCuesFor(saved), { cues: two().cues, edited: true });
    assert.match(cuesToSrt(captionCuesFor(saved).cues), /^1\n00:00:00,000 --> 00:00:04,000\nWelcome to the open house\.\n\n2\n00:00:04,000 --> 00:00:10,000\nThe kitchen was redone in 2024\.\n$/);
    const reset = await resetCaptionCues(v.id);
    assert.equal(reset.captionCues, undefined);
    assert.equal(captionCuesFor(reset).edited, false);
    assert.equal(await resetCaptionCues(v.id).then((x) => x.updatedAt), reset.updatedAt, "resetting twice writes nothing");
  });

  it("keeps a line's own line breaks but never a blank line, which would end the cue", () => {
    const cues = [{ startMs: 0, endMs: 1500, text: "First half\n\n  second half  " }];
    assert.equal(cuesToSrt(cues), "1\n00:00:00,000 --> 00:00:01,500\nFirst half\nsecond half\n");
    assert.equal(cuesToVtt(cues, "top"), "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500 line:5%\nFirst half\nsecond half\n");
  });

  it("keeps a line's text as text: it cannot start a cue of its own, open a tag, or lose an entity", () => {
    const forged = [{ startMs: 0, endMs: 1000, text: "Hi\n00:00:00.000 --> 04:00:00.000 line:0%\nVisit spam.example <b>now</b> &amp; A --> B" }];
    const vtt = cuesToVtt(forged);
    assert.equal(vtt.match(/-->/g)?.length, 1, "only the real timing line has an arrow");
    assert.ok(vtt.includes("00:00:00.000 --&gt; 04:00:00.000 line:0%"));
    assert.ok(vtt.includes("&lt;b&gt;now&lt;/b&gt; &amp;amp; A --&gt; B"));
    const srt = cuesToSrt(forged);
    assert.equal(srt.match(/-->/g)?.length, 1);
    assert.ok(srt.includes("00:00:00.000 → 04:00:00.000"));
  });

  it("leaves corrected captions off library cards", async () => {
    const { queryVideos, videoQuerySchema } = await import("../services");
    const v = await finishedVideo();
    await saveCaptionCues(v.id, two());
    const { videos } = await queryVideos(undefined, videoQuerySchema.parse({}));
    assert.equal(videos.find((x) => x.id === v.id)?.captionCues, undefined);
    assert.ok((await getVideo(v.id, undefined, false)).captionCues, "the video page still gets them");
  });

  it("clears an approval, is refused in the trash and for another owner", async () => {
    const alice = { id: "user_alice", email: "alice@example.com" };
    const ws = await createWorkspace("Acme", alice);
    const v = await finishedVideo(ws.id);
    await reviewVideo(v.id, ws.id, alice, true, reviewActionSchema.parse({ action: "request" }));
    await reviewVideo(v.id, ws.id, alice, true, reviewActionSchema.parse({ action: "approve" }));
    assert.equal((await saveCaptionCues(v.id, two(), ws.id)).review, undefined, "viewers would see different captions than the ones approved");
    await assert.rejects(saveCaptionCues(v.id, two(), "someone-else"), /not found/);
    await deleteVideo(v.id, ws.id);
    await assert.rejects(saveCaptionCues(v.id, two(), ws.id), /Restore the video/);
  });

  it("an owner edit in flight does not drop corrections saved meanwhile", async () => {
    const v = await finishedVideo();
    // The password edit reads the record, then hashes before it writes; the captions land in between.
    const edit = updateVideo(v.id, videoPatchSchema.parse({ sharePassword: "secret12" }));
    await saveCaptionCues(v.id, two("Welcome, everyone."));
    await edit;
    assert.equal((await getVideo(v.id, undefined, false)).captionCues?.[0].text, "Welcome, everyone.");
  });
});
