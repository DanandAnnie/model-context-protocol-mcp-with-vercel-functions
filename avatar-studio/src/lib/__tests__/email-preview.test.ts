// A shared video's picture for an email: the renderer's animated GIF behind a fixed address, renewed once old, and the
// cover instead where the GIF would give away what the link keeps back.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { createVideo, emailPreview, forgetGifChecks, getVideo, updateVideo, videoPatchSchema, videoRequestSchema } from "../services";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { HeyGenAvatarProvider } from "../providers/avatar/heygen";
import { emailSnippet } from "../client";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Video } from "../types";

const realStatus = MockAvatarProvider.prototype.getStatus;
let asked = 0;

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetGifChecks();
  asked = 0;
  MockAvatarProvider.prototype.getStatus = async function (id: string) {
    asked++;
    return realStatus.call(this, id);
  };
});

afterEach(() => {
  MockAvatarProvider.prototype.getStatus = realStatus;
});

const HOUR = 60 * 60 * 1000;

async function finished(extra: Partial<Video> = {}): Promise<Video> {
  const v = await createVideo(videoRequestSchema.parse({ title: "Open house", script: "Welcome in.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), "u1");
  return getStore().put("video", { ...v, status: "completed" as const, providerJobId: "mock_0_5", videoUrl: "https://cdn.example/v.mp4", thumbnailUrl: "https://cdn.example/v.jpg", ...extra });
}

describe("email preview", () => {
  it("answers a recently asked GIF link without asking the renderer", async () => {
    const v = await finished({ gifUrl: "https://cdn.example/v.gif", gifCheckedAt: new Date().toISOString() });
    assert.deepEqual(await emailPreview(v.id), { url: "https://cdn.example/v.gif", animated: true });
    assert.equal(asked, 0);
  });

  it("asks for a fresh link once the stored one is old, stores it, and asks once however many look", async () => {
    const v = await finished({ gifUrl: "https://cdn.example/old.gif", gifCheckedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
    const [a, b] = await Promise.all([emailPreview(v.id), emailPreview(v.id)]);
    assert.match(a!.url, /\/demo\/preview\.gif$/);
    assert.deepEqual(a, b);
    assert.equal(asked, 1);
    const stored = await getVideo(v.id, "u1", false);
    assert.match(stored.gifUrl!, /\/demo\/preview\.gif$/);
    assert.ok(Date.now() - Date.parse(stored.gifCheckedAt!) < 5_000);
    await emailPreview(v.id);
    assert.equal(asked, 1, "fresh now, so not asked again");
  });

  it("asks a renderer that could not answer again only after a wait, keeping the old link meanwhile", async () => {
    const v = await finished({ gifUrl: "https://cdn.example/old.gif", gifCheckedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
    MockAvatarProvider.prototype.getStatus = async () => {
      asked++;
      throw new Error("renderer down");
    };
    assert.deepEqual(await emailPreview(v.id), { url: "https://cdn.example/old.gif", animated: true });
    assert.deepEqual(await emailPreview(v.id), { url: "https://cdn.example/old.gif", animated: true });
    assert.equal(asked, 1);
    assert.equal((await emailPreview(v.id, Date.now() + 6 * 60 * 1000))?.url, "https://cdn.example/old.gif");
    assert.equal(asked, 2, "asked again once the wait is over");
  });

  it("asks once about a link kept without a check time, however recently the video was edited", async () => {
    const v = await finished({ gifUrl: "https://cdn.example/from-render.gif", updatedAt: new Date().toISOString() });
    assert.match((await emailPreview(v.id))!.url, /\/demo\/preview\.gif$/);
    assert.equal(asked, 1);
  });

  it("fills in the GIF of a video finished before previews were kept", async () => {
    const v = await finished();
    assert.match((await emailPreview(v.id))!.url, /\/demo\/preview\.gif$/);
    assert.equal(asked, 1);
  });

  it("shows the cover, not the footage, when the link asks for an email first, and nothing behind a password", async () => {
    const v = await finished({ gifUrl: "https://cdn.example/v.gif", gifCheckedAt: new Date().toISOString() });
    await updateVideo(v.id, videoPatchSchema.parse({ shareGate: true }), "u1");
    assert.deepEqual(await emailPreview(v.id), { url: "https://cdn.example/v.jpg", animated: false });
    await getStore().put("video", { ...(await getVideo(v.id, "u1", false)), shareGate: undefined, shareLocked: true } as Video);
    assert.equal(await emailPreview(v.id), null);
    assert.equal(asked, 0);
  });

  it("is not found where the share page is not, and empty for an unfinished video", async () => {
    const v = await finished();
    await updateVideo(v.id, videoPatchSchema.parse({ shareDisabled: true }), "u1");
    await assert.rejects(emailPreview(v.id), /not found/);
    const pending = await createVideo(videoRequestSchema.parse({ title: "Draft", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), "u1");
    await getStore().put("video", { ...(await getVideo(pending.id, "u1", false)), status: "processing" as const });
    assert.equal(await emailPreview(pending.id), null);
    await assert.rejects(emailPreview("vid_missing"), /not found/);
  });

  it("stamps a GIF that comes with the finished render, so the first open does not ask again", async () => {
    const v = await createVideo(videoRequestSchema.parse({ title: "Fresh", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), "u1");
    await getStore().put("video", { ...(await getVideo(v.id, "u1", false)), status: "processing" as const, providerJobId: "mock_0_5" });
    const done = await getVideo(v.id, "u1");
    assert.equal(done.status, "completed");
    assert.match(done.gifUrl!, /\/demo\/preview\.gif$/);
    assert.ok(done.gifCheckedAt);
    asked = 0;
    assert.equal((await emailPreview(v.id))?.animated, true);
    assert.equal(asked, 0);
  });

  it("drops a GIF the renderer no longer has, showing the renewed still instead", async () => {
    const v = await finished({ gifUrl: "https://cdn.example/old.gif", gifCheckedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
    MockAvatarProvider.prototype.getStatus = async () => {
      asked++;
      return { status: "completed", videoUrl: "https://cdn.example/v.mp4", thumbnailUrl: "https://cdn.example/new.jpg" };
    };
    assert.deepEqual(await emailPreview(v.id), { url: "https://cdn.example/new.jpg", animated: false });
    const stored = await getVideo(v.id, "u1", false);
    assert.equal(stored.gifUrl, undefined);
    assert.equal(stored.thumbnailUrl, "https://cdn.example/new.jpg");
    assert.deepEqual(await emailPreview(v.id), { url: "https://cdn.example/new.jpg", animated: false });
    assert.equal(asked, 1, "the answer is fresh, so not asked again yet");
  });

  it("renews the still of a link that asks for an email first", async () => {
    const v = await finished({ shareGate: true, gifCheckedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
    assert.deepEqual(await emailPreview(v.id), { url: (await getVideo(v.id, "u1", false)).thumbnailUrl, animated: false });
    assert.match((await getVideo(v.id, "u1", false)).thumbnailUrl!, /\/demo\/poster\.svg$/);
    assert.equal(asked, 1);
  });

  it("gives up on a GIF link not renewed for a day, showing the still", async () => {
    const v = await finished({ gifUrl: "https://cdn.example/old.gif", gifCheckedAt: new Date(Date.now() - 48 * HOUR).toISOString() });
    MockAvatarProvider.prototype.getStatus = async () => {
      asked++;
      throw new Error("renderer down");
    };
    assert.deepEqual(await emailPreview(v.id), { url: "https://cdn.example/v.jpg", animated: false });
  });

  it("carries the share link's expiry, and is not found once it passes or the video is trashed", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const v = await finished({ gifUrl: "https://cdn.example/v.gif", gifCheckedAt: new Date().toISOString(), shareExpiresAt: soon });
    assert.equal((await emailPreview(v.id))?.expiresAt, soon);
    await getStore().put("video", { ...(await getVideo(v.id, "u1", false)), shareExpiresAt: new Date(Date.now() - 1000).toISOString() });
    await assert.rejects(emailPreview(v.id), /not found/);
    const trashed = await finished({ gifUrl: "https://cdn.example/v.gif", gifCheckedAt: new Date().toISOString(), deletedAt: new Date().toISOString() });
    await assert.rejects(emailPreview(trashed.id), /not found/);
  });

  it("falls back to the still picture for a renderer not configured here", async () => {
    const v = await finished({ provider: "did", providerJobId: "talk_1" });
    assert.deepEqual(await emailPreview(v.id), { url: "https://cdn.example/v.jpg", animated: false });
    assert.equal(asked, 0);
  });

  it("reads HeyGen's GIF from a finished render's status and webhook, https only", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const id = String(input).split("/").at(-1);
      return Response.json({ data: { status: "completed", video_url: "https://cdn/v.mp4", gif_url: id === "v_gif" ? "https://cdn/v.gif" : "http://cdn/v.gif" } });
    }) as typeof fetch;
    try {
      const p = new HeyGenAvatarProvider("key");
      assert.equal((await p.getStatus("v_gif")).gifUrl, "https://cdn/v.gif");
      assert.equal("gifUrl" in (await p.getStatus("v_plain")), false);
      assert.equal(p.gifPreviews, true);
      assert.deepEqual(p.parseWebhook({ event_type: "avatar_video.success", event_data: { video_id: "v1", url: "https://cdn/v.mp4", gif_download_url: "https://cdn/v.gif" } }), {
        providerJobId: "v1",
        update: { status: "completed", videoUrl: "https://cdn/v.mp4", gifUrl: "https://cdn/v.gif" },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("email snippet", () => {
  it("links the preview to the share page, sized to the video, with the title escaped", () => {
    const { html, text } = emailSnippet({ id: "vid_1", title: `Tom & "Jerry" <live>`, aspect: "9:16" }, "https://studio.example/");
    assert.equal(text, "https://studio.example/share/vid_1");
    assert.equal(
      html,
      `<a href="https://studio.example/share/vid_1"><img src="https://studio.example/share/vid_1/preview.gif" alt="Watch the video: Tom &amp; &quot;Jerry&quot; &lt;live&gt;" width="270" height="480" style="display:block;max-width:100%;height:auto;border:0"></a>`,
    );
    assert.match(emailSnippet({ id: "v", title: "x" }, "https://s").html, /width="480"/);
  });
});
