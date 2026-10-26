// "Make other sizes": a video rendered again in other aspect ratios, each a new video with the same scenes and
// settings, titled with its shape, in the same folder, recording where it came from; the allowance covers all or none.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createVideo, deleteVideo, getVideo, rendersThisMonth, resizeSchema, resizeVideo, updateVideo, videoRequestSchema } from "../services";
import { ConflictError, LimitError, ValidationError } from "../errors";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const bg = { type: "color" as const, value: "#0f172a" };
const source = () =>
  videoRequestSchema.parse({
    title: "Open house tour",
    avatarId: STOCK_AVATARS[0].id,
    voiceId: STOCK_VOICES[0].id,
    aspect: "16:9",
    resolution: "720p",
    captions: true,
    captionStyle: { position: "top", size: "large" },
    speed: 1.1,
    scenes: [
      { script: "Welcome to twelve Maple Street.", background: bg, overlay: { text: "12 Maple Street", position: "bottom" }, layout: { scale: 1.2, x: 0.3, y: 0 } },
      { script: "Call Dana to book a showing.", background: { type: "image", value: "https://example.com/slide.png", fit: "contain" } },
    ],
  });

describe("other sizes", () => {
  it("makes each chosen shape as a new video with everything else the same", async () => {
    const original = await createVideo(source(), "agent");
    await updateVideo(original.id, { folder: "Listings" }, "agent");
    const made = await resizeVideo(original.id, resizeSchema.parse({ aspects: ["9:16", "1:1", "9:16"] }), "agent");
    assert.deepEqual(made.map((v) => [v.aspect, v.title]), [["9:16", "Open house tour (9:16)"], ["1:1", "Open house tour (1:1)"]]);
    for (const v of made) {
      const stored = await getVideo(v.id, "agent");
      assert.equal(stored.resizedFrom, original.id);
      assert.equal(stored.folder, "Listings");
      assert.deepEqual(stored.scenes?.map((sc) => [sc.script, sc.overlay, sc.layout, sc.background]), original.scenes?.map((sc) => [sc.script, sc.overlay, sc.layout, sc.background]));
      assert.deepEqual([stored.resolution, stored.captions, stored.captionStyle, stored.speed, stored.voiceId], [original.resolution, original.captions, original.captionStyle, original.speed, original.voiceId]);
    }
    // A long title keeps its shape within the 120 characters a title holds.
    const long = await createVideo({ ...source(), title: "T".repeat(120) }, "agent");
    const [square] = await resizeVideo(long.id, { aspects: ["1:1"] }, "agent");
    assert.equal(square.title.length, 120);
    assert.ok(square.title.endsWith(" (1:1)"));
  });

  it("refuses its own shape, a trashed video, someone else's, and more sizes than the allowance has left", async () => {
    const original = await createVideo(source(), "agent");
    await assert.rejects(resizeVideo(original.id, { aspects: ["16:9"] }, "agent"), ValidationError);
    assert.throws(() => resizeSchema.parse({ aspects: [] }), /at least one size/);
    assert.throws(() => resizeSchema.parse({ aspects: ["4:3"] }));
    await assert.rejects(resizeVideo(original.id, { aspects: ["9:16"] }, "someone-else"));

    const { config } = await import("../config");
    const limit = config.renderLimitPerMonth;
    (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = 2;
    try {
      // One render used, one left: two sizes are refused before either starts.
      await assert.rejects(resizeVideo(original.id, { aspects: ["9:16", "1:1"] }, "agent"), (e: unknown) => e instanceof LimitError && /2 sizes \(1 of 2 used\)/.test((e as Error).message));
      assert.equal(await rendersThisMonth("agent"), 1);
      assert.equal((await resizeVideo(original.id, { aspects: ["1:1"] }, "agent")).length, 1);
    } finally {
      (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = limit;
    }

    await deleteVideo(original.id, "agent");
    await assert.rejects(resizeVideo(original.id, { aspects: ["9:16"] }, "agent"), ConflictError);
  });
});
