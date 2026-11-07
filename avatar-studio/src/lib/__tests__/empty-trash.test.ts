// Emptying the trash in one step: every trashed video of the account goes for good, the library stays.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore, type ItemKind } from "../store";
import { emptyTrash, queryVideos, restoreVideo, videoQuerySchema } from "../services";
import { ConflictError } from "../errors";
import { EMPTY_TRASH_MAX, TRASH_RETENTION_DAYS, type Video } from "../types";

const OWNER = "user_empty_trash";
const made = (id: string, patch: Partial<Video> = {}) =>
  ({ id, ownerId: OWNER, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch }) as Video;
const trashedAt = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const ids = async () => (await getStore().list<Video>("video", OWNER)).map((v) => v.id).sort();

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("empty trash", () => {
  it("deletes every trashed video of the account and leaves the library and other accounts alone", async () => {
    await getStore().put("video", made("live"));
    await getStore().put("video", made("t1", { deletedAt: trashedAt(5), folder: "Launch" }));
    await getStore().put("video", made("t2", { deletedAt: trashedAt(1), status: "failed" }));
    await getStore().put("video", made("theirs", { ownerId: "someone_else", deletedAt: trashedAt(1) }));
    assert.deepEqual(await emptyTrash({ expected: 2 }, OWNER), { done: 2, remaining: 0 });
    assert.deepEqual(await ids(), ["live"]);
    assert.ok(await getStore().get("video", "theirs"), "another account's trash is not touched");
    const page = await queryVideos(OWNER, videoQuerySchema.parse({}));
    assert.deepEqual([page.total, page.trashed], [1, 0]);
    // An empty trash is nothing to do.
    assert.deepEqual(await emptyTrash({ expected: 0 }, OWNER), { done: 0, remaining: 0 });
  });

  it("refuses when the trash holds another number than the caller saw, deleting nothing", async () => {
    await getStore().put("video", made("t1", { deletedAt: trashedAt(5) }));
    await getStore().put("video", made("t2", { deletedAt: trashedAt(1) }));
    await assert.rejects(emptyTrash({ expected: 1 }, OWNER), (err: unknown) => err instanceof ConflictError && /now holds 2 videos, not 1/.test(err.message));
    await assert.rejects(emptyTrash({ expected: 3 }, OWNER), ConflictError);
    assert.deepEqual(await ids(), ["t1", "t2"]);
  });

  it("takes the longest-trashed first, a bounded number a call, and says how many are left", async () => {
    const n = EMPTY_TRASH_MAX + 3;
    for (let i = 0; i < n; i++) await getStore().put("video", made(`t${i}`, { deletedAt: trashedAt(n - i) }));
    assert.deepEqual(await emptyTrash({ expected: n }, OWNER), { done: EMPTY_TRASH_MAX, remaining: 3 });
    // The three trashed last are the ones left.
    assert.deepEqual(await ids(), [`t${n - 3}`, `t${n - 2}`, `t${n - 1}`].sort());
    assert.deepEqual(await emptyTrash({ expected: 3 }, OWNER), { done: 3, remaining: 0 });
  });

  it("also deletes videos already past retention, without counting them, as the owner no longer saw them", async () => {
    const due = new Date(Date.now() - (TRASH_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    await getStore().put("video", made("old", { deletedAt: due }));
    await getStore().put("video", made("t1", { deletedAt: trashedAt(1) }));
    assert.deepEqual(await emptyTrash({ expected: 1 }, OWNER), { done: 1, remaining: 0 });
    assert.deepEqual(await ids(), []);
  });

  it("starts no more deletes past its deadline and reports the rest as remaining", async () => {
    for (let i = 0; i < 4; i++) await getStore().put("video", made(`t${i}`, { deletedAt: trashedAt(10 - i) }));
    // The clock jumps past the deadline once two video rows have gone.
    let t = Date.now();
    const clock = () => t;
    const store = getStore();
    const remove = store.remove.bind(store);
    let removed = 0;
    store.remove = (async (kind: ItemKind, id: string) => {
      await remove(kind, id);
      if (kind === "video" && ++removed === 2) t += 61_000;
    }) as typeof store.remove;
    assert.deepEqual(await emptyTrash({ expected: 4 }, OWNER, clock), { done: 2, remaining: 2 });
    assert.deepEqual(await ids(), ["t2", "t3"]);
  });

  it("keeps a video restored after the trash was read", async () => {
    await getStore().put("video", made("back", { deletedAt: trashedAt(2) }));
    await getStore().put("video", made("gone", { deletedAt: trashedAt(1) }));
    // Restore "back" the moment the purge pass first reads it, as a request racing the button would.
    const store = getStore();
    const get = store.get.bind(store);
    let reads = 0;
    store.get = (async (kind: ItemKind, id: string) => {
      const found = await get(kind, id);
      if (kind === "video" && id === "back" && reads++ === 0 && found) {
        const { deletedAt: _d, ...rest } = found as Video;
        void _d;
        await store.put("video", rest);
        return rest;
      }
      return found;
    }) as typeof store.get;
    assert.deepEqual(await emptyTrash({ expected: 2 }, OWNER), { done: 1, remaining: 0 });
    assert.ok(await get("video", "back"), "the restored video is kept");
    assert.equal(await get("video", "gone"), null);
  });

  it("waits for a restore already under way on the same video, and keeps it", async () => {
    await getStore().put("video", made("back", { deletedAt: trashedAt(2) }));
    const store = getStore();
    const list = store.list.bind(store);
    const put = store.put.bind(store);
    // The restore's write is slow: without the lock, the purge would read the video still trashed and delete it.
    store.put = (async (kind: ItemKind, item: Video) => {
      if (kind === "video" && item.id === "back" && !item.deletedAt) await new Promise((r) => setTimeout(r, 30));
      return put(kind, item);
    }) as typeof store.put;
    let restoring: Promise<Video> | undefined;
    store.list = (async (kind: ItemKind, owner?: string) => {
      const found = await list(kind, owner);
      // Started as the trash is read, so it holds the video's lock before the purge asks for it.
      restoring ??= restoreVideo("back", OWNER);
      return found;
    }) as typeof store.list;
    const result = await emptyTrash({ expected: 1 }, OWNER);
    assert.equal((await restoring)?.deletedAt, undefined);
    // The proof is `done: 0`: without the lock the purge deletes the video and the slow restore writes it back after.
    assert.deepEqual(result, { done: 0, remaining: 0 });
    assert.ok(await store.get("video", "back"));
  });

  it("leaves a video whose delete fails in the trash and goes on with the rest", async () => {
    await getStore().put("video", made("stuck", { deletedAt: trashedAt(2) }));
    await getStore().put("video", made("fine", { deletedAt: trashedAt(1) }));
    const store = getStore();
    const remove = store.remove.bind(store);
    store.remove = (async (kind: ItemKind, id: string) => {
      if (kind === "video" && id === "stuck") throw new Error("store unavailable");
      return remove(kind, id);
    }) as typeof store.remove;
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      assert.deepEqual(await emptyTrash({ expected: 2 }, OWNER), { done: 1, remaining: 1 });
    } finally {
      console.error = log;
    }
    assert.equal(errors.length, 1);
    assert.ok(await store.get("video", "stuck"));
  });

  it("still reports the deletes when counting what is left fails", async () => {
    await getStore().put("video", made("t1", { deletedAt: trashedAt(2) }));
    await getStore().put("video", made("t2", { deletedAt: trashedAt(1) }));
    const store = getStore();
    const list = store.list.bind(store);
    let lists = 0;
    store.list = (async (kind: ItemKind, owner?: string) => {
      if (kind === "video" && lists++ > 0) throw new Error("store unavailable");
      return list(kind, owner);
    }) as typeof store.list;
    const log = console.error;
    console.error = () => undefined;
    try {
      assert.deepEqual(await emptyTrash({ expected: 2 }, OWNER), { done: 2, remaining: 0 });
    } finally {
      console.error = log;
    }
  });
});
