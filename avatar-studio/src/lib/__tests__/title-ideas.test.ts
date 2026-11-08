// Titles suggested from a video's script: POST /api/videos/:id/titles.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_TITLE, TITLE_SUGGESTIONS, createVideo, getVideo, suggestTitles, titleSuggestions, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const bg = { type: "color" as const, value: "#0f172a" };
const OWNER = "user_titles";

function video(scripts: string[], title = "Untitled video") {
  return createVideo(
    videoRequestSchema.parse({ title, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes: scripts.map((script) => ({ script, background: bg })) }),
    OWNER,
  );
}

describe("suggestTitles", () => {
  it("suggests from the scenes' words, pause markers left out, and renames nothing", async () => {
    const v = await video([
      "Welcome to twelve Maple Street. [pause 2s] It's a bright family home with a garden that gets the sun all afternoon long.",
      "The kitchen was redone last spring.",
    ]);
    const titles = await suggestTitles(v.id, OWNER);
    // The demo writer offers the first three sentences, cut at a word to 60 characters.
    assert.deepEqual(titles, ["Welcome to twelve Maple Street", "It's a bright family home with a garden that gets the sun…", "The kitchen was redone last spring"]);
    assert.ok(titles.every((t) => !t.includes("[pause")));
    assert.equal((await getVideo(v.id, OWNER, false)).title, "Untitled video", "nothing is saved");
  });

  it("leaves out the title the video already has", async () => {
    const v = await video(["Welcome to twelve Maple Street. Book a showing."], "Welcome to twelve maple street");
    assert.deepEqual(await suggestTitles(v.id, OWNER), ["Book a showing"]);
  });

  it("refuses a video with no words of its own, a trashed one, and one of another account", async () => {
    const v = await video(["Hello.", "[pause 3s]"]);
    const stored = await getVideo(v.id, OWNER, false);
    globalThis.__avatarStudioStore!.put("video", { ...stored, scenes: stored.scenes!.map((sc) => ({ ...sc, script: "[pause 3s]" })), script: "[pause 3s]\n\n[pause 3s]" });
    await assert.rejects(suggestTitles(v.id, OWNER), /no words to title/);
    globalThis.__avatarStudioStore!.put("video", { ...stored, directed: { prompt: "A tour of the house." } } as never);
    await assert.rejects(suggestTitles(v.id, OWNER), /no script of its own to title/);
    await assert.rejects(suggestTitles(v.id, "user_someone_else"), /not found/i);
    globalThis.__avatarStudioStore!.put("video", { ...stored, deletedAt: new Date().toISOString() });
    await assert.rejects(suggestTitles(v.id, OWNER), /Restore the video from the trash/);
  });
});

describe("titleSuggestions", () => {
  it("takes off list marks, wrapping quotes or bold, and a closing full stop", () => {
    assert.deepEqual(titleSuggestions(["1. Tour Maple Street.", "- “A kitchen redone last spring”", "**Why buy on Maple Street?**"]), [
      "Tour Maple Street",
      "A kitchen redone last spring",
      "Why buy on Maple Street?",
    ]);
    assert.deepEqual(titleSuggestions(["2) Wait for it...", "• Big news!", "#  Open house"]), ["Wait for it...", "Big news!", "Open house"]);
    // A number that starts the title itself is kept; so are quotes that are the title's own.
    assert.deepEqual(titleSuggestions(["3 rooms, 1 garden", "'Tis the season at the Smiths'", 'The "must-see" home']), ["3 rooms, 1 garden", "'Tis the season at the Smiths'", 'The "must-see" home']);
  });

  it("takes the marks off in any nesting and keeps an abbreviation's stop", () => {
    assert.deepEqual(titleSuggestions(["**1. Tour Maple Street**", "1) **The kitchen**.", '"Book a showing".']), ["Tour Maple Street", "The kitchen", "Book a showing"]);
    assert.deepEqual(titleSuggestions(["Welcome to the U.S.", "Ends with a stop."]), ["Welcome to the U.S.", "Ends with a stop"]);
  });

  it("leaves out a line introducing the list, and the current title however it is written", () => {
    assert.deepEqual(titleSuggestions(["Here are three titles:", "Open house", "Tour Maple Street"], "Open house."), ["Tour Maple Street"]);
    assert.deepEqual(titleSuggestions(["Why move: a guide"]), ["Why move: a guide"], "a colon inside a title is its own");
  });

  it("skips blanks, repeats in any case, and the current title, and keeps at most three", () => {
    assert.deepEqual(titleSuggestions(["", "Open house", "  ", "OPEN HOUSE.", "Maple Street", "Tour it", "Book it", "Fifth"], "maple street"), ["Open house", "Tour it", "Book it"]);
    assert.equal(titleSuggestions(["a", "b", "c", "d"]).length, TITLE_SUGGESTIONS);
    assert.deepEqual(titleSuggestions(["   ", "-", '""']), []);
  });

  it("makes each one line cut at a word to fit the title's limit", () => {
    assert.deepEqual(titleSuggestions(["A bright\tfamily   home"]), ["A bright family home"]);
    const [long] = titleSuggestions([`${"word ".repeat(40)}end`]);
    assert.ok(long.length <= MAX_TITLE);
    assert.match(long, /word…$/);
    const [emoji] = titleSuggestions(["🏡".repeat(100)]);
    assert.ok(emoji.length <= MAX_TITLE);
    assert.match(emoji, /^(🏡)+…$/u);
  });
});
