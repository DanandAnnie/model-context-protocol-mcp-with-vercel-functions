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

  it("asks once about a link that came with the finished render, however recently the video was edited", async () => {
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

  it("falls back to the still picture when the renderer makes no GIF", async () => {
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
      `<a href="https://studio.example/share/vid_1"><img src="https://studio.example/share/vid_1/preview.gif" alt="Watch the video: Tom &amp; &quot;Jerry&quot; &lt;live&gt;" width="270" style="display:block;max-width:100%;height:auto;border:0"></a>`,
    );
    assert.match(emailSnippet({ id: "v", title: "x" }, "https://s").html, /width="480"/);
  });
});
