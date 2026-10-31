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

describe("captions timed by their words", () => {
  it("puts words into short lines at sentence ends, silences, and full lines, never overlapping", async () => {
    const { wordCues, cuesToSrt } = await import("../captions");
    const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });
    // A sentence end starts a new line; so does a silence of 0.6s or more.
    const cues = wordCues([w("Welcome", 0, 0.4), w("aboard.", 0.4, 0.9), w("Today", 1, 1.3), w("we", 1.3, 1.4), w("ship", 2.2, 2.6)]);
    assert.deepEqual(cues.map((c) => [c.startMs, c.endMs, c.text]), [[0, 900, "Welcome aboard."], [1000, 1700, "Today we"], [2200, 2900, "ship"]], "a line shows to its last word, and a short one 0.7s");
    // A short line close to the next stays up only until the next begins.
    assert.deepEqual(wordCues([w("Go.", 0, 0.2), w("Now", 0.4, 0.6)]).map((c) => [c.startMs, c.endMs]), [[0, 400], [400, 1100]]);
    // A full line (64 characters) or one up for 6 seconds ends; a quote after the stop still ends the sentence.
    const long = Array.from({ length: 20 }, (_, i) => w(`word${i}`, i * 0.2, i * 0.2 + 0.2));
    assert.ok(wordCues(long).every((c) => c.text.length <= 64));
    assert.equal(wordCues(long).map((c) => c.text).join(" "), long.map((x) => x.text).join(" "), "no word is lost or repeated");
    const slow = Array.from({ length: 8 }, (_, i) => w(`w${i}`, i, i + 0.9));
    assert.ok(wordCues(slow).every((c) => c.endMs - c.startMs <= 6_000));
    assert.equal(wordCues([w('"Done."', 0, 0.5), w("Next", 0.5, 0.8)]).length, 2);
    // Words of a script without spaces are joined without one; blank words are skipped.
    assert.deepEqual(wordCues([w("你好", 0, 0.4), w("世界", 0.4, 0.8), w(" ", 0.8, 0.9)]).map((c) => c.text), ["你好世界"]);
    assert.deepEqual(wordCues([]), []);
    // Words said over each other never give overlapping lines, nor do two lines starting together.
    const overlapping = wordCues([w("Hello.", 0, 1.2), w("Next", 1, 1.7), w("one.", 1.7, 1.7), w("Again", 1.7, 1.8)]);
    overlapping.forEach((c, i) => assert.ok(c.endMs > c.startMs && (i === 0 || c.startMs >= overlapping[i - 1].endMs), JSON.stringify(overlapping)));
    // East Asian punctuation and characters outside the basic plane are joined without a space.
    assert.deepEqual(wordCues([w("你好，", 0, 0.4), w("世界。", 0.4, 0.8)]).map((c) => c.text), ["你好，世界。"]);
    assert.deepEqual(wordCues([w("𠀀", 0, 0.2), w("𠀁", 0.2, 0.4)]).map((c) => c.text), ["𠀀𠀁"]);
    // A word too long for a line (a link) is cut into lines sharing its time.
    const link = `https://example.com/${"a".repeat(120)}`;
    const cutUp = wordCues([w(link, 0, 4)]);
    assert.ok(cutUp.length >= 2 && cutUp.every((c) => c.text.length <= 64));
    assert.equal(cutUp.map((c) => c.text).join(""), link);
    assert.deepEqual([cutUp[0].startMs, cutUp.at(-1)!.startMs < 4000, cutUp.at(-1)!.endMs >= 4000], [0, true, true], "the pieces share the word's time");
    // A long run of Chinese characters becomes several lines (each character counts wider), none longer than 6 seconds.
    const han = Array.from({ length: 300 }, (_, i) => w("字", i * 0.2, i * 0.2 + 0.2));
    const hanCues = wordCues(han);
    assert.ok(hanCues.length > 5 && hanCues.every((c) => Array.from(c.text).length <= 29 && c.endMs - c.startMs <= 6_000));
    assert.equal(hanCues.map((c) => c.text).join(""), "字".repeat(300));
    assert.match(cuesToSrt(cues), /^1\n00:00:00,000 --> 00:00:00,900\nWelcome aboard\.\n/);
  });

  it("reads HeyGen's word timings, or puts words together from its characters", async () => {
    const { timedWords } = await import("../providers/avatar/heygen");
    // Its words when sent: blank, unreadable, and backwards entries are dropped, times kept within the audio, in order.
    assert.deepEqual(
      timedWords([{ text: " late ", start_time: 1.5, end_time: 9 }, { text: "Hi", start_time: 0, end_time: 0.25 }, { text: "", start_time: 0.3, end_time: 0.4 }, { text: "x", start_time: 0.5, end_time: 0.2 }, { text: 4, start_time: 0, end_time: 1 }, { text: "bad", start_time: "a", end_time: 1 }, null], null, 2),
      [{ text: "Hi", startSec: 0, endSec: 0.25 }, { text: "late", startSec: 1.5, endSec: 2 }],
    );
    // Only characters: a blank ends a word.
    const chars = [..."Hi  all!"].map((c, i) => ({ text: c, start_time: i * 0.1, end_time: i * 0.1 + 0.1 }));
    assert.deepEqual(timedWords(undefined, chars), [{ text: "Hi", startSec: 0, endSec: 0.2 }, { text: "all!", startSec: 0.4, endSec: 0.8 }]);
    // Characters of a script written without spaces are words of their own, so nothing is cut off.
    const han = Array.from({ length: 300 }, (_, i) => ({ text: i % 50 === 49 ? "。" : "字", start_time: i * 0.2, end_time: i * 0.2 + 0.2 }));
    const hanWords = timedWords(undefined, han);
    assert.equal(hanWords.length, 300);
    assert.equal(hanWords.map((x) => x.text).join(""), han.map((c) => c.text).join(""));
    // A very long word is kept whole up to 1,000 characters, never splitting a character in two.
    assert.equal(timedWords([{ text: "a".repeat(999) + "😀x", start_time: 0, end_time: 1 }], null)[0].text, "a".repeat(999) + "😀");
    // Words sent empty fall back to the characters; neither gives nothing.
    assert.equal(timedWords([], chars).length, 2);
    assert.deepEqual(timedWords(null, "nope"), []);
  });
});
