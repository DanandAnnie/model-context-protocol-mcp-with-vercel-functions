// Share player track ids: one per subtitle language a video can carry.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shareTrackId } from "../share-player";
import { addSubtitles, createVideo, transcriptsFor, videoRequestSchema } from "../services";
import { MemoryStore } from "../store/memory";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

describe("share player track ids", () => {
  it("gives every language its own id, whatever its script or punctuation, with no whitespace", () => {
    const names = ["日本語", "Русский", "中文", "Ελληνικά", "Español", "Portuguese Brazil", "Portuguese-Brazil", "Portuguese (Brazil)", "Portuguese - (Brazil)"];
    const ids = names.map(shareTrackId);
    assert.equal(new Set(ids).size, names.length, ids.join(" "));
    for (const id of ids) assert.doesNotMatch(id, /\s/, id);
    assert.equal(shareTrackId("Spanish"), shareTrackId("Spanish"), "stable for the same name");
  });

  it("lists the script's transcript first, then each subtitle language in the order the player offers them", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const v = await createVideo(videoRequestSchema.parse({ title: "T", script: "Hello there. Welcome in.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }));
    await addSubtitles(v.id, "日本語");
    const done = await addSubtitles(v.id, "Русский");
    const sets = transcriptsFor(done);
    assert.deepEqual(sets.map((s) => s.language), [undefined, ...Object.keys(done.subtitles ?? {})]);
    assert.ok(sets.every((s) => s.cues.length > 0 && s.cues.every((c) => c.endMs > c.startMs)));
  });
});
