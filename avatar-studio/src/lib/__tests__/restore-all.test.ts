// Restoring the whole trash in one step: every trashed video of the account comes back, as a single restore would.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore, type ItemKind } from "../store";
import { queryVideos, restoreAll, videoQuerySchema } from "../services";
import { RESTORE_ALL_MAX, TRASH_RETENTION_DAYS, type Video } from "../types";

const OWNER = "user_restore_all";
const made = (id: string, patch: Partial<Video> = {}) =>
  ({ id, ownerId: OWNER, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch }) as Video;
const trashedAt = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("restore all", () => {
  it("brings every trashed video of the account back, keeping its folder, star, and counters", async () => {
    await getStore().put("video", made("live"));
    await getStore().put("video", made("t1", { deletedAt: trashedAt(5), folder: "Launch", starred: true, views: 7 }));
    await getStore().put("video", made("t2", { deletedAt: trashedAt(1), status: "failed" }));
    await getStore().put("video", made("theirs", { ownerId: "someone_else", deletedAt: trashedAt(1) }));
    assert.deepEqual(await restoreAll(OWNER), { done: 2, remaining: 0 });
    const t1 = (await getStore().get<Video>("video", "t1"))!;
    assert.equal(t1.deletedAt, undefined);
    assert.deepEqual([t1.folder, t1.starred, t1.views], ["Launch", true, 7]);
    assert.equal((await getStore().get<Video>("video", "theirs"))!.deletedAt !== undefined, true, "another account's trash is not touched");
    const page = await queryVideos(OWNER, videoQuerySchema.parse({}));
    assert.deepEqual([page.total, page.trashed], [3, 0]);
    assert.deepEqual(await restoreAll(OWNER), { done: 0, remaining: 0 });
  });

  it("leaves a video past retention gone", async () => {
    const due = new Date(Date.now() - (TRASH_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    await getStore().put("video", made("old", { deletedAt: due }));
    await getStore().put("video", made("t1", { deletedAt: trashedAt(1) }));
    assert.deepEqual(await restoreAll(OWNER), { done: 1, remaining: 0 });
    assert.ok((await getStore().get<Video>("video", "old"))!.deletedAt, "not brought back");
  });

  it("takes the longest-trashed first, a bounded number a call, and says how many are left", async () => {
    const n = RESTORE_ALL_MAX + 2;
    for (let i = 0; i < n; i++) await getStore().put("video", made(`t${i}`, { deletedAt: trashedAt(n - i) }));
    assert.deepEqual(await restoreAll(OWNER), { done: RESTORE_ALL_MAX, remaining: 2 });
    const left = (await getStore().list<Video>("video", OWNER)).filter((v) => v.deletedAt).map((v) => v.id).sort();
    assert.deepEqual(left, [`t${n - 2}`, `t${n - 1}`].sort(), "the two trashed last are left");
    assert.deepEqual(await restoreAll(OWNER), { done: 2, remaining: 0 });
  });

  it("skips a video deleted for good meanwhile, and goes on when one restore fails", async () => {
    // In the order they are restored: the one deleted meanwhile, then the failing one, then one that must still come back.
    await getStore().put("video", made("gone", { deletedAt: trashedAt(3) }));
    await getStore().put("video", made("stuck", { deletedAt: trashedAt(2) }));
    await getStore().put("video", made("fine", { deletedAt: trashedAt(1) }));
    const store = getStore();
    const get = store.get.bind(store);
    const put = store.put.bind(store);
    store.get = (async (kind: ItemKind, id: string) => (kind === "video" && id === "gone" ? null : get(kind, id))) as typeof store.get;
    store.put = (async (kind: ItemKind, item: Video) => {
      if (kind === "video" && item.id === "stuck") throw new Error("store unavailable");
      return put(kind, item);
    }) as typeof store.put;
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      assert.deepEqual(await restoreAll(OWNER), { done: 1, remaining: 2 });
    } finally {
      console.error = log;
    }
    assert.equal(errors.length, 1, "only the failed write is logged, not the one deleted meanwhile");
    assert.equal((await get("video", "fine") as Video).deletedAt, undefined, "the one after the failure still came back");
  });

  it("writes the record as stored at that moment, keeping a change made since the trash was read", async () => {
    await getStore().put("video", made("t1", { deletedAt: trashedAt(1), folder: "Old", views: 3, shareDisabled: true }));
    const store = getStore();
    const list = store.list.bind(store);
    let changed = false;
    store.list = (async (kind: ItemKind, owner?: string) => {
      const found = await list(kind, owner);
      if (kind === "video" && !changed) {
        changed = true;
        const stored = (await store.get<Video>("video", "t1"))!;
        await store.put("video", { ...stored, folder: "Moved", views: 4 });
      }
      return found;
    }) as typeof store.list;
    assert.deepEqual(await restoreAll(OWNER), { done: 1, remaining: 0 });
    const back = (await store.get<Video>("video", "t1"))!;
    assert.deepEqual([back.deletedAt, back.folder, back.views, back.shareDisabled], [undefined, "Moved", 4, true]);
  });

  it("starts no more restores past its deadline", async () => {
    for (let i = 0; i < 4; i++) await getStore().put("video", made(`t${i}`, { deletedAt: trashedAt(10 - i) }));
    let t = Date.now();
    const store = getStore();
    const put = store.put.bind(store);
    let restored = 0;
    store.put = (async (kind: ItemKind, item: Video) => {
      const r = await put(kind, item);
      if (kind === "video" && !item.deletedAt && ++restored === 2) t += 61_000;
      return r;
    }) as typeof store.put;
    assert.deepEqual(await restoreAll(OWNER, () => t), { done: 2, remaining: 2 });
  });
});
