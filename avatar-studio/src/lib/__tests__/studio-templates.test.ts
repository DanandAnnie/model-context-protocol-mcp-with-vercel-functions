// HeyGen Studio templates: the renderer's templates listed and read, their variables filled and checked, rendered as a
// library video that a retry sends again and that is not copied, resized, or saved as a template here.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createTemplate, fillStudioVariables, filledScript, forgetStudioTemplates, getStudioTemplate, listStudioTemplates, renderStudioTemplate, resizeVideo, retryVideo, studioRenderSchema } from "../services";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
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
    await assert.rejects(fillStudioVariables(t, {}), /Fill in "Open time"/, "a text with no default must be given");
    await assert.rejects(fillStudioVariables(t, { ...filled, nickname: { type: "text", content: "x" } }), /no variable "nickname"/);
    await assert.rejects(fillStudioVariables(t, { ...filled, address: { type: "image", asset: { type: "url", url: "https://93.184.216.34/a.png" } } }), /"Address" is a text slot, not image/);
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
    await assert.rejects(renderStudioTemplate("demo_product_update", studioRenderSchema.parse({ title: "Update" }), "u1"), /Fill in "Details"/);
    const upd = await renderStudioTemplate("demo_product_update", studioRenderSchema.parse({ title: "Update", variables: { details: { type: "text", content: "Faster search." } } }), "u1");
    assert.deepEqual([upd.aspect, upd.voiceId], ["9:16", "studio-template"]);
  });

  it("returns the same video for a render retried with the same key, without rendering or counting it twice", async () => {
    const { MockAvatarProvider } = await import("../providers/avatar/mock");
    const proto = MockAvatarProvider.prototype as unknown as { createVideo: (...a: unknown[]) => Promise<unknown> };
    const real = proto.createVideo;
    let renders = 0;
    let gate: Promise<void> | null = null;
    proto.createVideo = async function (this: unknown, ...a: unknown[]) {
      renders++;
      if (gate) await gate;
      return real.apply(this, a);
    };
    try {
      const input = studioRenderSchema.parse(OPEN_HOUSE);
      const first = await renderStudioTemplate("demo_open_house", input, "u1", { key: "render-key-1" });
      const again = await renderStudioTemplate("demo_open_house", input, "u1", { key: "render-key-1" });
      assert.deepEqual([again.id, again.createdAt, renders], [first.id, first.createdAt, 1], "the same video, rendered once");
      assert.equal((await getStore().list<Video>("video", "u1")).length, 1);
      await assert.rejects(renderStudioTemplate("demo_open_house", { ...input, title: "Another invite" }, "u1", { key: "render-key-1" }), ConflictError, "the same key with another title");
      // A retry arriving while the first is still being sent is told so (and the page keeps its key), not rendered twice.
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      const slow = renderStudioTemplate("demo_open_house", input, "u1", { key: "render-key-slow" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await assert.rejects(renderStudioTemplate("demo_open_house", input, "u1", { key: "render-key-slow" }), (e: unknown) => e instanceof ConflictError && /still being sent/.test((e as Error).message));
      open();
      gate = null;
      const landed = await slow;
      assert.equal(landed.status, "processing");
      assert.equal(renders, 2, "one render per key");
      assert.equal((await renderStudioTemplate("demo_open_house", input, "u1", { key: "render-key-slow" })).id, landed.id);
      // A video moved to the trash is not handed back as the answer.
      await getStore().put("video", { ...landed, deletedAt: new Date().toISOString() });
      await assert.rejects(renderStudioTemplate("demo_open_house", input, "u1", { key: "render-key-slow" }), /in the trash/);
    } finally {
      proto.createVideo = real;
    }
    const input = studioRenderSchema.parse(OPEN_HOUSE);
    const first = (await getStore().list<Video>("video", "u1")).find((v) => !v.deletedAt)!;
    assert.notEqual((await renderStudioTemplate("demo_open_house", input, "u2", { key: "render-key-1" })).id, first.id, "another account's key is its own");
    await assert.rejects(renderStudioTemplate("demo_product_update", studioRenderSchema.parse({ title: "Update", variables: { details: { type: "text", content: "Faster." } } }), "u1", { key: "render-key-1" }), ConflictError, "the same key for another template");
    assert.notEqual((await renderStudioTemplate("demo_open_house", input, "u1")).id, first.id, "without a key every render is new");
    // Messages name a slot as the form labels it.
    await assert.rejects(renderStudioTemplate("demo_open_house", studioRenderSchema.parse({ ...OPEN_HOUSE, variables: { ...OPEN_HOUSE.variables, agent_name: { type: "text", content: " " } } }), "u1"), /Fill in "Agent name"/);
  });

  it("asks HeyGen for its templates and renders one with its variables", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, idem: new Headers(init?.headers).get("idempotency-key") });
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
      await assert.rejects(renderStudioTemplate("t1", studioRenderSchema.parse({ title: "Q3", variables: { headline: { type: "text", content: "Q4 plans" } } }), "u1"), /Fill in "Subtitle"/, "a text with no content is a 400, not a crash");
      const video = await renderStudioTemplate("t1", studioRenderSchema.parse({ title: "Q3", captions: true, variables: { headline: { type: "text", content: "Q4 plans" }, subtitle: { type: "text", content: "Our plans" } } }), "u1");
      const post = calls.find((c) => c.method === "POST")!;
      assert.deepEqual(post.body, { variables: { headline: { type: "text", content: "Q4 plans" }, subtitle: { type: "text", content: "Our plans" } }, title: "Q3", caption: true }, "media, presenter, and voice not given are left to the template");
      assert.deepEqual([video.providerJobId, video.status, video.script, video.avatarId], ["hg_tpl_1", "processing", "Welcome to the Q4 plans update.", "look_9"]);
      assert.equal(post.idem, null, "without a client key HeyGen gets none");
      // With one, HeyGen gets the studio's video id as its key, so a render repeated after a lost answer is replayed there.
      const keyed = await renderStudioTemplate("t1", studioRenderSchema.parse({ title: "Q3", variables: { headline: { type: "text", content: "Q4 plans" }, subtitle: { type: "text", content: "Our plans" } } }), "u1", { key: "render-key-hg" });
      assert.equal(calls.filter((c) => c.method === "POST").at(-1)!.idem, keyed.id);
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
