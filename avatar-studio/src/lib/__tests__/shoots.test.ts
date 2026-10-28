// Photo shoots (HeyGen Image): photos of one person, their face kept from a few photos of them, in the pose,
// clothing, light, and setting of one scene picture. What is accepted, what HeyGen is asked, how shoots are followed,
// and what the account sees and exports.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_SHOOTS, deleteShoot, exportOwnerData, forgetShootChecks, listShoots, publicShoot, shootRequestSchema, startShoot } from "../services";
import { ConflictError, UpstreamError, ValidationError } from "../errors";
import { providerStatus } from "../providers";
import { getStore } from "../store";
import type { ShootJob } from "../types";

const png = (...extra: number[]) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]).toString("base64")}`;
const jpeg = (...extra: number[]) => `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...extra]).toString("base64")}`;
const ask = (extra: Record<string, unknown> = {}) => shootRequestSchema.parse({ identity: [png(1)], reference: jpeg(1), consent: true, ...extra });
const first = (extra: Record<string, unknown>) => shootRequestSchema.safeParse({ identity: [png(1)], reference: jpeg(1), consent: true, ...extra }).error?.issues[0]?.message;

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  forgetShootChecks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("photo shoots", () => {
  it("take 1 to 5 photos of the person, one scene picture, the person's consent, a shape, 1 to 5 photos, and a seed", () => {
    assert.match(first({ consent: undefined })!, /right to use this person's face/);
    assert.match(first({ consent: false })!, /right to use this person's face/);
    assert.match(first({ identity: [] })!, /Add a photo of the person/);
    assert.match(first({ identity: undefined })!, /Add a photo of the person/);
    assert.match(first({ identity: [png(1), png(2), png(3), png(4), png(5), png(6)] })!, /at most 5 photos of the person/);
    assert.ok(ask({ identity: [png(1), png(2), png(3), png(4), png(5)] }));
    assert.equal(first({ reference: undefined }) !== undefined, true, "a scene picture is needed");
    assert.match(first({ references: [jpeg(1)] })!, /references/, "unknown fields, a list of scenes among them, are refused");
    assert.match(first({ aspect: "21:9" })!, /one of 1:1, 2:3/);
    assert.equal(ask({ aspect: "4:5" }).aspect, "4:5");
    assert.equal(ask().aspect, undefined, "without a shape the photos follow the scene picture");
    assert.equal(ask().count, 1);
    assert.match(first({ count: 6 })!, /at most 5 photos/);
    assert.match(first({ count: 0 })!, /at least one photo/);
    assert.match(first({ count: 2.5 })!, /whole number/);
    assert.match(first({ count: "2" })!, /whole number/);
    assert.equal(ask({ seed: 4_294_967_295 }).seed, 4_294_967_295);
    assert.match(first({ seed: -1 })!, /0 or more/);
    assert.match(first({ seed: 4_294_967_296 })!, /at most 4294967295/);
    // A picture over 500 KB is named.
    const big = `data:image/png;base64,${"A".repeat(Math.ceil((500 * 1024 * 4) / 3) + 200)}`;
    // The one message the page shows names the photo, even beside another mistake.
    assert.equal(first({ identity: [png(1), big] }), "Photo 2 of the person must be at most 500 KB");
    assert.equal(first({ identity: [big] }), "The photo of the person must be at most 500 KB");
    assert.equal(shootRequestSchema.safeParse({ identity: [png(1), big], reference: jpeg(1) }).error!.issues[0].message, "Photo 2 of the person must be at most 500 KB");
    assert.match(first({ reference: big })!, /scene picture must be at most 500 KB/);
    // A request with several mistakes leads with the picture's; each message is the studio's own.
    assert.equal(first({ identity: [png(1), big], title: "x".repeat(121) }), "Photo 2 of the person must be at most 500 KB");
    assert.equal(first({ title: "x".repeat(121) }), "A title is at most 120 characters");
    assert.deepEqual(shootRequestSchema.safeParse({ identity: "abcdefgh", reference: jpeg(1), consent: true }).error!.issues.map((i) => i.message), ["Add a photo of the person"], "a list that is not one gets one message");
  });

  it("are made in demo mode, followed until ready, and kept private", async () => {
    assert.equal(providerStatus().photoShoots, true);
    const job = await startShoot(ask({ identity: [png(1), png(2)], count: 3, aspect: "4:5", seed: 40 }), "u1");
    assert.match(job.id, /^sh_/);
    assert.deepEqual([job.status, job.identityCount, job.count, job.aspect, job.seed, job.title], ["processing", 2, 3, "4:5", 40, "Photo shoot, 3 photos"]);
    const view = publicShoot(job);
    assert.deepEqual(["ownerId", "provider", "providerJobId", "pictureDigest"].filter((k) => k in view), [], "the renderer, its job, and the pictures' digest stay on the server");
    assert.equal((await listShoots("u1"))[0].status, "processing", "the demo takes a few seconds");
    await getStore().put("shoot", { ...job, providerJobId: `mocksh_${Date.now() - 10_000}_3_40_5` });
    forgetShootChecks();
    const [done] = await listShoots("u1");
    assert.equal(done.status, "completed");
    assert.deepEqual(
      done.photos!.map((p) => [p.width, p.height, p.seed]),
      [
        [2176, 2720, 40],
        [2176, 2720, 41],
        [2176, 2720, 42],
      ],
      "each photo in the shape asked for, its seed one more than the one before",
    );
    // The demo's drawn photos are in that shape too, so the page shows them as they will be.
    assert.match(decodeURIComponent(done.photos![0].url), /viewBox="0 0 218 272"/);
    assert.deepEqual(await listShoots("u2"), [], "another account sees none");
    await assert.rejects(deleteShoot(job.id, "u2"), /not found/i);
    const exported = JSON.stringify(await exportOwnerData("u1"));
    assert.ok(exported.includes(job.id));
    assert.equal(exported.includes("mocksh_") || exported.includes("pictureDigest"), false, "the renderer's job id and the digest are not exported");
    await deleteShoot(job.id, "u1");
    assert.deepEqual(await listShoots("u1"), []);
    await assert.rejects(deleteShoot("not-a-shoot", "u1"), (e: unknown) => (e as Error).message === "Photo shoot not found");
  });

  it("are checked to be PNG or JPEG pictures, each named when one is not", async () => {
    await assert.rejects(startShoot(ask({ identity: ["https://example.com/a.png"] }), "u1"), /The photo of the person must be an image file/);
    const gif = `data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`;
    await assert.rejects(startShoot(ask({ identity: [png(1), gif] }), "u1"), /Photo 2 of the person is not a PNG or JPEG/);
    await assert.rejects(startShoot(ask({ reference: gif }), "u1"), /The scene picture is not a PNG or JPEG/);
    assert.deepEqual(await getStore().list("shoot", "u1"), [], "nothing is stored for a refused start");
  });

  it("return the same shoot for a start retried with the same key, and refuse the key for another shoot", async () => {
    const one = await startShoot(ask({ identity: [png(1), png(2)] }), "u1", { key: "key-shoot-1" });
    assert.equal((await startShoot(ask({ identity: [png(1), png(2)] }), "u1", { key: "key-shoot-1" })).id, one.id);
    await assert.rejects(startShoot(ask({ identity: [png(2), png(1)] }), "u1", { key: "key-shoot-1" }), ConflictError, "the photos in another order");
    await assert.rejects(startShoot(ask({ identity: [png(1), png(2)], reference: jpeg(2) }), "u1", { key: "key-shoot-1" }), ConflictError, "another scene");
    await assert.rejects(startShoot(ask({ identity: [png(1), png(2)], count: 2 }), "u1", { key: "key-shoot-1" }), ConflictError, "more photos");
    await assert.rejects(startShoot(ask({ identity: [png(1), png(2)], seed: 7 }), "u1", { key: "key-shoot-1" }), ConflictError, "a seed");
    await assert.rejects(startShoot(ask({ identity: [png(1), png(2)], aspect: "1:1" }), "u1", { key: "key-shoot-1" }), ConflictError, "a shape");
    // The same key from another account is another shoot.
    assert.notEqual((await startShoot(ask({ identity: [png(1), png(2)] }), "u2", { key: "key-shoot-1" })).id, one.id);
  });

  it("are capped per account, the hourly limit counted only for a start that goes ahead", async () => {
    let admitted = 0;
    const admit = () => void admitted++;
    await startShoot(ask(), "u1", { key: "key-cap-0001", admit });
    await startShoot(ask(), "u1", { key: "key-cap-0001", admit });
    assert.equal(admitted, 1, "a repeated start is not counted again");
    const job = (await getStore().list<ShootJob>("shoot", "u1"))[0];
    for (let i = 1; i < MAX_SHOOTS; i++) await getStore().put("shoot", { ...job, id: `sh_cap${i}` });
    await assert.rejects(startShoot(ask(), "u1", { admit }), /at most 50 photo shoots/);
    assert.equal(admitted, 1, "a refused start is not counted");
  });

  it("ask HeyGen Image with the pictures inline, follow the shoot, and say why one failed", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.heygenApiKey };
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; idem: string | null }> = [];
    let shoot: Record<string, unknown> = { status: "pending", images: [] };
    let refuse: { status: number; message: string; code?: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method ?? "GET", body, idem: new Headers(init?.headers).get("idempotency-key") });
      if (url === "https://api.heygen.com/v3/models/images" && init?.method === "POST") {
        if (refuse) return Response.json({ error: { code: refuse.code ?? "invalid_parameter", message: refuse.message } }, { status: refuse.status });
        return Response.json({ data: { generation_id: `gen_${calls.length}`, status: "pending" } }, { status: 202 });
      }
      if (url.startsWith("https://api.heygen.com/v3/models/images/gen_gone")) return Response.json({ error: { code: "not_found", message: "No such generation" } }, { status: 404 });
      if (url.startsWith("https://api.heygen.com/v3/models/images/")) return Response.json({ data: shoot });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.assign(config, { avatarProvider: "heygen", heygenApiKey: "hg_key" });
    try {
      const data = (url: string) => url.slice(url.indexOf(",") + 1);
      const job = await startShoot(ask({ identity: [png(1), jpeg(2)], reference: jpeg(3), aspect: "3:4", count: 2, seed: 3000 }), "u1", { key: "key-heygen-sh" });
      assert.deepEqual(calls[0].body, {
        model: "heygen-image-1",
        identity_images: [
          { type: "base64", media_type: "image/png", data: data(png(1)) },
          { type: "base64", media_type: "image/jpeg", data: data(jpeg(2)) },
        ],
        reference_images: [{ type: "base64", media_type: "image/jpeg", data: data(jpeg(3)) }],
        aspect_ratio: "3:4",
        num_images: 2,
        seed: 3000,
      });
      assert.equal(calls[0].idem, job.id, "the shoot's id is HeyGen's idempotency key");
      await startShoot(ask(), "u1");
      assert.deepEqual(Object.keys(calls[1].body!).sort(), ["identity_images", "model", "num_images", "reference_images"], "without a shape or seed, HeyGen follows the scene and picks the seed");

      // Followed until every photo is ready, then kept with their links, sizes, and seeds (only https links).
      assert.equal((await listShoots("u1")).find((s) => s.id === job.id)!.status, "processing");
      shoot = {
        status: "completed",
        images: [
          { image_id: "img_1", image_url: "https://resource2.heygen.ai/images/1.png", width: 2160, height: 2880, seed: 3000 },
          { image_id: "img_2", image_url: "http://insecure.example/2.png", width: 2160, height: 2880, seed: 3001 },
        ],
      };
      forgetShootChecks();
      const partial = (await listShoots("u1")).find((s) => s.id === job.id)!;
      assert.deepEqual([partial.status, partial.photos, partial.error], ["failed", undefined, "HeyGen finished with photos the studio cannot show; make the shoot again"], "a photo without a usable link fails the shoot rather than leaving it short");
      await getStore().put("shoot", { ...partial, status: "processing" as const });
      shoot = {
        status: "completed",
        images: [
          { image_id: "img_1", image_url: "https://resource2.heygen.ai/images/1.png", width: 2160, height: 2880, seed: 3000 },
          { image_id: "img_2", image_url: "https://resource2.heygen.ai/images/2.png", width: 2160, height: 2880, seed: 3001 },
        ],
      };
      forgetShootChecks();
      const done = (await listShoots("u1")).find((s) => s.id === job.id)!;
      assert.deepEqual([done.status, done.photos?.map((p) => p.url), done.photos?.[0].seed, done.error], ["completed", ["https://resource2.heygen.ai/images/1.png", "https://resource2.heygen.ai/images/2.png"], 3000, undefined]);

      // A failed shoot says which picture to change.
      shoot = { status: "failed", images: [], failure_code: "no_face_detected", failure_message: "identity_images[1] has no detectable face." };
      await getStore().put("shoot", { ...done, status: "processing" as const });
      forgetShootChecks();
      const failed = (await listShoots("u1")).find((s) => s.id === job.id)!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.photos, undefined, "a failed shoot keeps no photos");
      assert.equal(failed.error, "HeyGen found no face in photo 2 of the person; use a clear photo of the face", "HeyGen's place from 0 is the page's photo number");
      const failure = async (code: string, message: string | null) => {
        shoot = { status: "failed", failure_code: code, failure_message: message };
        await getStore().put("shoot", { ...failed, status: "processing" as const });
        forgetShootChecks();
        return (await listShoots("u1")).find((s) => s.id === job.id)!.error;
      };
      assert.equal(await failure("multiple_faces_detected", "reference_images[0] contains 2 faces."), "The scene picture shows more than one person; use a picture of one person");
      assert.equal(await failure("multiple_faces_detected", null), "One of the pictures shows more than one person; use pictures of one person");
      assert.equal(await failure("generation_failed", "Something went wrong."), "Something went wrong.");
      await getStore().put("shoot", { ...failed, status: "processing" as const, providerJobId: "gen_gone" });
      forgetShootChecks();
      assert.match((await listShoots("u1")).find((s) => s.id === job.id)!.error!, /no longer has this photo shoot/);

      // Refusals carry HeyGen's reason; a start still in progress is a conflict to retry; a key taken with other details is not.
      refuse = { status: 402, message: "Insufficient credits.", code: "insufficient_credit" };
      await assert.rejects(startShoot(ask({ count: 2 }), "u1"), (e: unknown) => e instanceof ValidationError && /could not make those photos: Insufficient credits\./.test((e as Error).message));
      refuse = { status: 409, message: "A request with this key is in progress." };
      await assert.rejects(startShoot(ask({ count: 2 }), "u1"), ConflictError);
      refuse = { status: 409, message: "Idempotency key reused with a different request.", code: "conflict" };
      await assert.rejects(startShoot(ask({ count: 2 }), "u1"), /already asked for with other details/);
      refuse = { status: 429, message: "Slow down." };
      await assert.rejects(startShoot(ask({ count: 2 }), "u1"), /too many photos just now/);
      // A moment's trouble at HeyGen is to be retried with the same key: said plainly, not as HeyGen's raw answer.
      refuse = { status: 503, message: "Billing is unavailable." };
      await assert.rejects(startShoot(ask({ count: 2 }), "u1"), (e: unknown) => e instanceof UpstreamError && /busy just now; try again in a moment/.test((e as Error).message));
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, heygenApiKey: saved.key });
    }
  });

  it("are not offered by a renderer without them", async () => {
    const { config } = await import("../config");
    const saved = { avatar: config.avatarProvider, key: config.didApiKey };
    Object.assign(config, { avatarProvider: "did", didApiKey: "did_key" });
    try {
      assert.equal(providerStatus().photoShoots, false);
      await assert.rejects(startShoot(ask(), "u1"), /not available with the did renderer/);
    } finally {
      Object.assign(config, { avatarProvider: saved.avatar, didApiKey: saved.key });
    }
  });
});
