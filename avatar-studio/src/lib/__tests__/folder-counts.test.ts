// How many videos each folder holds, for the library's folder picker: per view, whatever the other filters.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { countFolders, queryVideos, videoQuerySchema } from "../services";
import type { Video } from "../types";

const OWNER = "user_folder_counts";
const made = (id: string, patch: Partial<Video> = {}) =>
  ({ id, ownerId: OWNER, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch }) as Video;

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("folder counts", () => {
  it("counts each folder, and the unfiled under an empty name", () => {
    assert.deepEqual(countFolders([made("a", { folder: "Launch" }), made("b", { folder: "Launch" }), made("c"), made("d", { folder: "Q4" })]), { Launch: 2, "": 1, Q4: 1 });
    assert.deepEqual(countFolders([]), {});
  });

  it("counts folders named like an object's own properties as plain folders", () => {
    const counts = countFolders([made("a", { folder: "constructor" }), made("b", { folder: "constructor" }), made("c", { folder: "__proto__" }), made("d", { folder: "toString" })]);
    assert.equal(counts.constructor, 2);
    assert.equal(Object.getOwnPropertyDescriptor(counts, "__proto__")?.value, 1);
    assert.equal(counts.toString, 1 as unknown);
    // And they survive the trip to the page as numbers.
    const sent = JSON.parse(JSON.stringify(counts)) as Record<string, unknown>;
    assert.deepEqual(Object.entries(sent).sort(), [["__proto__", 1], ["constructor", 2], ["toString", 1]]);
  });

  it("counts the view shown, whatever the other filters, and the trash on its own", async () => {
    await getStore().put("video", made("a", { folder: "Launch" }));
    await getStore().put("video", made("b", { folder: "Launch", status: "failed" }));
    await getStore().put("video", made("c"));
    await getStore().put("video", made("d", { folder: "Launch", deletedAt: new Date().toISOString() }));
    const library = await queryVideos(OWNER, videoQuerySchema.parse({ status: "failed", q: "b" }));
    assert.equal(library.matched, 1);
    assert.deepEqual(library.folderCounts, { Launch: 2, "": 1 });
    assert.equal(Object.values(library.folderCounts).reduce((x, y) => x + y, 0), library.total, "every folder together is the whole library");
    const trash = await queryVideos(OWNER, videoQuerySchema.parse({ trash: "true" }));
    assert.deepEqual(trash.folderCounts, { Launch: 1 });
  });
});
