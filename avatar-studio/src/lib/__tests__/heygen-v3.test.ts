// HeyGen's v3 API, which replaces v1 and v2 (retired October 31, 2026): paged lists, multipart asset uploads, photo
// avatars made from a portrait and waited for, and render status.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HeyGenAvatarProvider } from "../providers/avatar/heygen";
import { HeyGenTranslateProvider } from "../providers/translate/heygen";
import { ValidationError } from "../errors";
import type { Avatar } from "../types";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { createAvatar, listAvatars } from "../services";
import { STOCK_AVATARS } from "../stock";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; method: string; init?: RequestInit };
/** Answers each request from `route`; every call is recorded. */
function serve(route: (url: string, init?: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", init });
    return route(url, init);
  }) as typeof fetch;
  return calls;
}

const PORTRAIT: Avatar = { id: "ava_custom", name: "Dana", imageUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`, source: "custom", provider: "heygen" };
const noWait = (p: HeyGenAvatarProvider) => {
  (p as unknown as { sleep: () => Promise<void> }).sleep = async () => {};
  return p;
};

describe("HeyGen v3", () => {
  it("lists the account's own looks in full, then every page of the preset library, leaving out looks that cannot render yet", async () => {
    const calls = serve((url) => {
      if (url.includes("ownership=private")) {
        return Response.json({ data: [{ id: "look_3", name: "Photo", avatar_type: "photo_avatar", preview_image_url: "https://cdn/3.jpg", status: "completed" }], has_more: false, next_token: null });
      }
      if (url.includes("token=next1")) return Response.json({ data: [{ id: "look_3", name: "Photo", avatar_type: "photo_avatar", preview_image_url: "https://cdn/3.jpg" }], has_more: false });
      return Response.json({
        data: [
          { id: "look_1", name: "Ava", avatar_type: "studio_avatar", preview_image_url: "https://cdn/1.jpg", preview_video_url: "https://cdn/1.mp4", gender: "Female", tags: ["business", "studio", "indoor", "smile", "extra"] },
          { id: "look_2", name: "Training", avatar_type: "photo_avatar", preview_image_url: "https://cdn/2.jpg", status: "processing" },
          { id: "look_4", name: "No picture", avatar_type: "studio_avatar" },
        ],
        has_more: true,
        next_token: "next1",
      });
    });
    const avatars = await new HeyGenAvatarProvider("key").listAvatars();
    assert.deepEqual(calls.map((c) => c.url).sort(), [
      "https://api.heygen.com/v3/avatars/looks?ownership=private&limit=50",
      "https://api.heygen.com/v3/avatars/looks?ownership=public&limit=50",
      "https://api.heygen.com/v3/avatars/looks?ownership=public&limit=50&token=next1",
    ]);
    assert.equal(new Headers(calls[0].init?.headers).get("x-api-key"), "key");
    assert.deepEqual(avatars, [
      { id: "look_3", name: "Photo", imageUrl: "https://cdn/3.jpg", source: "provider", provider: "heygen", gender: undefined, tags: ["photo avatar"] },
      { id: "look_1", name: "Ava", imageUrl: "https://cdn/1.jpg", previewVideoUrl: "https://cdn/1.mp4", source: "provider", provider: "heygen", gender: "female", tags: ["business", "studio", "indoor", "smile"] },
    ], "the account's own first, each look once");
  });

  it("lists the account's own HeyGen voices beside the shared library, and stops paging the library after a bounded number of pages", async () => {
    let n = 0;
    const calls = serve((url) => {
      if (url.includes("type=private")) return Response.json({ data: [{ voice_id: "mine", name: "My clone" }], has_more: false });
      return Response.json({ data: [{ voice_id: `v${n}`, name: `V${n++}` }], has_more: true, next_token: `t${n}` });
    });
    const { HeyGenTtsProvider } = await import("../providers/tts/heygen");
    const voices = await new HeyGenTtsProvider("key").listVoices();
    assert.equal(voices[0].id, "mine", "a voice cloned in the HeyGen account is listed, so videos naming it still render");
    assert.equal(voices.length, 21);
    assert.equal(calls.filter((c) => c.url.includes("type=public")).length, 20);
    assert.ok(calls.some((c) => c.url === "https://api.heygen.com/v3/voices?type=private&limit=100"));
  });

  it("uploads an asset as multipart form data and reads its id", async () => {
    const calls = serve(() => Response.json({ data: { asset_id: "asset_1" } }));
    const provider = new HeyGenAvatarProvider("key");
    const clip = await provider.prepareAudio({ id: "clip_1", name: "Intro", mimeType: "audio/mpeg", bytes: 3, durationSec: 1, createdAt: "" }, { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" });
    assert.equal(clip.providerAssetIds?.["heygen:asset"], "asset_1");
    assert.equal(calls[0].url, "https://api.heygen.com/v3/assets");
    assert.equal(calls[0].method, "POST");
    const form = calls[0].init?.body as FormData;
    const file = form.get("file") as File;
    assert.equal(file.type, "audio/mpeg");
    assert.equal(file.name, "clip.mp3");
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
    assert.equal(new Headers(calls[0].init?.headers).get("content-type"), null, "fetch sets the multipart boundary itself");
    serve(() => new Response(JSON.stringify({ error: { code: "invalid_file", message: "Unsupported file" } }), { status: 400 }));
    await assert.rejects(provider.prepareBackdrop({ id: "bd_1", name: "Office", mimeType: "image/png", bytes: 1, createdAt: "" }, { bytes: new Uint8Array([1]), mimeType: "image/png" }), /asset upload failed: 400/);
  });

  it("makes a photo avatar from a portrait once, and waits for HeyGen to prepare it", async () => {
    let checks = 0;
    let made = 0;
    const calls = serve((url, init) => {
      if (url.endsWith("/v3/assets")) return Response.json({ data: { asset_id: "asset_p" } });
      if (url.endsWith("/v3/avatars") && init?.method === "POST") return Response.json({ data: { avatar_item: { id: `look_p${++made}`, status: "processing" } } });
      if (url.endsWith("/v3/avatars/looks/look_gone")) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
      if (url.includes("/v3/avatars/looks/look_p")) return Response.json({ data: { status: ++checks < 3 ? "processing" : "completed" } });
      return new Response("unexpected", { status: 500 });
    });
    const provider = noWait(new HeyGenAvatarProvider("key"));
    const prepared = await provider.prepareAvatar(PORTRAIT);
    assert.deepEqual(prepared.providerAssetIds, { "heygen:look": "look_p1", "heygen:pending": "" });
    assert.equal(checks, 3);
    const create = calls.find((c) => c.url.endsWith("/v3/avatars"))!;
    assert.deepEqual(JSON.parse(String(create.init?.body)), { type: "photo", name: "Dana", file: { type: "asset_id", asset_id: "asset_p" } });
    // Ready: nothing is asked again, and renders name the look.
    const before = calls.length;
    assert.equal(await provider.prepareAvatar(prepared), prepared);
    assert.equal(calls.length, before);
    // A v1 talking photo id, kept under the old key, is not trusted as a look: the portrait is made again once.
    const legacy = await provider.prepareAvatar({ ...PORTRAIT, providerAssetIds: { heygen: "tp_old" } });
    assert.equal(legacy.providerAssetIds?.["heygen:look"], "look_p2");
    assert.equal(legacy.providerAssetIds?.heygen, "tp_old");
    // A look HeyGen no longer knows, while pending, is made again rather than asked about forever.
    const remade = await provider.prepareAvatar({ ...PORTRAIT, providerAssetIds: { "heygen:look": "look_gone", "heygen:pending": "1" } });
    assert.equal(remade.providerAssetIds?.["heygen:look"], "look_p3");
    // Any other error while asking (a revoked key, a rate limit) is said as it is, not taken for "still preparing".
    serve((url) => (url.includes("/looks/") ? new Response("{}", { status: 429 }) : Response.json({ data: { asset_id: "a", avatar_item: { id: "look_x" } } })));
    await assert.rejects(provider.prepareAvatar({ ...PORTRAIT, providerAssetIds: { "heygen:look": "look_slow", "heygen:pending": "1" } }), / failed: 429/);
  });

  it("keeps a photo avatar still being prepared, asks about it once on the next render without waiting, and refuses to render it meanwhile", async () => {
    let status = "processing";
    let sleeps = 0;
    const calls = serve((url, init) => {
      if (url.endsWith("/v3/assets")) return Response.json({ data: { asset_id: "asset_p" } });
      if (url.endsWith("/v3/avatars") && init?.method === "POST") return Response.json({ data: { avatar_item: { id: init.body && String(init.body).includes("asset_p") ? "look_slow" : "look_other" } } });
      if (url.includes("/v3/avatars/looks/look_slow")) return Response.json({ data: { status, ...(status === "failed" ? { error: { message: "No face found" } } : {}) } });
      if (url.endsWith("/v3/videos")) return Response.json({ data: { video_id: "vid_1" } });
      return new Response("unexpected", { status: 500 });
    });
    const provider = new HeyGenAvatarProvider("key");
    (provider as unknown as { sleep: () => Promise<void> }).sleep = async () => void sleeps++;
    const pending = await provider.prepareAvatar(PORTRAIT);
    assert.deepEqual(pending.providerAssetIds, { "heygen:look": "look_slow", "heygen:pending": "1" });
    assert.equal(calls.filter((c) => c.url.endsWith("/v3/avatars/looks/look_slow")).length, 4, "a new look is asked about four times");
    assert.equal(sleeps, 3);
    const voice = { id: "v1", name: "Emma", provider: "heygen" };
    const req = { title: "T", script: "Hello.", avatarId: PORTRAIT.id, voiceId: voice.id, aspect: "16:9" as const, resolution: "720p" as const, captions: false, speed: 1, background: { type: "color" as const, value: "#000000" } };
    await assert.rejects(provider.createVideo(req, pending, voice), (e: unknown) => e instanceof ValidationError && /still preparing the photo avatar "Dana"/.test((e as Error).message));
    // The next render asks once, without waiting, and without another upload: a batch's later rows stay quick.
    const asked = calls.length;
    assert.equal(await provider.prepareAvatar(pending), pending);
    assert.equal(calls.length, asked + 1);
    assert.equal(sleeps, 3);
    status = "completed";
    const ready = await provider.prepareAvatar(pending);
    assert.equal(ready.providerAssetIds?.["heygen:pending"], "");
    assert.equal(calls.filter((c) => c.url.endsWith("/v3/assets")).length, 1);
    // A short colour is spelled out as HeyGen takes it; one it cannot take is refused before anything is uploaded.
    await provider.createVideo({ ...req, background: { type: "color", value: "#0Fa" } }, ready, voice);
    const body = JSON.parse(String(calls.at(-1)!.init?.body)) as { scenes: Array<{ input: { avatar_id: string; background: unknown } }> };
    assert.equal(body.scenes[0].input.avatar_id, "look_slow");
    assert.deepEqual(body.scenes[0].input.background, { type: "color", color: "#00FFaa" });
    const uploads = calls.filter((c) => c.url.endsWith("/v3/assets")).length;
    await assert.rejects(provider.createVideo({ ...req, script: "[pause 3s]", background: { type: "color", value: "teal" } }, ready, voice), /#rrggbb/);
    assert.equal(calls.filter((c) => c.url.endsWith("/v3/assets")).length, uploads, "no silence is uploaded for a render refused anyway");
    // A look HeyGen could not prepare is made again from the portrait; when that fails too, the portrait is the problem.
    status = "failed";
    await assert.rejects(provider.prepareAvatar(pending), (e: unknown) => e instanceof ValidationError && /could not prepare the photo avatar "Dana": No face found/.test((e as Error).message));
    assert.equal(calls.filter((c) => c.url.endsWith("/v3/assets")).length, uploads + 1, "made again once");
  });

  it("reads a render's status from v3", async () => {
    const answers: Record<string, unknown> = {
      v_pending: { status: "pending" },
      v_waiting: { status: "waiting" },
      v_processing: { status: "processing" },
      v_done: { status: "completed", video_url: "https://cdn/v.mp4", thumbnail_url: "https://cdn/v.jpg", duration: 12.5 },
      v_failed: { status: "failed", failure_code: "MOVIO_FAILED", failure_message: "The script could not be spoken" },
      v_silent_fail: { status: "failed" },
    };
    const calls = serve((url) => Response.json({ data: answers[url.split("/").at(-1)!] }));
    const provider = new HeyGenAvatarProvider("key");
    const status = (id: string) => provider.getStatus(id);
    assert.deepEqual(await status("v_pending"), { status: "queued" });
    assert.deepEqual(await status("v_waiting"), { status: "queued" });
    assert.deepEqual(await status("v_processing"), { status: "processing" });
    assert.deepEqual(await status("v_done"), { status: "completed", videoUrl: "https://cdn/v.mp4", thumbnailUrl: "https://cdn/v.jpg", durationSec: 12.5 });
    assert.deepEqual(await status("v_failed"), { status: "failed", error: "The script could not be spoken" });
    assert.deepEqual(await status("v_silent_fail"), { status: "failed", error: "Render failed" });
    assert.equal(calls[0].url, "https://api.heygen.com/v3/videos/v_pending");
  });

  it("asks v2 about a translation v3 does not know, and stops once v2 is gone too", async () => {
    let v2 = 200;
    serve((url) => {
      if (url.includes("/v3/video-translations/")) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
      if (v2 !== 200) return new Response("gone", { status: v2 });
      return Response.json({ data: { status: "success", url: "https://cdn/dub.mp4" } });
    });
    const translate = new HeyGenTranslateProvider("key");
    assert.deepEqual(await translate.getStatus("old_job"), { status: "completed", videoUrl: "https://cdn/dub.mp4" });
    v2 = 410;
    const gone = await translate.getStatus("old_job");
    assert.equal(gone.status, "failed", "a retired v2 answers 410 and the job stops being asked about");
  });

  it("lists a portrait once, not again as the look the renderer made from it", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const before = await listAvatars("owner_dup");
    const look = STOCK_AVATARS[0].id;
    assert.ok(before.some((a) => a.id === look));
    const mine = await createAvatar({ name: "Dana", imageUrl: PORTRAIT.imageUrl }, "owner_dup");
    await getStore().put("avatar", { ...mine, providerAssetIds: { [`mock`]: look } });
    const after = await listAvatars("owner_dup");
    assert.equal(after[0].id, mine.id);
    assert.equal(after.some((a) => a.id === look), false, "the look stands behind the portrait, not beside it");
    assert.ok((await listAvatars("someone_else")).some((a) => a.id === look), "another account still sees the library look");
  });
});
