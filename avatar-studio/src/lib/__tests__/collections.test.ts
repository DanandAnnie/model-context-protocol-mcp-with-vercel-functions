// Shared folders: one public page listing a folder's videos whose own share links can be sent now.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { COLLECTION_MAX_VIDEOS, COLLECTION_NOTE_MAX, COLLECTION_TITLE_MAX, bulkVideos, collectionPage, deleteVideo, emptyTrash, listCollections, recordCollectionView, renameFolder, setCollectionNote, updateCollection, shareFolder, stopSharingFolder, updateVideo } from "../services";
import { NotFoundError, ValidationError } from "../errors";
import type { Video } from "../types";

const owner = "user_collections";
const made = (id: string, patch: Partial<Video> = {}) =>
  ({ id, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", ownerId: owner, folder: "Listings", createdAt: `2026-10-${String(10 + Number(id.replace(/\D/g, "") || 0)).padStart(2, "0")}T00:00:00Z`, updatedAt: "2026-10-01T00:00:00Z", thumbnailUrl: `https://cdn.test/${id}.jpg`, ...patch }) as Video;

describe("shared folders", () => {
  beforeEach(() => {
    globalThis.__avatarStudioStore = new MemoryStore();
  });

  it("shares a folder once, and refuses one with no videos", async () => {
    await getStore().put("video", made("v1"));
    await assert.rejects(shareFolder({ folder: "Empty" }, owner), ValidationError);
    const first = await shareFolder({ folder: "Listings" }, owner);
    assert.equal(first.created, true);
    assert.match(first.collection.id, /^col_[0-9a-f]{20}$/);
    const again = await shareFolder({ folder: " Listings " }, owner);
    assert.equal(again.created, false, "the folder keeps its link");
    assert.equal(again.collection.id, first.collection.id);
    assert.deepEqual((await listCollections(owner)).map((c) => c.folder), ["Listings"]);
    assert.deepEqual(await listCollections("someone_else"), []);
  });

  it("lists only the folder's videos a viewer can open now, newest first, a locked one without its picture", async () => {
    const day = Date.parse("2026-11-01T00:00:00Z");
    for (const v of [
      made("v1"),
      made("v2", { shareLocked: true }),
      made("v3", { status: "processing" }),
      made("v4", { shareDisabled: true }),
      made("v5", { shareExpiresAt: "2026-10-01T00:00:00Z" }),
      made("v6", { shareStartsAt: "2026-12-01T00:00:00Z" }),
      made("v7", { deletedAt: "2026-10-31T00:00:00Z" }),
      made("v8", { folder: "Other" }),
      made("v9", { ownerId: "someone_else" }),
    ])
      await getStore().put("video", v);
    const { collection } = await shareFolder({ folder: "Listings" }, owner);
    const page = await collectionPage(collection.id, day);
    assert.deepEqual(page.videos.map((v) => v.id), ["v2", "v1"]);
    assert.equal(page.total, 2);
    assert.equal(page.videos[0].locked, true);
    assert.equal(page.videos[0].poster, undefined, "a password-protected link shows no picture");
    assert.equal(page.videos[1].poster, "https://cdn.test/v1.jpg");
    await assert.rejects(collectionPage("col_unknown", day), NotFoundError);
  });

  it(`shows at most ${COLLECTION_MAX_VIDEOS} videos and says how many there are`, async () => {
    for (let i = 0; i < COLLECTION_MAX_VIDEOS + 3; i++) await getStore().put("video", made(`m${i}`, { createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() }));
    const { collection } = await shareFolder({ folder: "Listings" }, owner);
    const page = await collectionPage(collection.id);
    assert.equal(page.videos.length, COLLECTION_MAX_VIDEOS);
    assert.equal(page.total, COLLECTION_MAX_VIDEOS + 3);
    assert.equal(page.videos[0].id, `m${COLLECTION_MAX_VIDEOS + 2}`, "newest first");
  });

  it("follows a folder rename, keeps a merged-into folder's own link, and stops when the folder is removed", async () => {
    await getStore().put("video", made("v1"));
    await getStore().put("video", made("v2", { folder: "Homes" }));
    const listings = (await shareFolder({ folder: "Listings" }, owner)).collection;
    await renameFolder({ from: "Listings", to: "For sale" }, owner);
    assert.equal((await collectionPage(listings.id)).collection.folder, "For sale", "same link, new name");
    assert.deepEqual((await collectionPage(listings.id)).videos.map((v) => v.id), ["v1"]);
    const homes = (await shareFolder({ folder: "Homes" }, owner)).collection;
    await renameFolder({ from: "For sale", to: "Homes" }, owner);
    await assert.rejects(collectionPage(listings.id), NotFoundError, "merged into another shared folder: the moving link stops");
    assert.deepEqual((await collectionPage(homes.id)).videos.map((v) => v.id).sort(), ["v1", "v2"]);
    await renameFolder({ from: "Homes", to: "" }, owner);
    await assert.rejects(collectionPage(homes.id), NotFoundError, "a removed folder stops its link");
  });

  it("never publishes another folder's videos through a merge, and dies with an emptied folder", async () => {
    await getStore().put("video", made("v1"));
    await getStore().put("video", made("v2", { folder: "Private" }));
    const listings = (await shareFolder({ folder: "Listings" }, owner)).collection;
    // Merged into a folder that held videos and was never shared: the link stops rather than show that folder.
    await renameFolder({ from: "Listings", to: "Private" }, owner);
    await assert.rejects(collectionPage(listings.id), NotFoundError);
    assert.deepEqual(await listCollections(owner), [], "the merged-into folder is not shared by it");
    // A folder emptied by moving its last video out loses its link at once: a later folder of that name, made with no
    // read of the old link in between, starts unshared.
    await getStore().put("video", made("v3", { folder: "Open house" }));
    const open = (await shareFolder({ folder: "Open house" }, owner)).collection;
    await updateVideo("v3", { folder: "Elsewhere" }, owner);
    await getStore().put("video", made("v4", { folder: "Open house" }));
    await assert.rejects(collectionPage(open.id), NotFoundError, "reusing the name does not revive the old link");
    assert.equal((await shareFolder({ folder: "Open house" }, owner)).created, true);
    // A trashed video keeps its folder's link (a restore brings the folder back), though the page lists none.
    await getStore().put("video", made("v4", { folder: "Open house", deletedAt: new Date().toISOString() }));
    const kept = (await listCollections(owner)).find((c) => c.folder === "Open house")!;
    assert.deepEqual((await collectionPage(kept.id)).videos, []);
  });

  it("drops a folder's link when its last video is deleted for good, and clears a leftover share on a rename's target", async () => {
    await getStore().put("video", made("v1"));
    const listings = (await shareFolder({ folder: "Listings" }, owner)).collection;
    await deleteVideo("v1", owner);
    await deleteVideo("v1", owner, true);
    await getStore().put("video", made("v2"));
    await assert.rejects(collectionPage(listings.id), NotFoundError, "a video deleted for good took the link with it");
    // A plain rename onto a name whose old share was somehow left behind keeps only the link being carried.
    const fresh = (await shareFolder({ folder: "Listings" }, owner)).collection;
    await getStore().put("collection", { ...fresh, id: "col_00000000000000stale", folder: "Sold" });
    await renameFolder({ from: "Listings", to: "Sold" }, owner);
    await assert.rejects(collectionPage("col_00000000000000stale"), NotFoundError);
    assert.equal((await collectionPage(fresh.id)).collection.folder, "Sold");
  });

  it("settles links through bulk moves, emptying the trash, and a video landing in a folder with a leftover link", async () => {
    await getStore().put("video", made("v1"));
    await getStore().put("video", made("v2"));
    const listings = (await shareFolder({ folder: "Listings" }, owner)).collection;
    await bulkVideos({ action: "move", ids: ["v1", "v2"], folder: "Archive" }, owner);
    await getStore().put("video", made("v3"));
    await assert.rejects(collectionPage(listings.id), NotFoundError, "a bulk move of its last videos took the link");
    // Emptying the trash of a shared folder's last video drops the link too.
    const again = (await shareFolder({ folder: "Listings" }, owner)).collection;
    await deleteVideo("v3", owner);
    assert.equal((await collectionPage(again.id)).videos.length, 0, "a trashed video still holds the folder");
    await emptyTrash({ expected: 1 }, owner);
    await getStore().put("video", made("v4"));
    await assert.rejects(collectionPage(again.id), NotFoundError);
    // A share left over from an earlier folder of a name (as if a drop had failed) goes before a video lands there.
    await getStore().put("collection", { id: "col_000000000000leftover", ownerId: owner, folder: "Open house", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
    await updateVideo("v4", { folder: "Open house" }, owner);
    await assert.rejects(collectionPage("col_000000000000leftover"), NotFoundError);
  });

  it("only reads on the public page and the list: a share whose folder is empty is hidden, not deleted", async () => {
    await getStore().put("collection", { id: "col_0000000000000orphan", ownerId: owner, folder: "Gone", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
    assert.deepEqual(await listCollections(owner), []);
    await assert.rejects(collectionPage("col_0000000000000orphan"), NotFoundError);
    assert.ok(await getStore().get("collection", "col_0000000000000orphan"), "the row is left for a write to drop");
  });

  it("stopping a folder stops every link it was given", async () => {
    await getStore().put("video", made("v1"));
    const first = (await shareFolder({ folder: "Listings" }, owner)).collection;
    // Two shares made at once would both be stored.
    await getStore().put("collection", { ...first, id: "col_0000000000000000dupe" });
    await stopSharingFolder(first.id, owner);
    await assert.rejects(collectionPage("col_0000000000000000dupe"), NotFoundError);
  });

  it("stops sharing on the owner's word only", async () => {
    await getStore().put("video", made("v1"));
    const { collection } = await shareFolder({ folder: "Listings" }, owner);
    await assert.rejects(stopSharingFolder(collection.id, "someone_else"), NotFoundError);
    await stopSharingFolder(collection.id, owner);
    await assert.rejects(collectionPage(collection.id), NotFoundError);
    assert.deepEqual(await listCollections(owner), []);
  });

  it("counts opens of the public page, keeps them through a rename, and counts nothing for a dead link", async () => {
    await getStore().put("video", made("v1"));
    const { collection } = await shareFolder({ folder: "Listings" }, owner);
    const at = Date.parse("2026-11-05T09:30:00Z");
    assert.deepEqual(await recordCollectionView(collection.id, () => true, at), { views: 1, counted: true });
    // A visitor still inside the route's window: shown, not counted.
    assert.deepEqual(await recordCollectionView(collection.id, () => false, at + 1000), { views: 1, counted: false });
    // Opens at once are each counted (one write at a time per share).
    await Promise.all([1, 2, 3].map((n) => recordCollectionView(collection.id, () => true, at + n)));
    let [listed] = await listCollections(owner);
    assert.equal(listed.views, 4);
    assert.equal(listed.lastViewedAt, new Date(at + 3).toISOString());
    // A rename carries the counts with the link.
    await renameFolder({ from: "Listings", to: "Sold" }, owner);
    [listed] = await listCollections(owner);
    assert.equal(listed.folder, "Sold");
    assert.equal(listed.views, 4);
    // A view still reading the folder's videos as the link is stopped never brings it back: the stop waits its turn.
    const store = getStore() as MemoryStore;
    const realList = store.list.bind(store);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inView = new Promise<void>((r) => (entered = r));
    store.list = (async (kind: Parameters<typeof realList>[0], ownerId?: string) => {
      if (kind === "video") {
        store.list = realList;
        entered();
        await held;
      }
      return realList(kind, ownerId);
    }) as unknown as typeof store.list;
    const view = recordCollectionView(collection.id, () => true);
    await inView;
    const stop = stopSharingFolder(collection.id, owner);
    // Let the stop read the share and queue its removal behind the view.
    await new Promise((r) => setTimeout(r, 20));
    release();
    assert.equal((await view).views, 5);
    await stop;
    assert.equal(await getStore().get("collection", collection.id), null, "the stopped link stays gone");
    let gateAsked = false;
    await assert.rejects(
      recordCollectionView(collection.id, () => (gateAsked = true)),
      NotFoundError,
    );
    assert.equal(gateAsked, false, "a dead link does not use up a visitor's slot");
  });

  it("does not count an open of a share whose folder holds no video", async () => {
    await getStore().put("video", made("v1"));
    const { collection } = await shareFolder({ folder: "Listings" }, owner);
    // Emptied behind the link's back (a write that drops it would have run in the app).
    await getStore().put("video", made("v1", { folder: "Other" }));
    await assert.rejects(recordCollectionView(collection.id), NotFoundError);
    const stored = await getStore().get<{ views?: number }>("collection", collection.id);
    assert.equal(stored?.views, undefined);
  });

  it("keeps the owner's note for the page: tidied, shown on the page, cleared when empty, and the owner's alone", async () => {
    await getStore().put("video", made("v1"));
    const { collection } = await shareFolder({ folder: "Listings" }, owner);
    const set = await setCollectionNote(collection.id, { note: "  Open house videos  \r\n \r\n\t\r\n\r\nSee you Saturday.  " }, owner);
    assert.equal(set.note, "Open house videos\n\nSee you Saturday.");
    assert.equal((await collectionPage(collection.id)).collection.note, "Open house videos\n\nSee you Saturday.");
    // A view counted between setting the note and renaming the folder is kept, and so is the note.
    await recordCollectionView(collection.id);
    await renameFolder({ from: "Listings", to: "Sold" }, owner);
    const [listed] = await listCollections(owner);
    assert.deepEqual([listed.folder, listed.note, listed.views], ["Sold", "Open house videos\n\nSee you Saturday.", 1]);
    await assert.rejects(setCollectionNote(collection.id, { note: "x".repeat(COLLECTION_NOTE_MAX + 1) }, owner), (err: Error) => err instanceof ValidationError && err.message === `Keep the note to ${COLLECTION_NOTE_MAX} characters`);
    // Spaces around a note of the full length do not count against it.
    assert.equal((await setCollectionNote(collection.id, { note: `  ${"y".repeat(COLLECTION_NOTE_MAX)}  ` }, owner)).note?.length, COLLECTION_NOTE_MAX);
    await assert.rejects(setCollectionNote(collection.id, { note: "Mine now" }, "someone_else"), NotFoundError);
    const cleared = await setCollectionNote(collection.id, { note: "   " }, owner);
    assert.equal("note" in cleared, false);
    assert.equal((await collectionPage(collection.id)).collection.note, undefined);
  });

  it("lists the page's videos in the order chosen, and changes the order and the note apart", async () => {
    for (const v of [made("v1", { title: "Charlie" }), made("v2", { title: "alpha 10" }), made("v3", { title: "Alpha 2" }), made("v4", { title: "charlie" })]) await getStore().put("video", v);
    const { collection } = await shareFolder({ folder: "Listings" }, owner);
    const titles = async () => (await collectionPage(collection.id)).videos.map((v) => v.title);
    assert.deepEqual(await titles(), ["charlie", "Alpha 2", "alpha 10", "Charlie"], "newest first by default");
    await updateCollection(collection.id, { note: "Spring" }, owner);
    let saved = await updateCollection(collection.id, { order: "title" }, owner);
    assert.deepEqual([saved.order, saved.note], ["title", "Spring"], "an order alone leaves the note");
    // Case aside and numbers as numbers; equal titles newest first.
    assert.deepEqual(await titles(), ["Alpha 2", "alpha 10", "charlie", "Charlie"]);
    await updateCollection(collection.id, { order: "oldest" }, owner);
    assert.deepEqual(await titles(), ["Charlie", "alpha 10", "Alpha 2", "charlie"]);
    saved = await updateCollection(collection.id, { order: "newest", note: "" }, owner);
    assert.equal("order" in saved, false, "newest is the default, kept as no order");
    assert.equal("note" in saved, false);
    assert.equal((await listCollections(owner))[0].order, undefined);
    await assert.rejects(updateCollection(collection.id, { order: "random" }, owner), (err: Error) => err instanceof ValidationError && err.message === "The order is newest, oldest, or title");
    await assert.rejects(updateCollection(collection.id, {}, owner), (err: Error) => err instanceof ValidationError && err.message === "Send a title, a note, an order, or a button");
    await assert.rejects(updateCollection(collection.id, { order: "title" }, "someone_else"), NotFoundError);
  });

  it("heads the page with its title, one line, kept apart from the note and order and through a rename", async () => {
    await getStore().put("video", made("v1"));
    const { collection } = await shareFolder({ folder: "Listings" }, owner);
    await updateCollection(collection.id, { note: "Spring", order: "oldest" }, owner);
    const set = await updateCollection(collection.id, { title: "  Spring\r\n listings\t\u0007tour  " }, owner);
    assert.deepEqual([set.title, set.note, set.order], ["Spring listings tour", "Spring", "oldest"], "a title alone leaves the note and order");
    await recordCollectionView(collection.id);
    await renameFolder({ from: "Listings", to: "Sold" }, owner);
    const [listed] = await listCollections(owner);
    assert.deepEqual([listed.folder, listed.title, listed.views], ["Sold", "Spring listings tour", 1]);
    assert.equal((await updateCollection(collection.id, { note: "Summer" }, owner)).title, "Spring listings tour", "a note alone leaves the title");
    await assert.rejects(updateCollection(collection.id, { title: "x".repeat(COLLECTION_TITLE_MAX + 1) }, owner), (err: Error) => err instanceof ValidationError && err.message === `Keep the title to ${COLLECTION_TITLE_MAX} characters`);
    assert.equal((await updateCollection(collection.id, { title: ` ${"t".repeat(COLLECTION_TITLE_MAX)} ` }, owner)).title?.length, COLLECTION_TITLE_MAX);
    await assert.rejects(updateCollection(collection.id, { title: "Mine now" }, "someone_else"), NotFoundError);
    // The limit is on the tidied title: a double space closed up brings 101 characters to 100.
    assert.equal((await updateCollection(collection.id, { title: `${"t".repeat(50)}  ${"u".repeat(49)}` }, owner)).title?.length, COLLECTION_TITLE_MAX);
    // Zero-width spaces, a C1 line break (U+0085), and direction overrides become spaces; a joined emoji keeps its joiner.
    assert.equal((await updateCollection(collection.id, { title: "Open\u200Bhouse\u0085tour \u202Eflip\u202C 👩\u200D👧" }, owner)).title, "Open house tour flip 👩\u200D👧");
    // Nothing visible is no title: the folder's name comes back. The same holds for a note.
    assert.equal("title" in (await updateCollection(collection.id, { title: "\u200B\u2060\uFEFF" }, owner)), false);
    await updateCollection(collection.id, { title: "Spring listings tour" }, owner);
    assert.equal("note" in (await updateCollection(collection.id, { note: "\u200B\n\u200B" }, owner)), false);
    const cleared = await updateCollection(collection.id, { title: " \n " }, owner);
    assert.equal("title" in cleared, false);
    assert.equal((await collectionPage(collection.id)).collection.title, undefined);
  });

  it("puts a button on the page, kept apart from the title, note, and order, and through a rename", async () => {
    await getStore().put("video", made("v1"));
    const { collection } = await shareFolder({ folder: "Listings" }, owner);
    await updateCollection(collection.id, { title: "Spring", note: "Hi", order: "oldest" }, owner);
    const set = await updateCollection(collection.id, { cta: { label: "  Book a showing ", url: " https://example.com/book " } }, owner);
    assert.deepEqual(set.cta, { label: "Book a showing", url: "https://example.com/book" });
    assert.deepEqual([set.title, set.note, set.order], ["Spring", "Hi", "oldest"], "a button alone leaves the rest");
    await renameFolder({ from: "Listings", to: "Sold" }, owner);
    assert.deepEqual((await collectionPage(collection.id)).collection.cta, { label: "Book a showing", url: "https://example.com/book" });
    assert.deepEqual((await updateCollection(collection.id, { note: "Bye" }, owner)).cta?.label, "Book a showing", "a note alone leaves the button");
    for (const [cta, message] of [
      [{ label: "Go", url: "www.example.com" }, "The link must start with http:// or https://"],
      [{ label: "Go", url: "javascript:alert(1)" }, "The link must start with http:// or https://"],
      [{ label: "   ", url: "https://example.com" }, "Give the button some text"],
      [{ label: "x".repeat(41), url: "https://example.com" }, "Keep the button text to 40 characters"],
    ] as const) {
      await assert.rejects(updateCollection(collection.id, { cta }, owner), (err: Error) => err instanceof ValidationError && err.message === message);
    }
    await assert.rejects(updateCollection(collection.id, { cta: null }, "someone_else"), NotFoundError);
    const cleared = await updateCollection(collection.id, { cta: null }, owner);
    assert.equal("cta" in cleared, false);
    assert.equal((await collectionPage(collection.id)).collection.cta, undefined);
  });
});
