// The library ordered by recent comments: the video with the newest note or reply first. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addComment, commentCounts, commentSchema, createVideo, filterVideos, queryVideos, resolveComment, videoQuerySchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const made = (id: string, createdAt: string) =>
  ({ id, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", createdAt, updatedAt: createdAt }) as Video;
const say = (text: string, parentId?: string) => commentSchema.parse({ text, ...(parentId ? { parentId } : {}) });

describe("recent comments order", () => {
  it("puts the video with the newest comment first, then those with none, newest made first", () => {
    const videos = [made("quiet-old", "2026-10-01T00:00:00Z"), made("busy", "2026-10-02T00:00:00Z"), made("quiet-new", "2026-10-05T00:00:00Z"), made("latest", "2026-09-01T00:00:00Z")];
    const lastAt = new Map([
      ["busy", "2026-11-01T10:00:00Z"],
      ["latest", "2026-11-02T10:00:00Z"],
    ]);
    const ids = filterVideos(videos, videoQuerySchema.parse({ sort: "commented" }), undefined, undefined, lastAt).map((v) => v.id);
    assert.deepEqual(ids, ["latest", "busy", "quiet-new", "quiet-old"]);
    // The same moment on two videos falls back to the newest made.
    const tie = new Map([["busy", "2026-11-01T10:00:00Z"], ["latest", "2026-11-01T10:00:00Z"]]);
    assert.deepEqual(filterVideos(videos, videoQuerySchema.parse({ sort: "commented" }), undefined, undefined, tie).map((v) => v.id).slice(0, 2), ["busy", "latest"]);
    // A time that cannot be read counts as no comment; any readable one, the epoch too, comes before the videos with none.
    const odd = new Map([["quiet-old", "1970-01-01T00:00:00.000Z"], ["busy", "not a date"]]);
    assert.deepEqual(filterVideos(videos, videoQuerySchema.parse({ sort: "commented" }), undefined, undefined, odd).map((v) => v.id), ["quiet-old", "quiet-new", "busy", "latest"]);
    assert.throws(() => filterVideos(videos, videoQuerySchema.parse({ sort: "commented" })), /recent comments order needs the comment times/);
    assert.throws(() => videoQuerySchema.parse({ sort: "chatter" }));
  });

  it("counts anyone's note or reply, in any thread, resolved ones too", async () => {
    const owner = "user_solo";
    const make = (title: string) => createVideo(videoRequestSchema.parse({ title, script: "Hello.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), owner);
    const [a, b, c] = [await make("sc alpha"), await make("sc bravo"), await make("sc charlie")];
    const me = { id: owner };
    const note = await addComment(a.id, say("First on a"), owner, me);
    await new Promise((r) => setTimeout(r, 5));
    const onB = await addComment(b.id, say("On b"), owner, me);
    await new Promise((r) => setTimeout(r, 5));
    // A reply on a, later, in a thread then resolved: a has the newest comment.
    const reply = await addComment(a.id, say("Reply on a", note.id), owner, me);
    await resolveComment(a.id, note.id, true, owner, me);
    const { lastAt } = await commentCounts(owner);
    assert.deepEqual(Object.fromEntries(lastAt), { [a.id]: reply.createdAt, [b.id]: onB.createdAt });
    const page = await queryVideos(owner, videoQuerySchema.parse({ sort: "commented" }));
    assert.deepEqual(page.videos.map((v) => v.id), [a.id, b.id, c.id]);
  });
});
