// HeyGen Studio templates: the renderer's templates listed and read, their variables filled and checked, rendered as a
// library video that a retry sends again and that is not copied, resized, or saved as a template here.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createTemplate, fillStudioVariables, filledScript, forgetStudioTemplates, getStudioTemplate, listStudioTemplates, renderStudioTemplate, resizeVideo, retryVideo, studioRenderSchema } from "../services";
import { NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { getStore } from "../store";
import type { Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetStudioTemplates();
});

const OPEN_HOUSE = { title: "Harbor Lane invite", variables: { open_time: { type: "text", content: "Saturday at 10" } } };

describe("HeyGen Studio templates", () => {
  it("lists the demo templates and reads one's variables and scenes", async () => {
    assert.equal(providerStatus().studioTemplates, true);
    const list = await listStudioTemplates();
    assert.deepEqual(list.map((t) => t.id), ["demo_open_house", "demo_product_update"]);
    const t = await getStudioTemplate("demo_open_house");
    assert.deepEqual(Object.keys(t.variables), ["agent_name", "address", "open_time", "cover_image", "presenter", "narrator"]);
    assert.equal(t.scenes.length, 2);
    await assert.rejects(getStudioTemplate("nope"), NotFoundError);
    await assert.rejects(getStudioTemplate("../x"), /Unknown template/);
  });

  it("fills the template's own values in, sends every text, and checks what is given", async () => {
    const t = await getStudioTemplate("demo_open_house");
    const filled = await fillStudioVariables(t, { open_time: { type: "text", content: "  Saturday at 10 " } });
    assert.deepEqual(filled.agent_name, { type: "text", content: "Ava" }, "a text left out keeps the template's");
    assert.deepEqual(filled.open_time, { type: "text", content: "Saturday at 10" });
    assert.deepEqual(filled.presenter, { type: "character", avatar_id: "stock_1" });
    await assert.rejects(fillStudioVariables(t, {}), /Fill in "open_time"/, "a text with no default must be given");
    await assert.rejects(fillStudioVariables(t, { ...filled, nickname: { type: "text", content: "x" } }), /no variable "nickname"/);
    await assert.rejects(fillStudioVariables(t, { ...filled, address: { type: "image", asset: { type: "url", url: "https://93.184.216.34/a.png" } } }), /"address" is a text variable, not image/);
    await assert.rejects(fillStudioVariables(t, { ...filled, cover_image: { type: "image", asset: { type: "url", url: "https://127.0.0.1/a.png" } } }), (e: unknown) => e instanceof ValidationError && /public host/.test((e as Error).message));
    await assert.rejects(fillStudioVariables(t, { ...filled, cover_image: { type: "image", asset: { type: "url", url: "http://93.184.216.34/a.png" } } }), /public https link/);
    const own = await fillStudioVariables(t, { ...filled, cover_image: { type: "image", asset: { type: "url", url: "https://93.184.216.34/a.png" }, fit: "cover" } });
    assert.deepEqual(own.cover_image, { type: "image", asset: { type: "url", url: "https://93.184.216.34/a.png" }, fit: "cover" });
    assert.equal(filledScript(t, filled), "Hi, I'm Ava. You're invited to an open house at 12 Harbor Lane.\n\nDoors open Saturday at 10. See you there!");
    // The request takes links only (no asset ids), and ids of letters, digits, - and _.
    assert.equal(studioRenderSchema.safeParse({ title: "x", variables: { cover_image: { type: "image", asset: { type: "asset_id", asset_id: "a1" } } } }).success, false);
    assert.equal(studioRenderSchema.safeParse({ title: "x", variables: { presenter: { type: "character", avatar_id: "../x" } } }).success, false);
  });

  it("renders a template as a library video that a retry sends again, and that is not resized or saved as a template", async () => {
    const video = await renderStudioTemplate("demo_open_house", studioRenderSchema.parse(OPEN_HOUSE), "u1");
    assert.equal(video.status, "processing");
    assert.deepEqual([video.studioTemplate?.id, video.studioTemplate?.name, video.aspect, video.avatarId, video.voiceId, video.avatarName], ["demo_open_house", "Open house invitation", "16:9", "stock_1", "stock_voice_1", "Open house invitation"]);
    assert.match(video.script, /Doors open Saturday at 10/);
    await assert.rejects(resizeVideo(video.id, { aspects: ["9:16"] }, "u1"), /keeps the template's shape/);
    await assert.rejects(createTemplate({ fromVideoId: video.id }, "u1"), /remade from that template/);
    const failed: Video = { ...video, id: "vid_tpl_failed", status: "failed", error: "boom", providerJobId: undefined };
    await getStore().put("video", failed);
    const retried = await retryVideo(failed.id, "u1");
    assert.deepEqual(retried.studioTemplate, video.studioTemplate);
    assert.equal(retried.status, "processing");
    // A template whose product has no default details needs them; the 9:16 template renders 9:16.
    await assert.rejects(renderStudioTemplate("demo_product_update", studioRenderSchema.parse({ title: "Update" }), "u1"), /Fill in "details"/);
    const upd = await renderStudioTemplate("demo_product_update", studioRenderSchema.parse({ title: "Update", variables: { details: { type: "text", content: "Faster search." } } }), "u1");
    assert.deepEqual([upd.aspect, upd.voiceId], ["9:16", "studio-template"]);
  });

  it("asks HeyGen for its templates and renders one with its variables", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.startsWith("https://api.heygen.com/v3/templates?limit=100")) {
        return Response.json(url.includes("token=p2") ? { data: { templates: [{ id: "t2", name: "Second" }], has_more: false } } : { data: { templates: [{ id: "t1", name: "Quarterly Update", thumbnail_url: "https://r.heygen.ai/t1.png", aspect_ratio: "16:9" }], has_more: true, next_token: "p2" } });
      }
      if (url === "https://api.heygen.com/v3/templates/t1" && !init?.method) {
        return Response.json({
          data: {
            id: "t1",
            name: "Quarterly Update",
            aspect_ratio: "16:9",
            variables: {
              headline: { type: "text", content: "Q3 in review" },
              host: { type: "character", avatar_look_id: "look_9", character_type: "avatar" },
              music: { type: "sticker", content: "?" },
            },
            scenes: [{ scene_id: "s1", script: "Welcome to the {{headline}} update.", variables: [{ name: "headline", variable_type: "text" }] }],
          },
        });
      }
      if (url === "https://api.heygen.com/v3/templates/gone") return Response.json({ error: { code: "not_found" } }, { status: 404 });
      if (url === "https://api.heygen.com/v3/templates/t1" && init?.method === "POST") return Response.json({ data: { video_id: "hg_tpl_1" } });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      assert.deepEqual(await listStudioTemplates(), [
        { id: "t1", name: "Quarterly Update", thumbnailUrl: "https://r.heygen.ai/t1.png", aspect: "16:9" },
        { id: "t2", name: "Second" },
      ]);
      const asked = calls.length;
      await listStudioTemplates();
      assert.equal(calls.length, asked, "the listing is reused for a while");
      const t = await getStudioTemplate("t1");
      assert.deepEqual(t.variables, { headline: { type: "text", content: "Q3 in review" }, host: { type: "character", avatar_id: "look_9" } }, "unknown types are left out, old field names read");
      await assert.rejects(getStudioTemplate("gone"), NotFoundError);
      const video = await renderStudioTemplate("t1", studioRenderSchema.parse({ title: "Q3", captions: true, variables: { headline: { type: "text", content: "Q4 plans" } } }), "u1");
      const post = calls.find((c) => c.method === "POST")!;
      assert.deepEqual(post.body, { variables: { headline: { type: "text", content: "Q4 plans" }, host: { type: "character", avatar_id: "look_9" } }, title: "Q3", caption: true });
      assert.deepEqual([video.providerJobId, video.status, video.script], ["hg_tpl_1", "processing", "Welcome to the Q4 plans update."]);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("is not offered by a renderer without it", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().studioTemplates, false);
      assert.deepEqual(await listStudioTemplates(), []);
      await assert.rejects(getStudioTemplate("demo_open_house"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
