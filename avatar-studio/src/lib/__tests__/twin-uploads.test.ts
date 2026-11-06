// Digital twins from footage uploaded in the browser (HeyGen direct upload): the upload is begun here, the file goes
// straight to HeyGen's storage, and the twin is started from the asset once HeyGen has finished it. What is accepted,
// what HeyGen is asked, that an upload's token only works for the account it was made for, and what stays hidden.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import {
  MAX_TWINS,
  MAX_TWIN_UPLOAD_BYTES,
  exportOwnerData,
  forgetTwinChecks,
  listTwins,
  publicTwin,
  setTwinPictureFetch,
  startTwin,
  startTwinUpload,
  twinRequestSchema,
  twinUploadRequestSchema,
  twinUploadsAvailable,
} from "../services";
import { ConflictError, ValidationError } from "../errors";
import { getStore } from "../store";
import { DEMO_UPLOAD_URL, type TwinJob } from "../types";
import { forgetMemo } from "../cache";

const realFetch = globalThis.fetch;
const realNow = Date.now;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetTwinChecks();
  forgetMemo();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  setTwinPictureFetch(undefined);
});

const file = { fileName: "dana-footage.mov", contentType: "video/quicktime" as const, sizeBytes: 84_000_000 };
const start = (upload: string, extra: Record<string, unknown> = {}) => twinRequestSchema.parse({ name: "Dana Ruiz", upload, agreed: true, ...extra });

async function inHeygen(fn: () => Promise<void>) {
  const { config } = await import("../config");
  const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
  Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
  try {
    await fn();
  } finally {
    Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
  }
}

describe("digital twins from an uploaded file", () => {
  it("takes one source of footage, and an MP4, MOV, or WebM video up to 200 MB", () => {
    assert.throws(() => twinRequestSchema.parse({ name: "Dana", agreed: true }), /public https link to the footage, or upload a video file/);
    assert.throws(() => twinRequestSchema.parse({ name: "Dana", footageUrl: "https://93.184.216.34/a.mp4", upload: "x.y", agreed: true }), /one of them/);
    assert.equal(twinUploadRequestSchema.parse(file).sizeBytes, 84_000_000);
    assert.throws(() => twinUploadRequestSchema.parse({ ...file, contentType: "video/x-msvideo" }), /MP4, MOV, or WebM/);
    assert.throws(() => twinUploadRequestSchema.parse({ ...file, sizeBytes: MAX_TWIN_UPLOAD_BYTES + 1 }), /over 200 MB/);
    assert.throws(() => twinUploadRequestSchema.parse({ ...file, sizeBytes: 0 }), /empty/);
    assert.throws(() => twinUploadRequestSchema.parse({ ...file, fileName: " " }), /Choose a video file/);
  });

  it("in demo mode, uploads to the studio's demo route and trains from the upload, for its account only", async () => {
    assert.equal(twinUploadsAvailable(), true);
    let admitted = 0;
    const up = await startTwinUpload(twinUploadRequestSchema.parse(file), "u1", { key: "upload-key-1", admit: () => void admitted++ });
    assert.equal(admitted, 1);
    assert.equal(up.url, DEMO_UPLOAD_URL, "the demo's link is one the page does not send the file to");
    assert.deepEqual(up.headers, { "Content-Type": "video/quicktime" });
    assert.ok(Date.parse(up.expiresAt) > Date.now());
    // The same key is the same upload.
    const again = await startTwinUpload(twinUploadRequestSchema.parse(file), "u1", { key: "upload-key-1" });
    const asset = (token: string) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).a as string;
    assert.match(asset(up.token), /^mockasset_[0-9a-f]{24}$/);
    assert.equal(asset(again.token), asset(up.token));

    // Another account, a changed token, or one past its day is refused, and nothing is kept.
    await assert.rejects(startTwin(start(up.token), "u2"), (e: unknown) => e instanceof ValidationError && /not this account's, or it expired/.test((e as Error).message));
    const [body, mac] = up.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), o: "u2" })).toString("base64url");
    await assert.rejects(startTwin(start(`${forged}.${mac}`), "u2"), ValidationError);
    await assert.rejects(startTwin(start(`${body}.${mac}x`), "u1"), ValidationError);
    await assert.rejects(startTwin(start("garbage"), "u1"), ValidationError);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await assert.rejects(startTwin(start(up.token), "u1"), ValidationError);
    Date.now = realNow;
    assert.equal((await getStore().list("twin")).length, 0);

    const job = await startTwin(start(up.token), "u1", { key: "twin-key-1" });
    assert.deepEqual([job.footageFile, job.footageUrl, job.status], [{ name: "dana-footage.mov", sizeBytes: 84_000_000 }, undefined, "processing"]);
    assert.match(job.footageAssetId ?? "", /^mockasset_/);
    // The asset at the renderer is never shown to the account: not on the page, not in the export.
    assert.equal("footageAssetId" in publicTwin(job), false);
    assert.deepEqual(publicTwin(job).footageFile, { name: "dana-footage.mov", sizeBytes: 84_000_000 });
    const exported = (await exportOwnerData("u1")).twin[0];
    assert.equal("footageAssetId" in exported, false);
    assert.deepEqual(exported.footageFile, { name: "dana-footage.mov", sizeBytes: 84_000_000 });
    // A retry with the same key returns the twin; the same key with a link instead is another twin's key.
    assert.equal((await startTwin(start(up.token), "u1", { key: "twin-key-1" })).id, job.id);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    assert.equal((await startTwin(start(up.token), "u1", { key: "twin-key-1" })).id, job.id, "a retried start finds its twin after the token's day");
    await assert.rejects(startTwin(start(up.token), "u1", { key: "twin-key-2" }), /expired/);
    Date.now = realNow;
    await assert.rejects(startTwin(twinRequestSchema.parse({ name: "Dana Ruiz", footageUrl: "https://93.184.216.34/dana.mp4", agreed: true }), "u1", { key: "twin-key-1" }), ConflictError);
    assert.equal((await listTwins("u1")).length, 1);
  });

  it("refuses to begin an upload once the account keeps its limit of twins", async () => {
    for (let i = 0; i < MAX_TWINS; i++) {
      await getStore().put("twin", { id: `tw_full${i}`, ownerId: "u1", name: "Old", footageUrl: "https://93.184.216.34/a.mp4", provider: "mock", lookId: "l", groupId: "g", training: "failed", consent: "not_requested", status: "failed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } satisfies TwinJob);
    }
    let admitted = 0;
    await assert.rejects(startTwinUpload(twinUploadRequestSchema.parse(file), "u1", { admit: () => void admitted++ }), (e: unknown) => e instanceof ConflictError && /at most 10 digital twins/.test((e as Error).message));
    assert.equal(admitted, 0, "a refused upload is not counted");
  });

  it("asks HeyGen for a direct upload, finishes it, and trains from the asset; maps refusals", () =>
    inHeygen(async () => {
      const calls: Array<{ url: string; method: string; body: unknown; idem: string | null }> = [];
      let upload: Record<string, unknown> | { status: number; message: string; code?: string } = { asset_id: "asset_dana", upload_url: "https://heygen-uploads.s3.amazonaws.com/asset_dana?X-Amz-Signature=abc", upload_headers: { "Content-Type": "video/quicktime" }, expires_in_seconds: 86_400, max_bytes: MAX_TWIN_UPLOAD_BYTES, status: "pending_upload" };
      let complete: { status: number; message: string } | null = null;
      let lose = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ url, method, body, idem: new Headers(init?.headers).get("idempotency-key") });
        if (url === "https://api.heygen.com/v3/assets/direct-uploads" && method === "POST") {
          if ("status" in upload && typeof upload.status === "number") return Response.json({ error: { code: (upload as { code?: string }).code ?? "invalid_parameter", message: upload.message } }, { status: upload.status });
          return Response.json({ data: upload });
        }
        if (url === "https://api.heygen.com/v3/assets/asset_dana/complete" && method === "POST") {
          if (complete) return Response.json({ error: { code: "conflict", message: complete.message } }, { status: complete.status });
          return Response.json({ data: { asset_id: "asset_dana", url: "https://files.heygen.ai/asset_dana.mov", mime_type: "video/quicktime", size_bytes: 84_000_000, status: "processing" } });
        }
        if (url === "https://api.heygen.com/v3/avatars" && method === "POST") {
          if (lose > 0) {
            lose -= 1;
            throw new TypeError("fetch failed");
          }
          return Response.json({ data: { avatar_item: { id: "look_up", default_voice_id: "voice_up" }, avatar_group: { id: "group_up" } } });
        }
        if (url === "https://api.heygen.com/v3/avatars/looks/look_up") return Response.json({ data: { status: "processing" } });
        if (url === "https://api.heygen.com/v3/avatars/group_up") return Response.json({ data: { consent_status: null } });
        return new Response("unexpected", { status: 500 });
      }) as typeof fetch;
      assert.equal(twinUploadsAvailable(), true);
      const up = await startTwinUpload(twinUploadRequestSchema.parse(file), "u1", { key: "upload-key-1" });
      const asked = calls.find((c) => c.url.endsWith("/direct-uploads"))!;
      assert.deepEqual(asked.body, { filename: "dana-footage.mov", content_type: "video/quicktime", size_bytes: 84_000_000 });
      assert.match(asked.idem!, /^twu_[A-Za-z0-9_-]{40}$/);
      assert.deepEqual([up.url, up.headers], ["https://heygen-uploads.s3.amazonaws.com/asset_dana?X-Amz-Signature=abc", { "Content-Type": "video/quicktime" }]);
      assert.equal((await startTwinUpload(twinUploadRequestSchema.parse(file), "u1", { key: "upload-key-1" })).url, up.url);
      assert.equal(calls.filter((c) => c.url.endsWith("/direct-uploads"))[1].idem, asked.idem, "a retried upload asks with the same key");

      // HeyGen has not received the file: refused, and nothing is kept or counted.
      complete = { status: 409, message: "Uploaded object not found yet. Retry after the upload PUT returns 200." };
      let admitted = 0;
      let finished = 0;
      await assert.rejects(startTwin(start(up.token), "u1", { admit: () => void admitted++, finish: () => void finished++ }), (e: unknown) => e instanceof ValidationError && /has not finished uploading/.test((e as Error).message));
      assert.equal(finished, 1, "a finish is counted by its own limit even when refused");
      complete = { status: 404, message: "Asset not found." };
      await assert.rejects(startTwin(start(up.token), "u1"), /no longer has that upload/);
      assert.deepEqual([admitted, (await getStore().list("twin")).length], [0, 0]);

      // Finished, then trained from the asset with the twin's id as the key.
      complete = null;
      const job = await startTwin(start(up.token), "u1", { admit: () => void admitted++ });
      assert.equal(admitted, 1);
      assert.ok(calls.some((c) => c.url.endsWith("/v3/assets/asset_dana/complete")));
      const post = calls.find((c) => c.url.endsWith("/v3/avatars") && c.method === "POST")!;
      assert.deepEqual(post.body, { type: "digital_twin", name: "Dana Ruiz", file: { type: "asset_id", asset_id: "asset_dana" } });
      assert.equal(post.idem, job.id);
      assert.deepEqual([job.footageAssetId, job.lookId], ["asset_dana", "look_up"]);

      // An answer lost on the way back is asked for again from the same asset.
      lose = 1;
      await assert.rejects(startTwin(start(up.token, { name: "Dana again" }), "u1"), /fetch failed/);
      const lost = (await getStore().list<TwinJob>("twin", "u1")).find((t) => t.name === "Dana again")!;
      await getStore().put("twin", { ...lost, createdAt: new Date(realNow() - 3 * 60 * 1000).toISOString() });
      forgetTwinChecks();
      await listTwins("u1");
      const resent = calls.filter((c) => c.url.endsWith("/v3/avatars") && c.method === "POST").at(-1)!;
      assert.deepEqual([resent.idem, resent.body], [lost.id, { type: "digital_twin", name: "Dana again", file: { type: "asset_id", asset_id: "asset_dana" } }]);

      // A token made with another renderer is not this one's.
      const { config } = await import("../config");
      Object.assign(config, { avatarProvider: "mock" });
      const demo = await startTwinUpload(twinUploadRequestSchema.parse(file), "u1");
      Object.assign(config, { avatarProvider: "heygen" });
      await assert.rejects(startTwin(start(demo.token), "u1"), /not this account's/);

      // HeyGen refusing the file is the account's to change; a link that is not https is never handed to the browser.
      upload = { status: 400, message: "content_type video/quicktime is not supported" };
      await assert.rejects(startTwinUpload(twinUploadRequestSchema.parse(file), "u1"), (e: unknown) => e instanceof ValidationError && /will not take that file: content_type video\/quicktime is not supported/.test((e as Error).message));
      upload = { status: 409, code: "conflict", message: "Idempotency-Key reused with a different request." };
      await assert.rejects(startTwinUpload(twinUploadRequestSchema.parse(file), "u1"), (e: unknown) => e instanceof ValidationError && /already begun for another file/.test((e as Error).message));
      upload = { status: 409, code: "request_in_progress", message: "in progress" };
      await assert.rejects(startTwinUpload(twinUploadRequestSchema.parse(file), "u1"), ConflictError);
      upload = { status: 403, message: "This API key cannot upload assets." };
      await assert.rejects(startTwinUpload(twinUploadRequestSchema.parse(file), "u1"), /refused uploads for the studio's key/);
      upload = { asset_id: "asset_x", upload_url: "http://heygen-uploads.s3.amazonaws.com/x", upload_headers: {}, expires_in_seconds: 60 };
      await assert.rejects(startTwinUpload(twinUploadRequestSchema.parse(file), "u1"), /not https/);
    }));
});
