// A personalized batch's links for a mail merge: the CSV row each video was made from, its recipient and status, and
// the share link only once a recipient can open it. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { BATCH_LINK_COLUMNS, batchLinkRows, batchRequestSchema, batchVideos, createBatch, listVideos, retryVideo, selectionLinkText, selectionQrFiles, trashBatch } from "../services";
import { NotFoundError } from "../errors";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { parseCsv, toCsv } from "../csv";
import { qrSvg, qrWording } from "../qr";
import type { Video } from "../types";

const OWNER = "user_batch_links";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const request = (csv: string) => batchRequestSchema.parse({ title: "Open house", scriptTemplate: "Hi {name}, see you at {time}.", csv, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id });

describe("batch links", () => {
  it("keeps each video's CSV row and lists the batch in that order, whatever order the renders started in", async () => {
    const { batchId, videos } = await createBatch(request("name,time\nAmy,9am\nBen,10am\nCara,11am"), OWNER);
    assert.deepEqual(videos.map((v) => [v.batchRow, v.rowLabel]), [[1, "Amy"], [2, "Ben"], [3, "Cara"]]);
    // Stored out of order, the rows still come back in the CSV's.
    const listed = (await batchVideos(batchId, OWNER)).reverse();
    const rows = batchLinkRows(listed, "https://studio.example/");
    assert.deepEqual(rows.map((r) => [r.row, r.recipient]), [[1, "Amy"], [2, "Ben"], [3, "Cara"]]);
    assert.ok(rows.every((r) => r.title?.toString().startsWith("Open house – ") && r.video_id && r.created));
    await assert.rejects(batchVideos(batchId, "someone_else"), (err: unknown) => err instanceof NotFoundError);
    await assert.rejects(batchVideos("batch_nosuch", OWNER), (err: unknown) => err instanceof NotFoundError);
  });

  it("gives a share link only for a ready video whose link is on, and lets a retry stand in for the render it replaced", async () => {
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    const at = (n: number) => new Date(now - n * 1000).toISOString();
    const video = (id: string, extra: Partial<Video>): Video =>
      ({ id, ownerId: OWNER, batchId: "batch_x", title: id, script: "Hi", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", createdAt: at(100), updatedAt: at(100), ...extra }) as Video;
    const rows = batchLinkRows(
      [
        video("ready", { batchRow: 1, rowLabel: "Amy", shareExpiresAt: at(-3600), shareLocked: true, shareGate: true }),
        video("off", { batchRow: 2, rowLabel: "Ben", shareDisabled: true }),
        video("expired", { batchRow: 3, rowLabel: "Cara", shareExpiresAt: at(1) }),
        video("rendering", { batchRow: 4, rowLabel: "Dee", status: "processing" }),
        video("first-try", { batchRow: 5, rowLabel: "Eve", status: "failed", createdAt: at(90) }),
        video("second-try", { batchRow: 5, rowLabel: "Eve", retryOf: "first-try", createdAt: at(80) }),
        // The same failed render retried twice: one line, the ready retry, not two links for one recipient.
        video("third-try", { batchRow: 5, rowLabel: "Eve", status: "failed", retryOf: "first-try", createdAt: at(70) }),
        // A middle retry in the trash (not listed) still leaves one line for its row.
        video("g-first", { batchRow: 6, rowLabel: "Gus", status: "failed", createdAt: at(60) }),
        video("g-third", { batchRow: 6, rowLabel: "Gus", status: "processing", retryOf: "g-second", createdAt: at(40) }),
        video("older", { rowLabel: "Fay", createdAt: at(200) }),
      ],
      "https://studio.example",
      now,
    );
    assert.deepEqual(
      rows.map((r) => [r.video_id, r.share_link ?? ""]),
      [
        ["ready", "https://studio.example/share/ready"],
        ["off", ""],
        ["expired", ""],
        ["rendering", ""],
        ["second-try", "https://studio.example/share/second-try"],
        ["g-third", ""],
        ["older", "https://studio.example/share/older"],
      ],
    );
    assert.equal(rows.at(-1)!.row, undefined, "a video made before rows were kept comes last, with no row");
    // A link that will lapse, or asks for a password or an email first, says so; one that cannot be sent says nothing.
    assert.deepEqual([rows[0].share_expires, rows[0].password_required, rows[0].email_required], [at(-3600), "yes", "yes"]);
    assert.deepEqual([rows[1].share_expires, rows[1].password_required], [undefined, undefined]);
    const csv = parseCsv(toCsv([...BATCH_LINK_COLUMNS], rows));
    assert.deepEqual(csv.columns, [...BATCH_LINK_COLUMNS]);
  });

  it("keeps the row when a failed render of the batch is retried", async () => {
    // Stamped with the same instant as its retry will be, so only the retry link tells them apart.
    const failed: Video = { id: "vid_batch_failed", ownerId: OWNER, batchId: "batch_y", rowLabel: "Gus", batchRow: 7, title: "Open house – Gus", script: "Hi Gus.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, status: "failed", provider: "mock", error: "boom", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Video;
    await getStore().put("video", failed);
    const retried = await retryVideo(failed.id, OWNER);
    await getStore().put("video", { ...(await getStore().get<Video>("video", failed.id))!, createdAt: retried.createdAt });
    assert.deepEqual([retried.batchId, retried.rowLabel, retried.batchRow, retried.retryOf], ["batch_y", "Gus", 7, failed.id]);
    assert.deepEqual(batchLinkRows(await batchVideos("batch_y", OWNER), "https://s").map((r) => r.video_id), [retried.id]);
  });

  it("copies only the links that can be sent, one a line in the CSV's order, and counts the recipients left out", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const v = (id: string, batchRow: number, extra: Partial<Video>) =>
      ({ id, title: `Hi – ${id}`, script: "Hi", avatarId: "a", voiceId: "v", aspect: "16:9", status: "completed", provider: "mock", createdAt: at, updatedAt: at, batchId: "batch_c", batchRow, rowLabel: id, ...extra }) as Video;
    const rows = batchLinkRows([v("c", 3, {}), v("a", 1, {}), v("b", 2, { status: "processing" }), v("d", 4, { shareDisabled: true })], "https://studio.example/");
    assert.deepEqual(selectionLinkText(rows), { text: "https://studio.example/share/a\nhttps://studio.example/share/c", links: 2, unsendable: 2 });
    assert.deepEqual(selectionLinkText([]), { text: "", links: 0, unsendable: 0 });
    // Failed, expired, and not yet live are left out too; a failed row with a ready retry is one recipient, sent the retry.
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const more = batchLinkRows(
      [
        v("e", 1, { status: "failed" }),
        v("f", 2, { shareExpiresAt: "2020-01-01T00:00:00.000Z" }),
        v("g", 3, { shareStartsAt: later }),
        v("h", 4, { status: "failed" }),
        v("h2", 4, { retryOf: "h" }),
      ],
      "https://studio.example",
    );
    assert.deepEqual(selectionLinkText(more), { text: "https://studio.example/share/h2", links: 1, unsendable: 3 });
    // The same links as QR codes, one SVG each, named after the videos.
    const qr = selectionQrFiles(rows);
    assert.deepEqual([qr.files.map((f) => f.name), qr.links, qr.unsendable], [["qr-Hi – a.svg", "qr-Hi – c.svg"], 2, 2]);
    // Each file is the code of that video's own link.
    assert.deepEqual(qr.files.map((f) => f.svg), ["a", "c"].map((id) => qrSvg(`https://studio.example/share/${id}`, qrWording("share", `Hi – ${id}`).title)));
  });

  it("moves every video of a batch to the trash, retries too, and only the owner's", async () => {
    const { batchId, videos } = await createBatch(request("name,time\nAmy,9am\nBen,10am"), OWNER);
    // Ben's render failed and was started again: both are the batch's.
    await getStore().put("video", { ...(await getStore().get<Video>("video", videos[1].id))!, status: "failed" });
    const retry = await retryVideo(videos[1].id, OWNER);
    await assert.rejects(trashBatch(batchId, "someone_else"), (err: unknown) => err instanceof NotFoundError);
    assert.deepEqual(await trashBatch(batchId, OWNER), { moved: 3, failed: 0 });
    const left = await listVideos(OWNER, false);
    assert.ok(![videos[0].id, videos[1].id, retry.id].some((id) => left.some((v) => v.id === id)));
    // Each is in the trash, to be restored from there; nothing is left to move.
    for (const id of [videos[0].id, videos[1].id, retry.id]) assert.ok((await getStore().get<Video>("video", id))?.deletedAt);
    await assert.rejects(trashBatch(batchId, OWNER), (err: unknown) => err instanceof NotFoundError);
    await assert.rejects(trashBatch("batch_nope", OWNER), (err: unknown) => err instanceof NotFoundError);
  });

  it("does not count a video already in the trash, and counts one the store would not take while moving the rest", async () => {
    const { batchId, videos } = await createBatch(request("name,time\nAmy,9am\nBen,10am\nCy,11am"), OWNER);
    // Amy's video was moved to the trash from the library first.
    await getStore().put("video", { ...(await getStore().get<Video>("video", videos[0].id))!, deletedAt: new Date().toISOString() });
    // The store refuses Cy's write once.
    const store = getStore();
    const put = store.put.bind(store);
    let refused = false;
    store.put = (async (kind: string, item: { id: string }) => {
      if (kind === "video" && item.id === videos[2].id && !refused) {
        refused = true;
        throw new Error("store is down");
      }
      return put(kind as never, item as never);
    }) as typeof store.put;
    const putIf = store.putIf?.bind(store);
    if (putIf)
      store.putIf = (async (kind: string, item: { id: string }, ...rest: unknown[]) => {
        if (kind === "video" && item.id === videos[2].id && !refused) {
          refused = true;
          throw new Error("store is down");
        }
        return (putIf as (...a: unknown[]) => unknown)(kind, item, ...rest);
      }) as typeof store.putIf;
    const original = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await trashBatch(batchId, OWNER), { moved: 1, failed: 1 });
    } finally {
      console.error = original;
    }
    assert.ok((await getStore().get<Video>("video", videos[1].id))?.deletedAt);
    assert.equal((await getStore().get<Video>("video", videos[2].id))?.deletedAt, undefined);
    // Asked again, the one left is moved.
    assert.deepEqual(await trashBatch(batchId, OWNER), { moved: 1, failed: 0 });
  });
});
