// oEmbed answers for share links: GET /api/oembed.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { embedSize, oembedFor, shareLinkTarget, sizeLimit } from "../oembed";

const BASE = "https://studio.example.com";

describe("embedSize", () => {
  it("sizes each frame shape as the Embed snippet does, scaled down to the consumer's limits", () => {
    assert.deepEqual(embedSize("16:9"), { width: 640, height: 360 });
    assert.deepEqual(embedSize("9:16"), { width: 360, height: 640 });
    assert.deepEqual(embedSize("1:1"), { width: 480, height: 480 });
    assert.deepEqual(embedSize("16:9", 320), { width: 320, height: 180 });
    assert.deepEqual(embedSize("9:16", undefined, 320), { width: 180, height: 320 });
    assert.deepEqual(embedSize("16:9", 500, 100), { width: 177, height: 100 }, "the tighter limit wins");
    assert.deepEqual(embedSize("16:9", 2000, 2000), { width: 640, height: 360 }, "never scaled up");
    assert.deepEqual(embedSize("16:9", 1), { width: 1, height: 1 });
  });
});

describe("sizeLimit", () => {
  it("reads whole numbers of pixels and ignores anything else", () => {
    assert.equal(sizeLimit("480"), 480);
    assert.equal(sizeLimit(" 320 "), 320);
    for (const raw of [null, "", "0", "-5", "12.5", "1e3", "wide", "999999"]) assert.equal(sizeLimit(raw), undefined, String(raw));
  });
});

describe("shareLinkTarget", () => {
  it("names the video of a share link on this studio, with its start time", () => {
    assert.deepEqual(shareLinkTarget(`${BASE}/share/vid_1`, [BASE]), { id: "vid_1" });
    assert.deepEqual(shareLinkTarget(`${BASE}/share/vid_1/?t=1m5s`, [BASE]), { id: "vid_1", start: 65 });
    assert.deepEqual(shareLinkTarget(`${BASE}/share/vid_1?autoplay=1&t=12.4`, ["http://localhost:3000", BASE]), { id: "vid_1", start: 12.4 });
    assert.deepEqual(shareLinkTarget(`${BASE}/share/vid_1?t=soon`, [BASE]), { id: "vid_1" }, "not a time");
    assert.deepEqual(shareLinkTarget(`${BASE}/share/vid_1?t=5&t=6`, [BASE]), { id: "vid_1" }, "a time given twice");
  });

  it("refuses another site's links, other pages, and what is not a link", () => {
    for (const raw of [
      "https://evil.example.com/share/vid_1",
      "http://studio.example.com/share/vid_1",
      `${BASE}:8443/share/vid_1`,
      `${BASE}/videos/vid_1`,
      `${BASE}/share/vid_1/extra`,
      `${BASE}/share/`,
      `${BASE}/share/%E0%A4%A`,
      "javascript:alert(1)",
      "not a link",
    ]) {
      assert.equal(shareLinkTarget(raw, [BASE]), null, raw);
    }
    assert.equal(shareLinkTarget(`${BASE}/share/vid_1`, ["not an origin"]), null);
  });
});

describe("oembedFor", () => {
  const video = { id: "vid_1", title: 'Tour "Maple" & <more>', aspect: "16:9" as const, resolution: "720p" as const, thumbnailUrl: "https://cdn.example.com/thumb.jpg" };

  it("answers with the embed player, escaped, and the renderer's frame at the video's size", () => {
    const answer = oembedFor(video, { base: BASE, siteName: "Maple Realty", maxWidth: 320 });
    assert.equal(answer.version, "1.0");
    assert.equal(answer.type, "video");
    assert.equal(answer.title, 'Tour "Maple" & <more>');
    assert.equal(answer.provider_name, "Maple Realty");
    assert.equal(answer.provider_url, BASE);
    assert.equal(answer.width, 320);
    assert.equal(answer.height, 180);
    assert.equal(
      answer.html,
      `<iframe src="${BASE}/share/vid_1?embed=1" width="320" height="180" style="border:0;max-width:100%" allow="fullscreen; picture-in-picture" allowfullscreen title="Tour &quot;Maple&quot; &amp; &lt;more&gt;"></iframe>`,
    );
    // A 1280-pixel frame is wider than the 320 asked for, so it is left out, as the spec asks.
    assert.equal(answer.thumbnail_url, undefined);
    const full = oembedFor(video, { base: BASE, siteName: "Maple Realty" });
    assert.equal(full.thumbnail_url, "https://cdn.example.com/thumb.jpg");
    assert.equal(full.thumbnail_width, 1280);
    assert.equal(full.thumbnail_height, 720);
    assert.equal(oembedFor(video, { base: BASE, siteName: "Studio", maxWidth: 1280, maxHeight: 720 }).thumbnail_width, 1280, "a frame that fits exactly");
    assert.equal(oembedFor(video, { base: BASE, siteName: "Studio", maxHeight: 719 }).thumbnail_url, undefined);
  });

  it("starts the player at the link's time and prefers a custom cover, at the cover's own size", () => {
    const answer = oembedFor({ ...video, cover: { updatedAt: "2026-10-01T00:00:00.000Z", width: 800, height: 600 } }, { base: BASE, siteName: "Studio", start: 65 });
    assert.match(String(answer.html), /src="https:\/\/studio\.example\.com\/share\/vid_1\?embed=1&amp;t=65"/);
    assert.equal(answer.thumbnail_url, `${BASE}/api/videos/vid_1/cover?v=${Date.parse("2026-10-01T00:00:00.000Z")}`);
    assert.equal(answer.thumbnail_width, 800);
    assert.equal(answer.thumbnail_height, 600);
    // A cover kept before its size was read gives no thumbnail, not the renderer's frame the owner replaced.
    const older = oembedFor({ ...video, cover: { updatedAt: "2026-10-01T00:00:00.000Z" } }, { base: BASE, siteName: "Studio" });
    assert.equal(older.thumbnail_url, undefined);
    assert.equal(older.thumbnail_width, undefined);
  });

  it("carries no thumbnail behind a password, and none when there is no picture", () => {
    const locked = oembedFor({ ...video, shareLocked: true }, { base: BASE, siteName: "Studio" });
    assert.equal(locked.thumbnail_url, undefined);
    assert.equal(locked.thumbnail_width, undefined);
    assert.match(String(locked.html), /<iframe /, "the embed still asks for the password itself");
    const bare = oembedFor({ ...video, thumbnailUrl: undefined }, { base: BASE, siteName: "Studio" });
    assert.equal(bare.thumbnail_url, undefined);
    assert.equal(bare.thumbnail_height, undefined);
  });
});
