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
    assert.equal("presenter" in filled, false, "a presenter, voice, or picture not given is left out, so the template keeps its own");
    assert.equal("cover_image" in filled, false);
    await assert.rejects(fillStudioVariables(t, {}), /Fill in "open_time"/, "a text with no default must be given");
    await assert.rejects(fillStudioVariables(t, { ...filled, nickname: { type: "text", content: "x" } }), /no variable "nickname"/);
    await assert.rejects(fillStudioVariables(t, { ...filled, address: { type: "image", asset: { type: "url", url: "https://93.184.216.34/a.png" } } }), /"address" is a text variable, not image/);
    await assert.rejects(fillStudioVariables(t, { ...filled, cover_image: { type: "image", asset: { type: "url", url: "https://127.0.0.1/a.png" } } }), (e: unknown) => e instanceof ValidationError && /public host/.test((e as Error).message));
    await assert.rejects(fillStudioVariables(t, { ...filled, cover_image: { type: "image", asset: { type: "url", url: "http://93.184.216.34/a.png" } } }), /public https link/);
    const own = await fillStudioVariables(t, { ...filled, cover_image: { type: "image", asset: { type: "url", url: "https://93.184.216.34/a.png" } } });
    assert.deepEqual(own.cover_image, { type: "image", asset: { type: "url", url: "https://93.184.216.34/a.png" }, fit: "cover" }, "a new picture keeps the template's fit");
    // A presenter or voice given must be the template's own or one the account may use.
    const choices = async () => ({ avatarIds: new Set(["stock_2"]), voiceIds: new Set(["stock_voice_2"]) });
    assert.deepEqual((await fillStudioVariables(t, { ...filled, presenter: { type: "character", avatar_id: "stock_2" } }, choices)).presenter, { type: "character", avatar_id: "stock_2" });
    await assert.rejects(fillStudioVariables(t, { ...filled, presenter: { type: "character", avatar_id: "someone_elses_look" } }, choices), /presenter that is not available/);
    await assert.rejects(fillStudioVariables(t, { ...filled, narrator: { type: "voice", voice_id: "voice_x" } }, choices), /voice that is not available/);
    assert.ok(await fillStudioVariables(t, { ...filled, presenter: { type: "character", avatar_id: "stock_1" } }, choices), "the template's own is always allowed");
    assert.equal(filledScript(t, { ...t.variables, ...filled }), "Hi, I'm Ava. You're invited to an open house at 12 Harbor Lane.\n\nDoors open Saturday at 10. See you there!");
    // The request takes links only (no asset ids), and ids of letters, digits, - and _.
    assert.equal(studioRenderSchema.safeParse({ title: "x", variables: { cover_image: { type: "image", asset: { type: "asset_id", asset_id: "a1" } } } }).success, false);
    assert.equal(studioRenderSchema.safeParse({ title: "x", variables: { presenter: { type: "character", avatar_id: "../x" } } }).success, false);
  });

  it("renders a template as a library video that a retry sends again, and that is not resized or saved as a template", async () => {
    const video = await renderStudioTemplate("demo_open_house", studioRenderSchema.parse(OPEN_HOUSE), "u1");
    assert.equal(video.status, "processing");
    assert.deepEqual([video.studioTemplate?.id, video.studioTemplate?.name, video.aspect, video.avatarId, video.voiceId, video.avatarName], ["demo_open_house", "Open house invitation", "16:9", "stock_1", "stock_voice_1", "Open house invitation"]);
    assert.match(video.script, /Doors open Saturday at 10/);
    assert.deepEqual(Object.keys(video.studioTemplate!.variables).sort(), ["address", "agent_name", "open_time"], "every text, and only what was given besides");
    await assert.rejects(resizeVideo(video.id, { aspects: ["9:16"] }, "u1"), /keeps the template's shape/);
    // Another presenter must be one the account sees; the template's own presenter stays the label otherwise.
    const other = await renderStudioTemplate("demo_open_house", studioRenderSchema.parse({ ...OPEN_HOUSE, variables: { ...OPEN_HOUSE.variables, presenter: { type: "character", avatar_id: "stock_2" } } }), "u1");
    assert.equal(other.avatarId, "stock_2");
    await assert.rejects(renderStudioTemplate("demo_open_house", studioRenderSchema.parse({ ...OPEN_HOUSE, variables: { ...OPEN_HOUSE.variables, presenter: { type: "character", avatar_id: "look_of_someone" } } }), "u1"), /presenter that is not available/);
    await assert.rejects(createTemplate({ fromVideoId: video.id }, "u1"), /remade from that template/);
    await assert.rejects(createTemplate({ fromVideoId: video.id }, "u2"), NotFoundError, "another account learns nothing about it");
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
              subtitle: { type: "text" },
              hero: { type: "image", asset: { type: "base64", media_type: "image/png", data: "AAAA" }, fit: "contain", extra: 1 },
              clip: { type: "video", asset: { type: "url", url: "https://r.heygen.ai/c.mp4" }, fit: "cover", play_style: "loop", volume: 0.5, read_only: true },
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
      assert.deepEqual(
        t.variables,
        {
          headline: { type: "text", content: "Q3 in review" },
          host: { type: "character", avatar_id: "look_9" },
          subtitle: { type: "text", content: "" },
          hero: { type: "image", fit: "contain" },
          clip: { type: "video", asset: { type: "url", url: "https://r.heygen.ai/c.mp4" }, fit: "cover", play_style: "loop", volume: 0.5 },
        },
        "unknown types are left out, old field names read, only known fields kept, and a missing text is empty",
      );
      await assert.rejects(getStudioTemplate("gone"), NotFoundError);
      await assert.rejects(renderStudioTemplate("t1", studioRenderSchema.parse({ title: "Q3", variables: { headline: { type: "text", content: "Q4 plans" } } }), "u1"), /Fill in "subtitle"/, "a text with no content is a 400, not a crash");
      const video = await renderStudioTemplate("t1", studioRenderSchema.parse({ title: "Q3", captions: true, variables: { headline: { type: "text", content: "Q4 plans" }, subtitle: { type: "text", content: "Our plans" } } }), "u1");
      const post = calls.find((c) => c.method === "POST")!;
      assert.deepEqual(post.body, { variables: { headline: { type: "text", content: "Q4 plans" }, subtitle: { type: "text", content: "Our plans" } }, title: "Q3", caption: true }, "media, presenter, and voice not given are left to the template");
      assert.deepEqual([video.providerJobId, video.status, video.script, video.avatarId], ["hg_tpl_1", "processing", "Welcome to the Q4 plans update.", "look_9"]);
      // The detail is reused for a while.
      const before = calls.length;
      await getStudioTemplate("t1");
      assert.equal(calls.length, before);
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
