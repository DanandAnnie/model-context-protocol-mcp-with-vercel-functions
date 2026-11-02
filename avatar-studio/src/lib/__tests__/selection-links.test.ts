// Share links for any selection of library videos, as a CSV: the link only once a viewer can open it, and a state
// saying why a blank one is blank. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import jsQR from "jsqr";
import { SELECTION_LINK_COLUMNS, createVideo, selectionLinkRows, selectionLinkText, selectionLinksSchema, selectionQrFiles, selectionVideos, videoRequestSchema } from "../services";
import { QR_MARGIN, qrMatrix, qrSvg, qrWording } from "../qr";
import { NotFoundError } from "../errors";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { parseCsv, toCsv } from "../csv";
import type { Video } from "../types";

const OWNER = "user_selection_links";
const day = 86_400_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

async function video(title: string, patch: Partial<Video> = {}): Promise<Video> {
  const v = await createVideo(videoRequestSchema.parse({ title, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Doors open Saturday." }), OWNER);
  return getStore().put("video", { ...v, status: "completed" as const, ...patch });
}

describe("selection links", () => {
  it("gives each chosen video's link only when it can be sent, and says why the others are blank", async () => {
    const open = await video("Open", { folder: "Launch", shareLocked: true, shareExpiresAt: at(3 * day) });
    const off = await video("Off", { shareDisabled: true });
    const later = await video("Later", { shareStartsAt: at(day), shareExpiresAt: at(5 * day) });
    const gone = await video("Gone", { shareExpiresAt: at(-day) });
    const rendering = await video("Rendering", { status: "processing", shareGate: true });
    const rows = selectionLinkRows([open, off, later, gone, rendering], "https://studio.example/");
    assert.deepEqual(rows.map((r) => [r.title, r.share_state, r.share_link]), [
      ["Open", "live", `https://studio.example/share/${open.id}`],
      ["Off", "off", undefined],
      ["Later", "scheduled", undefined],
      ["Gone", "expired", undefined],
      ["Rendering", "not ready", undefined],
    ]);
    assert.equal(rows[0].share_expires, open.shareExpiresAt);
    assert.equal(rows[0].password_required, "yes");
    assert.equal(rows[0].folder, "Launch");
    assert.deepEqual([rows[2].share_goes_live, rows[2].share_expires], [later.shareStartsAt, later.shareExpiresAt], "a scheduled link says when it opens and closes");
    assert.equal(rows[3].share_expires, undefined, "an expired link has nothing coming");
    assert.equal(rows[4].email_required, "yes");
    // How the states rank: a failed render is never sendable, whatever its link says; a link that is off or scheduled
    // says so while the render is under way; times still ahead are given whatever the state.
    const failedLater = await video("Failed later", { status: "failed", shareStartsAt: at(day) });
    const offRendering = await video("Off rendering", { status: "processing", shareDisabled: true, shareExpiresAt: at(2 * day), shareStartsAt: at(day) });
    const ranked = selectionLinkRows([failedLater, offRendering], "https://studio.example");
    assert.deepEqual(ranked.map((r) => r.share_state), ["failed", "off"]);
    assert.deepEqual([ranked[0].share_goes_live, ranked[1].share_goes_live, ranked[1].share_expires], [failedLater.shareStartsAt, offRendering.shareStartsAt, offRendering.shareExpiresAt]);
    const csv = parseCsv(toCsv([...SELECTION_LINK_COLUMNS], rows));
    assert.deepEqual(csv.columns, [...SELECTION_LINK_COLUMNS]);
    assert.equal(csv.rows[0].share_link, `https://studio.example/share/${open.id}`);
  });

  it("keeps the order asked, once each, leaving out other owners', trashed, and unknown videos", async () => {
    const a = await video("A");
    const b = await video("B");
    const trashed = await video("Trashed", { deletedAt: at(-1) });
    const theirs = await createVideo(videoRequestSchema.parse({ title: "Theirs", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Hi." }), "someone_else");
    assert.deepEqual((await selectionVideos([b.id, a.id, b.id, trashed.id, theirs.id, "vid_nosuch"], OWNER)).map((v) => v.id), [b.id, a.id]);
    await assert.rejects(selectionVideos([theirs.id], OWNER), (err: unknown) => err instanceof NotFoundError);
    assert.equal(selectionLinksSchema.safeParse({ ids: [] }).success, false);
    assert.equal(selectionLinksSchema.safeParse({ ids: Array.from({ length: 201 }, (_, i) => `vid_${i}`) }).success, false);
    assert.equal(selectionLinksSchema.safeParse({ ids: Array.from({ length: 200 }, (_, i) => `vid_${i}`) }).success, true);
    assert.equal(selectionLinksSchema.safeParse({ ids: ["x".repeat(81)] }).success, false);
  });

  it("copies only the links that can be sent, one a line in the order chosen, and counts the rest", async () => {
    const first = await video("First");
    const off = await video("Off", { shareDisabled: true });
    const rendering = await video("Rendering", { status: "processing" });
    const second = await video("Second", { shareExpiresAt: at(day) });
    const expired = await video("Expired", { shareExpiresAt: at(-day) });
    const rows = selectionLinkRows([second, off, rendering, expired, first], "https://studio.example.com/");
    assert.deepEqual(selectionLinkText(rows), {
      text: `https://studio.example.com/share/${second.id}\nhttps://studio.example.com/share/${first.id}`,
      links: 2,
      unsendable: 3,
    });
    assert.deepEqual(selectionLinkText(selectionLinkRows([off], "https://x")), { text: "", links: 0, unsendable: 1 });
    assert.deepEqual(selectionLinkText([]), { text: "", links: 0, unsendable: 0 });
  });

  it("draws a QR code of each link that can be sent, as SVG files named after the videos, and counts the rest", async () => {
    const tour = await video("Tour: 12 Elm St");
    const off = await video("Off", { shareDisabled: true });
    const again = await video("tour: 12 elm st");
    const scheduled = await video("Later", { shareStartsAt: at(day) });
    const rows = selectionLinkRows([tour, off, again, scheduled], "https://studio.example.com");
    const { files, links, unsendable } = selectionQrFiles(rows);
    assert.equal(links, 2);
    assert.equal(unsendable, 2);
    // Named after the videos in the order chosen, a second name that only differs in case kept apart.
    assert.deepEqual(files.map((f) => f.name), ["qr-Tour 12 Elm St.svg", "qr-tour 12 elm st (2).svg"]);
    // Each file is the code of that video's link, titled as the video page's download is.
    for (const [file, v] of [[files[0], tour], [files[1], again]] as const) {
      const link = `https://studio.example.com/share/${v.id}`;
      assert.equal(file.svg, qrSvg(link, qrWording("share", v.title).title));
      const matrix = qrMatrix(link);
      const side = matrix.length + 2 * QR_MARGIN;
      const scale = 4;
      const pixels = new Uint8ClampedArray((side * scale) ** 2 * 4).fill(255);
      matrix.forEach((row, y) =>
        row.forEach((dark, x) => {
          if (!dark) return;
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) {
              const i = (((y + QR_MARGIN) * scale + dy) * side * scale + (x + QR_MARGIN) * scale + dx) * 4;
              pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
            }
        }),
      );
      assert.equal(jsQR(pixels, side * scale, side * scale)?.data, link);
    }
    assert.deepEqual(selectionQrFiles(selectionLinkRows([off], "https://x")), { files: [], links: 0, unsendable: 1 });
  });
});
