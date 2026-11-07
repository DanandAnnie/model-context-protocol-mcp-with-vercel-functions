// A presenter drawn from a description (HeyGen prompt to avatar): the portrait job, kept under the account that asked,
// what HeyGen is asked, and the finished portrait kept as a data URL that saves as a photo avatar.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_PORTRAIT_BYTES, createAvatar, createAvatarSchema, deleteOwnerData, exportOwnerData, generatePortraitSchema, portraitStatus, startPortrait } from "../services";
import { NotFoundError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { getStore } from "../store";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const PROMPT = "A friendly real estate agent in her forties, navy blazer, warm smile, bright office behind her";

describe("presenter from a description", () => {
  it("checks the description and the job id", async () => {
    assert.throws(() => generatePortraitSchema.parse({ name: "Dana", prompt: "A woman" }), /at least 20 characters/);
    assert.throws(() => generatePortraitSchema.parse({ name: "Dana", prompt: "x".repeat(1001) }));
    await assert.rejects(portraitStatus("../looks/1", "u1"), /Unknown portrait/);
  });

  it("draws an illustrated stand-in in demo mode that saves as a photo avatar, for the account that asked only", async () => {
    assert.equal(providerStatus().portraitGeneration, true);
    const { jobId } = await startPortrait(generatePortraitSchema.parse({ name: "Dana Lee", prompt: PROMPT }), "u1");
    assert.match(jobId, /^pt_/, "the studio's own id, not the renderer's");
    await assert.rejects(portraitStatus(jobId, "u2"), NotFoundError, "another account cannot follow it");
    const out = await portraitStatus(jobId, "u1");
    assert.equal(out.status, "completed");
    assert.match(out.imageUrl!, /^data:image\/svg\+xml/);
    const avatar = await createAvatar(createAvatarSchema.parse({ name: "Dana Lee", imageUrl: out.imageUrl }), "u1");
    assert.equal(avatar.source, "custom");
    // Names with emoji, at the start or at the 40-character cut, draw too.
    for (const name of ["😀 Dana", `${"x".repeat(39)}😀😀`, "A&B <c>"]) {
      const job = await startPortrait({ name, prompt: PROMPT }, "u1");
      assert.equal((await portraitStatus(job.jobId, "u1")).status, "completed", name);
    }
    // The job goes with the account, and the export leaves its picture out.
    const exported = await exportOwnerData("u1");
    assert.ok(exported.portrait.length >= 1 && exported.portrait.every((p) => !("imageUrl" in p)));
    await deleteOwnerData("u1");
    assert.deepEqual(await getStore().list("portrait", "u1"), []);
  });

  it("asks HeyGen for a 4:5 presenter, follows the look, and keeps the finished portrait", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: unknown; key: string | null }> = [];
    let nextLook = "look_2";
    const looks: Record<string, unknown> = {
      look_1: { data: { status: "processing" } },
      look_2: { data: { status: "completed", preview_image_url: "https://93.184.216.34/look_2.png" } },
      look_3: { status: "failed", error: { code: "moderation_failed", message: "The description was refused." } },
      look_4: { status: "completed", preview_image_url: "https://93.184.216.34/look_4.png" },
      look_5: { data: { status: "completed" } },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get("x-api-key") });
      if (url === "https://api.heygen.com/v3/avatars") {
        const prompt = (JSON.parse(String(init!.body)) as { prompt: string }).prompt;
        if (prompt.includes("refuse")) return Response.json({ error: { code: "invalid_parameter", message: "The prompt is not allowed." } }, { status: 400 });
        if (prompt.includes("credits")) return Response.json({ error: { code: "insufficient_credits", message: "Not enough credits." } }, { status: 402 });
        return Response.json({ data: { look_id: nextLook, status: "processing" } });
      }
      const look = /\/v3\/avatars\/looks\/(\w+)$/.exec(url)?.[1];
      if (look && looks[look]) return Response.json(looks[look]);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const start = (look: string, owner = "u1") => {
      nextLook = look;
      return startPortrait({ name: "Dana Lee", prompt: PROMPT }, owner);
    };
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const { jobId } = await start("look_2");
      assert.deepEqual(calls[0], { url: "https://api.heygen.com/v3/avatars", method: "POST", body: { type: "prompt", name: "Dana Lee", prompt: PROMPT, aspect_ratio: "4:5" }, key: "hg_key" });
      assert.equal(((await getStore().get("portrait", jobId)) as { providerJobId: string }).providerJobId, "look_2");
      await assert.rejects(startPortrait({ name: "Dana Lee", prompt: `${PROMPT}, please refuse this` }, "u1"), (e: unknown) => e instanceof ValidationError && /could not draw that presenter: The prompt is not allowed\./.test((e as Error).message));
      await assert.rejects(startPortrait({ name: "Dana Lee", prompt: `${PROMPT}, out of credits` }, "u1"), (e: unknown) => e instanceof ValidationError && /Not enough credits\./.test((e as Error).message));
      assert.deepEqual(await portraitStatus((await start("look_1")).jobId, "u1"), { status: "processing" });
      assert.deepEqual(await portraitStatus((await start("look_3")).jobId, "u1"), { status: "failed", error: "The description was refused." });
      assert.deepEqual(await portraitStatus((await start("look_5")).jobId, "u1"), { status: "failed", error: "HeyGen finished the presenter without a picture" });
      // The finished portrait is read once through the public-address guard, handed back as a data URL, and kept.
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const fetched: string[] = [];
      const image = async (url: string | URL | Request) => {
        fetched.push(String(url));
        return new Response(png, { headers: { "content-type": "image/png" } });
      };
      const done = await portraitStatus(jobId, "u1", image);
      assert.deepEqual(done, { status: "completed", imageUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}` });
      const heygenCalls = calls.length;
      assert.deepEqual(await portraitStatus(jobId, "u1", image), done, "followed again, it is answered from the job");
      assert.deepEqual([fetched.length, calls.length], [1, heygenCalls], "nothing more is asked of HeyGen or downloaded");
      await assert.rejects(portraitStatus(jobId, "u2"), NotFoundError);
      // An answer that is not wrapped in `data` is read the same way.
      assert.equal((await portraitStatus((await start("look_4")).jobId, "u1", image)).status, "completed");
      // Too large to save as a photo avatar, or not downloadable: the job fails with the reason.
      const big = await portraitStatus((await start("look_4")).jobId, "u1", async () => new Response(new Uint8Array(MAX_PORTRAIT_BYTES + 1), { headers: { "content-type": "image/png" } }));
      assert.deepEqual(big, { status: "failed", error: "The portrait came back larger than a photo avatar may be" });
      const gone = await portraitStatus((await start("look_4")).jobId, "u1", async () => new Response("expired", { status: 403 }));
      assert.equal(gone.status, "failed");
      assert.match(gone.error!, /could not be downloaded/);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });
});
