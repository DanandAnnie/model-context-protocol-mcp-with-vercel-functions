// A presenter drawn from a description (HeyGen prompt to avatar): the portrait job, what HeyGen is asked, and the
// finished portrait kept as a data URL that saves as a photo avatar.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createAvatar, createAvatarSchema, generatePortraitSchema, portraitStatus, startPortrait } from "../services";
import { ValidationError } from "../errors";
import { providerStatus } from "../providers";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const PROMPT = "A friendly real estate agent in her forties, navy blazer, warm smile, bright office behind her";

describe("presenter from a description", () => {
  it("checks the description and the job id", async () => {
    assert.throws(() => generatePortraitSchema.parse({ name: "Dana", prompt: "A woman" }), /at least 20 characters/);
    assert.throws(() => generatePortraitSchema.parse({ name: "Dana", prompt: "x".repeat(1001) }));
    await assert.rejects(portraitStatus("../looks/1"), /Unknown portrait/);
  });

  it("draws an illustrated stand-in in demo mode that saves as a photo avatar", async () => {
    assert.equal(providerStatus().portraitGeneration, true);
    const { jobId } = await startPortrait(generatePortraitSchema.parse({ name: "Dana Lee", prompt: PROMPT }));
    const out = await portraitStatus(jobId);
    assert.equal(out.status, "completed");
    assert.match(out.imageUrl!, /^data:image\/svg\+xml/);
    assert.equal((await startPortrait({ name: "Dana Lee", prompt: PROMPT })).jobId, jobId, "the same description draws the same stand-in");
    const avatar = await createAvatar(createAvatarSchema.parse({ name: "Dana Lee", imageUrl: out.imageUrl }), "u1");
    assert.equal(avatar.source, "custom");
  });

  it("asks HeyGen for a square presenter, follows the look, and keeps the finished portrait", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; key: string | null }> = [];
    const looks: Record<string, unknown> = {
      look_1: { data: { status: "processing" } },
      look_2: { data: { status: "completed", preview_image_url: "https://93.184.216.34/look_2.png" } },
      look_3: { status: "failed", error: { code: "moderation_failed", message: "The description was refused." } },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get("x-api-key") });
      if (url === "https://api.heygen.com/v3/avatars") {
        const prompt = (JSON.parse(String(init!.body)) as { prompt: string }).prompt;
        if (prompt.includes("refuse")) return Response.json({ error: { code: "invalid_parameter", message: "The prompt is not allowed." } }, { status: 400 });
        return Response.json({ data: { look_id: "look_2", status: "processing" } });
      }
      const look = /\/v3\/avatars\/looks\/(\w+)$/.exec(url)?.[1];
      if (look && looks[look]) return Response.json(looks[look]);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      assert.deepEqual(await startPortrait({ name: "Dana Lee", prompt: PROMPT }), { jobId: "look_2" });
      assert.deepEqual(calls[0], { url: "https://api.heygen.com/v3/avatars", method: "POST", body: { type: "prompt", name: "Dana Lee", prompt: PROMPT, aspect_ratio: "1:1" }, key: "hg_key" });
      await assert.rejects(startPortrait({ name: "Dana Lee", prompt: `${PROMPT}, please refuse this` }), (e: unknown) => e instanceof ValidationError && /could not draw that presenter: The prompt is not allowed\./.test((e as Error).message));
      assert.deepEqual(await portraitStatus("look_1"), { status: "processing" });
      assert.deepEqual(await portraitStatus("look_3"), { status: "failed", error: "The description was refused." });
      // The finished portrait is read once through the public-address guard and handed back as a data URL.
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const fetched: string[] = [];
      const done = await portraitStatus("look_2", async (url) => {
        fetched.push(String(url));
        return new Response(png, { headers: { "content-type": "image/png" } });
      });
      assert.deepEqual(fetched, ["https://93.184.216.34/look_2.png"]);
      assert.deepEqual(done, { status: "completed", imageUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}` });
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });
});
