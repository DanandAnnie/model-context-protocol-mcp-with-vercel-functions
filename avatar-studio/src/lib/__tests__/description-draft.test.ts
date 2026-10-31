// A share-page description drafted from a video's script: POST /api/videos/:id/describe.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_DESCRIPTION, createVideo, describeVideo, draftDescription, getVideo, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const bg = { type: "color" as const, value: "#0f172a" };
const OWNER = "user_describe";

describe("describeVideo", () => {
  it("drafts from the scenes' words, pause markers left out, and saves nothing", async () => {
    const v = await createVideo(
      videoRequestSchema.parse({
        title: "Maple Street",
        avatarId: STOCK_AVATARS[0].id,
        voiceId: STOCK_VOICES[0].id,
        scenes: [
          { script: "Welcome to twelve Maple Street. [pause 2s] It's a bright family home.", background: bg },
          { script: "The kitchen was redone last spring.", background: bg },
          { script: "Call Dana to book a showing this weekend, before it is gone for good.", background: bg },
        ],
      }),
      OWNER,
    );
    const draft = await describeVideo(v.id, OWNER);
    assert.equal(draft, "Welcome to twelve Maple Street. It's a bright family home. The kitchen was redone last spring. Call Dana to book a showing this weekend, before it is gone for good.");
    assert.doesNotMatch(draft, /\[pause/);
    assert.equal((await getVideo(v.id, OWNER, false)).description, undefined, "a draft is not saved");
  });

  it("refuses a video with no words of its own, and one of another account", async () => {
    const silent = await createVideo(
      videoRequestSchema.parse({
        title: "Quiet",
        avatarId: STOCK_AVATARS[0].id,
        voiceId: STOCK_VOICES[0].id,
        scenes: [
          { script: "Hello.", background: bg },
          { script: "[pause 3s]", background: bg },
        ],
      }),
      OWNER,
    );
    const stored = await getVideo(silent.id, OWNER, false);
    globalThis.__avatarStudioStore!.put("video", { ...stored, scenes: stored.scenes!.map((sc) => ({ ...sc, script: "[pause 3s]" })), script: "[pause 3s]\n\n[pause 3s]" });
    await assert.rejects(describeVideo(silent.id, OWNER), /no words to describe/);
    globalThis.__avatarStudioStore!.put("video", { ...stored, cinematic: { prompt: "A slow push in.", avatarIds: [STOCK_AVATARS[0].id] } } as never);
    await assert.rejects(describeVideo(silent.id, OWNER), /no script of its own/);
    await assert.rejects(describeVideo(silent.id, "user_someone_else"), /not found/i);
    globalThis.__avatarStudioStore!.put("video", { ...stored, directed: { prompt: "A tour of the house." } } as never);
    await assert.rejects(describeVideo(silent.id, OWNER), /no script of its own/);
    globalThis.__avatarStudioStore!.put("video", { ...stored, deletedAt: new Date().toISOString() });
    await assert.rejects(describeVideo(silent.id, OWNER), /Restore the video from the trash/);
  });
});

describe("draftDescription", () => {
  it("makes one paragraph without wrapping quotes", () => {
    assert.equal(draftDescription('  "A bright\n\nfamily   home."  '), "A bright family home.");
    assert.equal(draftDescription("“Tour the kitchen.”"), "Tour the kitchen.");
    assert.equal(draftDescription("It's \"new\" here."), 'It\'s "new" here.', "inner quotes stay");
    // Quotes that open and close different phrases, or do not pair, are the description's own.
    assert.equal(draftDescription('"Fresh" paint and a new roof make this a "must-see"'), '"Fresh" paint and a new roof make this a "must-see"');
    assert.equal(draftDescription("'Tis the season at the Smiths'"), "'Tis the season at the Smiths'");
    assert.equal(draftDescription("“Mismatched.\""), "“Mismatched.\"");
    assert.equal(draftDescription('""'), "", "nothing inside");
  });

  it("cuts at a word with an ellipsis, counting the limit as the field does", () => {
    const long = draftDescription(`${"word ".repeat(150)}end`);
    assert.ok(long.length <= MAX_DESCRIPTION);
    assert.match(long, /word…$/);
    // Emoji are two UTF-16 units each: the cut keeps the saved field under its limit and never splits one.
    const emoji = draftDescription("🏡".repeat(400));
    assert.ok(emoji.length <= MAX_DESCRIPTION);
    assert.match(emoji, /^(🏡)+…$/u);
    assert.equal(draftDescription("Short."), "Short.");
  });
});
