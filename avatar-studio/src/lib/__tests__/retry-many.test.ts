// Many failed renders started again in one go: each as its own retry, the month's allowance reserved before any
// starts, and every id accounted for. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { MAX_RETRY_AT_ONCE, rendersThisMonth, retryManySchema, retryVideos } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Video } from "../types";

const OWNER = "user_retry_many";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

async function stored(id: string, patch: Partial<Video> = {}): Promise<Video> {
  const now = new Date().toISOString();
  const video = { id, ownerId: OWNER, title: `Video ${id}`, script: "Doors open Saturday.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, status: "failed", provider: "mock", error: "boom", createdAt: now, updatedAt: now, ...patch } as Video;
  return getStore().put("video", video);
}

describe("retry many failed renders", () => {
  it("starts each failed render as a retry and says why the others were left", async () => {
    await stored("vid_a", { folder: "Launch" });
    await stored("vid_b");
    await stored("vid_done", { status: "completed", error: undefined });
    await stored("vid_bin", { deletedAt: new Date().toISOString() });
    await stored("vid_cut", { directed: { editOf: { id: "vid_src", title: "Source" } } } as unknown as Partial<Video>);
    await stored("vid_theirs", { ownerId: "someone_else" });
    const r = await retryVideos(["vid_a", "vid_b", "vid_a", "vid_done", "vid_bin", "vid_cut", "vid_theirs", "vid_unknown"], OWNER);
    assert.deepEqual(r.started.map((s) => s.from), ["vid_a", "vid_b"], "in the order given, each once");
    const first = await getStore().get<Video>("video", r.started[0].id);
    assert.deepEqual([first?.retryOf, first?.folder, first?.status === "failed"], ["vid_a", "Launch", false]);
    assert.deepEqual(r.skipped, [
      { id: "vid_done", code: "not_failed", reason: "Not a failed render" },
      { id: "vid_bin", code: "trashed", reason: "In the trash" },
      { id: "vid_cut", code: "edited_cut", reason: "An edited cut is not retried" },
    ]);
    assert.deepEqual(r.missing, ["vid_theirs", "vid_unknown"]);
    assert.deepEqual(r.failedAgain, []);
  });

  it("reserves the allowance before starting any, and skips the ones past it", async () => {
    const { config } = await import("../config");
    const original = config.renderLimitPerMonth;
    (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = 2;
    try {
      for (const id of ["vid_1", "vid_2", "vid_3"]) await stored(id);
      const r = await retryVideos(["vid_1", "vid_2", "vid_3"], OWNER);
      assert.deepEqual(r.started.map((s) => s.from), ["vid_1", "vid_2"]);
      assert.deepEqual(r.skipped, [{ id: "vid_3", code: "allowance", reason: "This month's render allowance is used up" }]);
      assert.equal(await rendersThisMonth(OWNER), 2);
      const again = await retryVideos(["vid_3"], OWNER);
      assert.deepEqual([again.started, again.skipped.map((s) => s.code)], [[], ["allowance"]]);
    } finally {
      (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = original;
    }
  });

  it("leaves a failed render already retried to its newest copy, so the same selection is not paid for twice", async () => {
    await stored("vid_once");
    const first = await retryVideos(["vid_once"], OWNER);
    assert.equal(first.started.length, 1);
    const again = await retryVideos(["vid_once"], OWNER);
    assert.deepEqual([again.started, again.skipped], [[], [{ id: "vid_once", code: "retried", reason: "Already started again" }]]);
    // When the copy fails as well, it is the one to retry; the original still is not.
    const copy = first.started[0].id;
    await getStore().put("video", { ...(await getStore().get<Video>("video", copy))!, status: "failed" as const, error: "boom again" });
    const third = await retryVideos(["vid_once", copy], OWNER);
    assert.deepEqual([third.started.map((s) => s.from), third.skipped.map((s) => s.code)], [[copy], ["retried"]]);
    // A copy that was trashed no longer stands in for the original.
    const later = third.started[0].id;
    await getStore().put("video", { ...(await getStore().get<Video>("video", later))!, deletedAt: new Date().toISOString() });
    assert.deepEqual((await retryVideos([copy], OWNER)).started.map((s) => s.from), [copy]);
  });

  it("keeps the order given when more start than run at once", async () => {
    const ids = ["vid_p", "vid_q", "vid_r", "vid_s", "vid_t", "vid_u", "vid_v"];
    for (const id of ids) await stored(id);
    const r = await retryVideos(ids, OWNER);
    assert.deepEqual(r.started.map((s) => s.from), ids);
    assert.equal(new Set(r.started.map((s) => s.id)).size, ids.length);
  });

  it("checks the allowance again as each starts, so renders started elsewhere meanwhile count", async () => {
    const { config } = await import("../config");
    const { createVideo, videoRequestSchema } = await import("../services");
    const original = config.renderLimitPerMonth;
    (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = 1;
    try {
      await stored("vid_late");
      const store = getStore();
      const get = store.get.bind(store);
      let usageReads = 0;
      let raced = false;
      // Another tab starts a render after the up-front check (the first read of the month's count) and before this
      // one's own start reads the count again.
      (store as { get: typeof store.get }).get = (async (kind: string, id: string) => {
        if (kind === "usage" && ++usageReads === 2 && !raced) {
          raced = true;
          await createVideo(videoRequestSchema.parse({ title: "Elsewhere", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Hi." }), OWNER);
        }
        return get(kind as never, id);
      }) as typeof store.get;
      const r = await retryVideos(["vid_late"], OWNER).finally(() => {
        (store as { get: typeof store.get }).get = get;
      });
      assert.equal(raced, true);
      assert.deepEqual(r.started, []);
      assert.equal(r.failedAgain[0].from, "vid_late");
      assert.equal(r.failedAgain[0].id, undefined);
      assert.equal(await rendersThisMonth(OWNER), 1);
    } finally {
      (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = original;
    }
  });

  it("reports a render that cannot start again without stopping the rest", async () => {
    await stored("vid_gone_avatar", { avatarId: "avatar_that_no_longer_exists" });
    await stored("vid_fine");
    const r = await retryVideos(["vid_gone_avatar", "vid_fine"], OWNER);
    assert.deepEqual(r.started.map((s) => s.from), ["vid_fine"]);
    assert.equal(r.failedAgain.length, 1);
    assert.equal(r.failedAgain[0].from, "vid_gone_avatar");
    assert.ok(r.failedAgain[0].reason.length > 0);
  });

  it("takes between one and the cap's worth of ids", () => {
    assert.equal(retryManySchema.safeParse({ ids: [] }).success, false);
    assert.equal(retryManySchema.safeParse({ ids: Array.from({ length: MAX_RETRY_AT_ONCE }, (_, i) => `vid_${i}`) }).success, true);
    const over = retryManySchema.safeParse({ ids: Array.from({ length: MAX_RETRY_AT_ONCE + 1 }, (_, i) => `vid_${i}`) });
    assert.equal(over.success, false);
    assert.match(over.error!.issues[0].message, /Retry up to 50 renders at a time/);
  });
});
