// The Video Agent: one prompt planned into scenes and rendered.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { config } from "../config";
import { AnthropicScriptProvider } from "../providers/script/anthropic";
import { setScriptProvider } from "../providers";
import type { ScriptProvider, VideoPlan } from "../providers/types";
import { LimitError, NotFoundError, ValidationError, brandKitSchema, fitPlan, generateAgentVideo, getVideo, planVideo, saveBrandKit, videoAgentSchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

/** A planner that hands back whatever plan the test sets, and records what it was asked. */
let nextPlan: VideoPlan = { title: "", orientation: "landscape", scenes: [] };
const asked: Array<{ prompt: string; lengthSec: number; language: string; source?: string }> = [];
const scripted: ScriptProvider = {
  name: "scripted",
  generate: async () => "",
  chat: async () => "",
  revise: async ({ script }) => script,
  plan: async (input) => {
    asked.push(input);
    return nextPlan;
  },
};

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  asked.length = 0;
});
afterEach(() => setScriptProvider(undefined));

describe("video agent", () => {
  it("plans a renderable video from a prompt alone, portrait for a social format, with captions on", async () => {
    const draft = await planVideo(videoAgentSchema.parse({ prompt: "Make a TikTok about our new coffee app", lengthSec: 60 }));
    assert.equal(draft.aspect, "9:16");
    assert.equal(draft.title, "Our new coffee app");
    assert.equal(draft.avatarId, STOCK_AVATARS[0].id);
    assert.ok(STOCK_VOICES.some((v) => v.id === draft.voiceId));
    assert.equal(draft.captions, true);
    assert.equal(draft.resolution, "1080p");
    assert.ok(draft.scenes.length >= 3 && draft.scenes.length <= 6, `${draft.scenes.length} scenes`);
    // The hook and the call to action are close-ups; the scenes between are in full.
    assert.equal(draft.scenes[0].layout?.framing, "closeUp");
    assert.equal(draft.scenes.at(-1)?.layout?.framing, "closeUp");
    assert.equal(draft.scenes[1].layout, undefined);
    assert.ok(videoRequestSchema.safeParse(draft).success);
    // Landscape otherwise, and an explicit orientation wins over the plan's.
    assert.equal((await planVideo(videoAgentSchema.parse({ prompt: "Explain our refund policy" }))).aspect, "16:9");
    assert.equal((await planVideo(videoAgentSchema.parse({ prompt: "Make a TikTok about us", orientation: "square" }))).aspect, "1:1");
  });

  it("leaves the format to the brand kit when the agent chooses and the plan is not for a vertical format", async () => {
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#1e3a8a", defaultAspect: "1:1" }));
    assert.equal((await planVideo(videoAgentSchema.parse({ prompt: "Explain our refund policy" }))).aspect, "1:1");
    assert.equal((await planVideo(videoAgentSchema.parse({ prompt: "Make a TikTok about our app" }))).aspect, "9:16", "a vertical format the plan asks for still wins");
    assert.equal((await planVideo(videoAgentSchema.parse({ prompt: "Explain our refund policy", orientation: "landscape" }))).aspect, "16:9", "and so does a format the user picked");
  });

  it("applies the brand kit: presenter, voice, background, quality, and captions", async () => {
    const avatar = STOCK_AVATARS[2];
    const voice = STOCK_VOICES[3];
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#1e3a8a", defaultAvatarId: avatar.id, defaultVoiceId: voice.id, defaultResolution: "720p", captionsByDefault: false }));
    const draft = await planVideo(videoAgentSchema.parse({ prompt: "Welcome new customers to Acme" }));
    assert.equal(draft.avatarId, avatar.id);
    assert.equal(draft.voiceId, voice.id);
    assert.equal(draft.resolution, "720p");
    assert.equal(draft.captions, false);
    assert.ok(draft.scenes.every((sc) => sc.background.type === "color" && sc.background.value === "#1e3a8a"));
    // A presenter and voice asked for win over the kit's.
    const chosen = await planVideo(videoAgentSchema.parse({ prompt: "Welcome new customers", avatarId: STOCK_AVATARS[1].id, voiceId: STOCK_VOICES[0].id }));
    assert.equal(chosen.avatarId, STOCK_AVATARS[1].id);
    assert.equal(chosen.voiceId, STOCK_VOICES[0].id);
  });

  it("refuses a presenter or voice that is not available, and a prompt it cannot plan", async () => {
    await assert.rejects(planVideo(videoAgentSchema.parse({ prompt: "Hello there", avatarId: "nope" })), NotFoundError);
    await assert.rejects(planVideo(videoAgentSchema.parse({ prompt: "Hello there", voiceId: "nope" })), ValidationError);
    setScriptProvider(scripted);
    nextPlan = { title: "Empty", orientation: "landscape", scenes: [{ script: "[pause 2s]", framing: "full" }] };
    await assert.rejects(planVideo(videoAgentSchema.parse({ prompt: "Hello there" })), /could not plan a video/);
    assert.throws(() => videoAgentSchema.parse({ prompt: "hi" }), /a few words/);
  });

  it("skips a presenter's default voice that is gone for the brand kit's", async () => {
    await getStore().put("avatar", { id: "custom_1", name: "Me", imageUrl: "data:image/png;base64,AA==", source: "custom", ownerId: "local", defaultVoiceId: "gone-clone" });
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#1e3a8a", defaultVoiceId: STOCK_VOICES[3].id }), "local");
    const draft = await planVideo(videoAgentSchema.parse({ prompt: "Welcome new customers", avatarId: "custom_1" }), "local");
    assert.equal(draft.avatarId, "custom_1");
    assert.equal(draft.voiceId, STOCK_VOICES[3].id);
  });

  it("checks the render allowance before planning", async () => {
    setScriptProvider(scripted);
    nextPlan = { title: "T", orientation: "landscape", scenes: [{ script: "Hello there.", framing: "full" }] };
    const original = config.renderLimitPerMonth;
    (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = 1;
    try {
      await generateAgentVideo(videoAgentSchema.parse({ prompt: "Hello there" }), "agent-quota");
      await assert.rejects(generateAgentVideo(videoAgentSchema.parse({ prompt: "Hello again" }), "agent-quota"), LimitError);
      assert.equal(asked.length, 1, "the refused request never reached the planner");
    } finally {
      (config as { renderLimitPerMonth?: number }).renderLimitPerMonth = original;
    }
  });

  it("turns the Claude planner's refusals, cut-off plans, and malformed plans into clear errors", async () => {
    const realFetch = globalThis.fetch;
    let reply: unknown;
    let sent: { output_config?: { format?: { type?: string } }; fallbacks?: unknown } = {};
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const message = (text: string, stop: string) => ({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    try {
      const writer = new AnthropicScriptProvider("sk-test");
      const ask = () => writer.plan({ prompt: "A video", lengthSec: 60, language: "English" });
      reply = message(JSON.stringify({ title: "T", orientation: "Portrait", scenes: [{ script: "Hi there.", framing: "close-up" }] }), "end_turn");
      assert.deepEqual(await ask(), { title: "T", orientation: "portrait", scenes: [{ script: "Hi there.", framing: "closeUp" }] });
      assert.equal(sent.output_config?.format?.type, "json_schema");
      assert.equal(sent.fallbacks, "default");
      reply = message('{"title":"T","scenes":[{"script":"Hel', "max_tokens");
      await assert.rejects(ask(), /ran out of room/);
      reply = message('{"title":"T","sce', "refusal");
      await assert.rejects(ask(), /declined this request/);
      reply = message(JSON.stringify({ title: "T", scenes: [] }), "end_turn");
      await assert.rejects(ask(), /could not read/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("keeps the plan within what a video holds", () => {
    const sentence = "This sentence is here to fill a scene with words. ";
    // Pause-only scenes are dropped, at most ten scenes are kept, and the scripts together fit in 5000 characters.
    const many = fitPlan({ title: "t", orientation: "landscape", scenes: [{ script: "[pause 1s]", framing: "full" }, ...Array.from({ length: 25 }, (_, i) => ({ script: `Scene ${i}. ${sentence.repeat(2)}`, framing: "full" as const }))] });
    assert.equal(many.length, 10);
    assert.equal(many[0].script.startsWith("Scene 0."), true);
    const long = fitPlan({ title: "t", orientation: "landscape", scenes: Array.from({ length: 6 }, () => ({ script: sentence.repeat(30).trim(), framing: "full" as const })) });
    assert.ok(long.map((s) => s.script).join("\n\n").length <= 5000);
    assert.equal(long.length, 3);
    // A first scene longer than a whole video is cut at a sentence end.
    const huge = fitPlan({ title: "t", orientation: "landscape", scenes: [{ script: sentence.repeat(200), framing: "full" }] });
    assert.equal(huge.length, 1);
    assert.ok(huge[0].script.length <= 5000 && huge[0].script.endsWith("."));
    // A cut never leaves half a pause marker, nor a scene of pauses alone.
    const marker = fitPlan({ title: "t", orientation: "landscape", scenes: [{ script: `${"a".repeat(4990)} [pause 2s] and more words`, framing: "full" }] });
    assert.equal(marker[0].script, "a".repeat(4990));
    const pauses = fitPlan({ title: "t", orientation: "landscape", scenes: [{ script: `${"[pause 1s] ".repeat(600)}Hello there.`, framing: "full" }] });
    assert.deepEqual(pauses, []);
    // ...and the next scene takes its place; a bracket in the prose is not taken for a marker.
    const next = fitPlan({ title: "t", orientation: "landscape", scenes: [{ script: `${"[pause 1s] ".repeat(600)}Hello there.`, framing: "full" }, { script: "Welcome aboard.", framing: "full" }] });
    assert.deepEqual(next.map((sc) => sc.script), ["Welcome aboard."]);
    const bracket = fitPlan({ title: "t", orientation: "landscape", scenes: [{ script: `Press the [ key, then ${"word ".repeat(1200)}`, framing: "full" }] });
    assert.ok(bracket[0].script.length > 4900, `${bracket[0].script.length} characters kept`);
    for (const marker of ["[pause 2s]", "[ pause 1.5s ]", "[pause]", "[ pause 2 s]"]) {
      for (let at = 4985; at <= 5000; at++) {
        const [scene] = fitPlan({ title: "t", orientation: "landscape", scenes: [{ script: `${"a ".repeat(at / 2)}${marker} more words here`, framing: "full" }] });
        assert.ok(!/\[[^\]]*$/.test(scene.script), `${marker} at ${at}: ${scene.script.slice(-20)}`);
      }
    }
  });

  it("writes from a web page and renders the plan as one video", async () => {
    const fake = (async () =>
      new Response("<html><head><title>Spring sale</title></head><body><p>Everything in the store is twenty percent off until Sunday night.</p><p>Members get free shipping on every order over thirty dollars.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    setScriptProvider(scripted);
    nextPlan = {
      title: "Spring sale",
      orientation: "portrait",
      scenes: [
        { script: "Big news: our spring sale is on!", framing: "closeUp" },
        { script: "Everything is twenty percent off until Sunday night.", framing: "full" },
        { script: "Shop now before it ends.", framing: "closeUp" },
      ],
    };
    const { video, draft } = await generateAgentVideo(videoAgentSchema.parse({ prompt: "A reel about our spring sale", url: "https://203.0.113.5/sale", lengthSec: 30, language: "Spanish" }), undefined, fake);
    assert.match(asked[0].source ?? "", /twenty percent off/);
    assert.equal(asked[0].lengthSec, 30);
    assert.equal(asked[0].language, "Spanish");
    assert.notEqual(video.status, "failed");
    const stored = await getVideo(video.id, undefined, false);
    assert.equal(stored.title, "Spring sale");
    assert.equal(stored.aspect, "9:16");
    assert.equal(stored.captions, true);
    assert.deepEqual(stored.scenes?.map((s) => s.script), draft.scenes.map((s) => s.script));
    assert.equal(stored.scenes?.[0].layout?.framing, "closeUp");
    // A page that cannot be read is the caller's mistake, not a server error.
    await assert.rejects(planVideo(videoAgentSchema.parse({ prompt: "A reel about this", url: "http://127.0.0.1/x" })), (err) => err instanceof ValidationError && /public host/.test(err.message));
  });
});
