// "Make other sizes": a video rendered again in other aspect ratios, each a new video with the same scenes and
// settings, titled with its shape, in the same folder, recording where it came from; the allowance covers all or none.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createVideo, deleteVideo, getVideo, rendersThisMonth, resizeSchema, resizeVideo, updateVideo, videoRequestSchema, videoSizes } from "../services";
import { ConflictError, LimitError, ValidationError } from "../errors";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { getStore } from "../store";

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
    const { videos: made, failed } = await resizeVideo(original.id, resizeSchema.parse({ aspects: ["9:16", "1:1", "9:16"] }), "agent");
    assert.deepEqual(failed, []);
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
    const [square] = (await resizeVideo(long.id, { aspects: ["1:1"] }, "agent")).videos;
    assert.equal(square.title.length, 120);
    assert.ok(square.title.endsWith(" (1:1)"));
    // An emoji where the title is cut is kept whole or left out, never split.
    const emoji = await createVideo({ ...source(), title: `${"A".repeat(112)}😀 tail` }, "agent");
    const [cut] = (await resizeVideo(emoji.id, { aspects: ["1:1"] }, "agent")).videos;
    assert.equal(cut.title, `${"A".repeat(112)}😀 (1:1)`);
    assert.equal(cut.title.isWellFormed(), true);
    // A size the video already has is never made again, from the original or from a size of it.
    await assert.rejects(resizeVideo(original.id, { aspects: ["9:16", "1:1"] }, "agent"), /already has those sizes/);
    await assert.rejects(resizeVideo(made[0].id, { aspects: ["16:9"] }, "agent"), /already has a 16:9 size/);
    assert.deepEqual((await videoSizes(made[1].id, "agent")).map((v) => [v.id, v.aspect]), [[original.id, "16:9"], [made[0].id, "9:16"], [made[1].id, "1:1"]]);
    // A size made from a size is titled and linked from the original; a trashed size can be made again.
    const second = await createVideo(source(), "agent");
    const [portrait] = (await resizeVideo(second.id, { aspects: ["9:16"] }, "agent")).videos;
    const [fromPortrait] = (await resizeVideo(portrait.id, { aspects: ["1:1"] }, "agent")).videos;
    assert.equal(fromPortrait.title, "Open house tour (1:1)");
    assert.equal(fromPortrait.resizedFrom, second.id);
    await deleteVideo(fromPortrait.id, "agent");
    assert.equal((await resizeVideo(second.id, { aspects: ["1:1"] }, "agent")).videos.length, 1);
    // A title of flags (two code units each) keeps within the 120 the request schema counts.
    const flags = await createVideo({ ...source(), title: `Tour ${"🇬🇧".repeat(57)}!` }, "agent");
    const [flagged] = (await resizeVideo(flags.id, { aspects: ["1:1"] }, "agent")).videos;
    assert.ok(flagged.title.length <= 120 && flagged.title.endsWith(" (1:1)") && flagged.title.isWellFormed());
    assert.doesNotThrow(() => videoRequestSchema.parse({ ...source(), title: flagged.title }));
  });

  it("keeps the corrected captions and subtitle languages, and a retried size keeps its link", async () => {
    const original = await createVideo(source(), "agent");
    const { saveCaptionCues, addSubtitles, retryVideo } = await import("../services");
    await saveCaptionCues(original.id, { cues: [{ startMs: 0, endMs: 3000, text: "Welcome to 12 Maple Street." }, { startMs: 3000, endMs: 6000, text: "Call Dana to book a showing." }] }, "agent");
    await addSubtitles(original.id, "Spanish", "agent");
    const withExtras = await getVideo(original.id, "agent");
    assert.ok(withExtras.subtitles?.Spanish && withExtras.captionCues?.length);
    const [copy] = (await resizeVideo(original.id, { aspects: ["9:16"] }, "agent")).videos;
    const stored = await getVideo(copy.id, "agent");
    assert.deepEqual(stored.captionCues, withExtras.captionCues);
    assert.deepEqual(stored.subtitles, withExtras.subtitles);
    // A size that failed to start, retried, still points at the original.
    await getStore().put("video", { ...stored, status: "failed", error: "provider down" });
    const retried = await retryVideo(copy.id, "agent");
    assert.equal(retried.resizedFrom, original.id);
  });

  it("makes again a size that could not start, and never the shape of an original in the trash", async () => {
    const original = await createVideo(source(), "agent");
    const [portrait] = (await resizeVideo(original.id, { aspects: ["9:16"] }, "agent")).videos;
    // The renderer refused to start it: it used no render, holds nothing, and its shape is offered again.
    await getStore().put("video", { ...(await getVideo(portrait.id, "agent")), status: "failed", error: "provider down" });
    assert.equal((await videoSizes(original.id, "agent")).find((v) => v.id === portrait.id)?.status, "failed", "listed, marked failed");
    const [again] = (await resizeVideo(original.id, { aspects: ["9:16"] }, "agent")).videos;
    assert.equal(again.aspect, "9:16");
    await assert.rejects(resizeVideo(original.id, { aspects: ["9:16"] }, "agent"), /already has a 9:16 size/);
    // An original in the trash can be restored, so a size of it never makes the original's shape a second time.
    await deleteVideo(original.id, "agent");
    assert.deepEqual((await videoSizes(again.id, "agent")).map((v) => v.id), [portrait.id, again.id]);
    await assert.rejects(resizeVideo(again.id, { aspects: ["16:9"] }, "agent"), /already has a 16:9 size/);
    // A title that is one character longer than the room (a letter and a run of combining marks) is cut, not emptied.
    const marks = await createVideo({ ...source(), title: `e${"\u0301".repeat(118)}` }, "agent");
    const [square] = (await resizeVideo(marks.id, { aspects: ["1:1"] }, "agent")).videos;
    assert.ok(square.title.startsWith("e\u0301") && square.title.endsWith(" (1:1)") && square.title.length <= 120);
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
      assert.equal((await resizeVideo(original.id, { aspects: ["1:1"] }, "agent")).videos.length, 1);
    } finally {
      (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = limit;
    }

    await deleteVideo(original.id, "agent");
    await assert.rejects(resizeVideo(original.id, { aspects: ["9:16"] }, "agent"), ConflictError);
  });
});
