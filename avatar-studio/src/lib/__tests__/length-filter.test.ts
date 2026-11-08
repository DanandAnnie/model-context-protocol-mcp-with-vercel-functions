// The library filtered by length: under a minute, one to three minutes, over three, with the other filters. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { LENGTH_FILTERS, formatSeconds, inLength, withoutLibraryFilters } from "../client";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { filterVideos, queryVideos, videoQuerySchema } from "../services";
import { applyAvatarWebhook } from "../services/videos";
import type { Video } from "../types";

const made = (id: string, durationSec: number | undefined, patch: Partial<Video> = {}) =>
  ({ id, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", aspect: "16:9", durationSec, createdAt: new Date(Date.now() - Number(id.replace(/\D/g, "") || 0) * 1000).toISOString(), updatedAt: new Date().toISOString(), ...patch }) as Video;

describe("length filter", () => {
  // 180.4 seconds shows as 3m 00s, so it is in 1 to 3 minutes; 180.6 shows as 3m 01s.
  const videos = [made("s1", 12), made("m2", 95), made("l3", 400), made("s4", 59.5), made("m5", 60), made("m6", 180), made("m7", 180.4), made("l8", 180.6), made("r9", undefined, { status: "processing" })];
  const ids = (q: Record<string, string>) => filterVideos(videos, videoQuerySchema.parse(q)).map((v) => v.id);

  it("keeps the videos whose running time is in the length asked for, with the minute marks where they belong", () => {
    assert.deepEqual(ids({ length: "short" }), ["s1", "s4"]);
    assert.deepEqual(ids({ length: "medium" }), ["m2", "m5", "m6", "m7"]);
    assert.deepEqual(ids({ length: "long" }), ["l3", "l8"]);
    assert.equal(ids({}).length, 9, "absent means any length, the unfinished render included");
    assert.equal(ids({ length: "all" }).length, 9);
    assert.deepEqual(LENGTH_FILTERS, ["short", "medium", "long"]);
  });

  it("puts a video with no running time, or one not completed, in no length", () => {
    for (const length of LENGTH_FILTERS) {
      assert.equal(inLength({ status: "completed" }, length), false);
      assert.equal(inLength({ status: "completed", durationSec: 0 }, length), false);
      assert.equal(inLength({ status: "completed", durationSec: Number.NaN }, length), false);
      assert.equal(inLength({ status: "completed", durationSec: -5 }, length), false);
    }
    assert.equal(inLength({ status: "completed", durationSec: 0.4 }, "short"), true);
    // A failed render that reported a length, or a render still running, is not finished.
    assert.equal(inLength({ status: "failed", durationSec: 500 }, "long"), false);
    assert.equal(inLength({ status: "processing", durationSec: 30 }, "short"), false);
    assert.equal(inLength({ durationSec: 30 }, "short"), false);
  });

  it("shows a running time to a tenth under a minute and to the second from a minute, as the length filter reads it", () => {
    assert.equal(formatSeconds(180.4), "3m 00s");
    assert.equal(formatSeconds(180.6), "3m 01s");
    assert.equal(formatSeconds(59.6), "59.6s");
    assert.equal(formatSeconds(59.96), "1m 00s");
    assert.equal(formatSeconds(1.5), "1.5s", "a silent scene's hold keeps its tenth");
    assert.equal(formatSeconds(12), "12s");
    assert.equal(formatSeconds(95), "1m 35s");
    assert.equal(inLength({ status: "completed", durationSec: 59.96 }, "medium"), true, "shown as 1m 00s");
    assert.equal(inLength({ status: "completed", durationSec: 59.94 }, "short"), true, "shown as 59.9s");
  });

  it("combines with the other filters and the sort, and refuses an unknown length", () => {
    const more = [...videos, made("l9", 500, { status: "failed" }), made("l10", 300, { starred: true, aspect: "9:16" })];
    const pick = (q: Record<string, string>) => filterVideos(more, videoQuerySchema.parse(q)).map((v) => v.id);
    assert.deepEqual(pick({ length: "long", status: "failed" }), [], "a failed render is in no length");
    assert.deepEqual(pick({ length: "long", starred: "1" }), ["l10"]);
    assert.deepEqual(pick({ length: "long", shape: "portrait" }), ["l10"]);
    assert.deepEqual(pick({ length: "long", sort: "length" }), ["l3", "l10", "l8"]);
    assert.deepEqual(pick({ length: "short", q: "s4" }), ["s4"]);
    assert.equal(videoQuerySchema.safeParse({ length: "60" }).success, false);
    assert.equal(videoQuerySchema.safeParse({ length: "tiny" }).success, false);
  });

  it("filters the trash by length too, and Clear filters takes it off the address", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const owner = "user_length_trash";
    for (const v of [made("t1", 30), made("t2", 200), made("t3", 45)]) await getStore().put("video", { ...v, ownerId: owner, deletedAt: new Date().toISOString() });
    const page = await queryVideos(owner, videoQuerySchema.parse({ trash: "true", length: "short" }));
    assert.deepEqual(page.videos.map((v) => v.id).sort(), ["t1", "t3"]);
    assert.equal(page.trashed, 3, "the toggle still counts the whole trash");
    assert.equal(withoutLibraryFilters("length=long&ref=home"), "?ref=home");
  });

  it("counts the renders in flight a length filter leaves out, for the matching query only", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const owner = "user_length_pending";
    // Renders in flight the demo renderer has only just started (its job id carries the start time), so they stay in flight.
    const running = (id: string, title: string) => made(id, undefined, { status: "processing", title, providerJobId: `mock_${Date.now()}_5` });
    for (const v of [made("d1", 30), running("p2", "Launch teaser"), running("p3", "Launch recap"), running("p4", "Other")]) await getStore().put("video", { ...v, ownerId: owner });
    const ask = async (q: Record<string, string>) => queryVideos(owner, videoQuerySchema.parse(q));
    assert.equal((await ask({})).lengthPending, 0, "no length filter, nothing left out");
    const short = await ask({ length: "short" });
    assert.deepEqual(short.videos.map((v) => v.id), ["d1"]);
    assert.equal(short.lengthPending, 3);
    assert.equal((await ask({ length: "short", q: "launch" })).lengthPending, 2, "only those the search would show");
    assert.equal((await ask({ length: "long", status: "completed" })).lengthPending, 0, "the status filter already leaves them out");
    assert.equal((await ask({ length: "short", trash: "true" })).lengthPending, 0, "the trash view does not wait on renders");
  });

  it("asks the renderer once for the length and poster a completion webhook leaves out, before the one write", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const owner = "user_length_webhook";
    const proto = MockAvatarProvider.prototype as unknown as { parseWebhook?: (body: unknown) => unknown; getStatus: (id: string) => Promise<unknown> };
    const getStatus = proto.getStatus;
    const asked: string[] = [];
    proto.parseWebhook = (body) => ({ providerJobId: (body as { id: string }).id, update: { status: "completed", videoUrl: `https://cdn.example/${(body as { id: string }).id}.mp4` } });
    try {
      // The renderer reports the length and poster when asked.
      proto.getStatus = async (id) => {
        asked.push(id);
        return { status: "completed", videoUrl: "https://cdn.example/other.mp4", thumbnailUrl: "https://cdn.example/poster.jpg", durationSec: 95.2 };
      };
      await getStore().put("video", { ...made("w1", undefined, { status: "processing", providerJobId: "job_w1" }), ownerId: owner });
      const done = await applyAvatarWebhook("mock", { id: "job_w1" });
      assert.equal(done?.status, "completed");
      assert.equal(done?.durationSec, 95.2);
      assert.equal(done?.thumbnailUrl, "https://cdn.example/poster.jpg");
      assert.equal(done?.videoUrl, "https://cdn.example/job_w1.mp4", "the webhook's link is kept");
      const stored = await getStore().get<Video>("video", "w1");
      assert.equal(stored?.durationSec, 95.2);
      assert.deepEqual((await queryVideos(owner, videoQuerySchema.parse({ length: "medium" }))).videos.map((v) => v.id), ["w1"]);
      // A repeated delivery records nothing and asks nothing more.
      await applyAvatarWebhook("mock", { id: "job_w1" });
      assert.deepEqual(asked, ["job_w1"]);

      // A check that fails leaves the video as the webhook recorded it, finished but with no length.
      proto.getStatus = async () => {
        throw new Error("renderer unavailable");
      };
      await getStore().put("video", { ...made("w2", undefined, { status: "processing", providerJobId: "job_w2" }), ownerId: owner });
      const unchecked = await applyAvatarWebhook("mock", { id: "job_w2" });
      assert.equal(unchecked?.status, "completed");
      assert.equal(unchecked?.durationSec, undefined);

      // A render that already has its length and poster (from a status check) is not asked again.
      proto.getStatus = async (id) => {
        asked.push(id);
        return { status: "completed", durationSec: 1 };
      };
      await getStore().put("video", { ...made("w3", 40, { status: "processing", providerJobId: "job_w3", thumbnailUrl: "https://cdn.example/w3.jpg" }), ownerId: owner });
      assert.equal((await applyAvatarWebhook("mock", { id: "job_w3" }))?.durationSec, 40);
      assert.deepEqual(asked, ["job_w1"]);
    } finally {
      delete proto.parseWebhook;
      proto.getStatus = getStatus;
    }
  });
});
