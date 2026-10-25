// The share page's email gate: what it stores, who hears about it, and what the owner can read back.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import {
  captureVideoLead,
  createVideo,
  deleteVideo,
  exportOwnerData,
  listVideoLeads,
  queryVideos,
  updateVideo,
  videoLeadId,
  videoLeadSchema,
  videoLeadsCsv,
  videoPatchSchema,
  videoQuerySchema,
  videoRequestSchema,
} from "../services";
import { saveNotifySettings, setNotificationFetch } from "../notifications";
import { createApiKey, ownerForApiKey } from "../api-keys";
import { StripeBillingProvider, applyStripeEvent, getPlan, setBillingProvider, setPlan } from "../billing";
import { MockTtsProvider } from "../providers/tts/mock";
import { ConflictError } from "../errors";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Video, VideoLead } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

async function gatedVideo(ownerId = "u1"): Promise<Video> {
  const v = await createVideo(videoRequestSchema.parse({ title: "Open house", script: "Welcome in.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), ownerId);
  await getStore().put("video", { ...v, status: "completed" as const });
  return updateVideo(v.id, videoPatchSchema.parse({ shareGate: true }), ownerId);
}

const lead = (email: string, name?: string) => videoLeadSchema.parse({ email, ...(name ? { name } : {}) });

describe("share-page email gate", () => {
  it("is switched on and off from the video patch", async () => {
    const v = await gatedVideo();
    assert.equal(v.shareGate, true);
    assert.equal("shareGate" in (await updateVideo(v.id, videoPatchSchema.parse({ shareGate: false }), "u1")), false);
  });

  it("keeps one row per address, notifies the owner once, and counts return visits", async () => {
    const calls: string[] = [];
    setNotificationFetch(async (_input, init) => {
      calls.push(String(init?.body));
      return new Response("ok", { status: 200 });
    });
    try {
      await saveNotifySettings({ url: "https://203.0.113.5/hooks/studio" }, "u1");
      const v = await gatedVideo();
      const first = await captureVideoLead(v, lead("  Sam@Example.com "));
      assert.equal(first.first, true);
      assert.equal(first.lead.email, "sam@example.com", "trimmed and lower-cased");
      const again = await captureVideoLead(v, lead("SAM@example.com", "Sam"));
      assert.deepEqual([again.first, again.lead.visits, again.lead.name, again.lead.createdAt], [false, 2, "Sam", first.lead.createdAt]);
      assert.equal(again.lead.id, videoLeadId(v.id, "sam@example.com"));
      assert.equal(calls.length, 1, "a returning viewer is not a new lead");
      const body = JSON.parse(calls[0]);
      assert.equal(body.event, "lead.captured");
      assert.deepEqual([body.data.source, body.data.videoId, body.data.videoTitle, body.data.email], ["share", v.id, "Open house", "sam@example.com"]);
    } finally {
      setNotificationFetch(null);
    }
  });

  it("refuses a video that does not ask, and lists leads only to the video's owner", async () => {
    const v = await gatedVideo();
    await captureVideoLead(v, lead("a@example.com"));
    await captureVideoLead(v, lead("b@example.com"));
    const open = await updateVideo(v.id, videoPatchSchema.parse({ shareGate: false }), "u1");
    await assert.rejects(captureVideoLead(open, lead("c@example.com")), /does not ask/);
    assert.deepEqual((await listVideoLeads(v.id, "u1")).map((l) => l.email).sort(), ["a@example.com", "b@example.com"], "turning the gate off keeps what it collected");
    await assert.rejects(listVideoLeads(v.id, "someone-else"), /not found/);
    assert.equal(videoLeadSchema.safeParse({ email: "not-an-email" }).success, false);
  });

  it("writes a CSV a spreadsheet will not run, stays off library cards, exports, and goes with the video", async () => {
    const v = await gatedVideo();
    await captureVideoLead(v, lead("eve@example.com", "=HYPERLINK(\"https://evil.test\")"));
    const csv = videoLeadsCsv(await listVideoLeads(v.id, "u1"));
    assert.match(csv, /^\uFEFF?"email","name","first_seen","last_seen","visits"\r\n/, "the header row, after the byte-order mark spreadsheets read UTF-8 by");
    assert.match(csv, /'=HYPERLINK/, "a formula is defused");
    const { videos } = await queryVideos("u1", videoQuerySchema.parse({}));
    assert.equal(videos.find((x) => x.id === v.id)?.shareGate, true);
    assert.equal((await exportOwnerData("u1")).videolead.length, 1);
    await deleteVideo(v.id, "u1");
    assert.equal((await getStore().list<VideoLead>("videolead", "u1")).length, 1, "the trash keeps them while the video can come back");
    await deleteVideo(v.id, "u1", true);
    assert.deepEqual(await getStore().list<VideoLead>("videolead", "u1"), [], "deleting the video for good removes its leads");
  });

  it("goes, with everything else a workspace owns, when the workspace is deleted", async () => {
    const { createWorkspace, deleteWorkspace } = await import("../workspaces");
    const { deleteOwnerData } = await import("../services");
    const alice = { id: "user_alice", email: "alice@example.com" };
    const ws = await createWorkspace("Acme", alice);
    const v = await gatedVideo(ws.id);
    await captureVideoLead(v, lead("viewer@example.com"));
    const mine = await gatedVideo(alice.id);
    // Only an owner may delete, and a refused attempt removes nothing.
    await assert.rejects(deleteWorkspace(ws.id, { id: "user_bob" }, deleteOwnerData), /not found/);
    assert.equal((await getStore().list<VideoLead>("videolead", ws.id)).length, 1);
    await deleteWorkspace(ws.id, alice, deleteOwnerData);
    assert.deepEqual(await getStore().list<VideoLead>("videolead", ws.id), []);
    assert.equal(await getStore().get("video", v.id), null);
    assert.ok(await getStore().get("video", mine.id), "the owner's personal space is untouched");
  });

  it("is refused while a Stripe plan still renews, and clears rows past a store's listing cap", async () => {
    const { createWorkspace, deleteWorkspace } = await import("../workspaces");
    const { deleteOwnerData } = await import("../services");
    // A store that, like Supabase's API, returns only so many rows per listing.
    class CappedStore extends MemoryStore {
      async list<T>(kind: Parameters<MemoryStore["list"]>[0], ownerId?: string): Promise<T[]> {
        return (await super.list<T>(kind, ownerId)).slice(0, 2);
      }
    }
    globalThis.__avatarStudioStore = new CappedStore();
    const alice = { id: "user_alice", email: "alice@example.com" };
    const ws = await createWorkspace("Acme", alice);
    const v = await gatedVideo(ws.id);
    for (const n of [1, 2, 3, 4, 5]) await captureVideoLead(v, lead(`viewer${n}@example.com`));
    const { secret } = await createApiKey("CI", ws.id, alice.id);
    await setPlan(ws.id, { plan: "pro", provider: "stripe", status: "active", customerId: "cus_1", subscriptionId: "sub_1" });
    await assert.rejects(deleteWorkspace(ws.id, alice, deleteOwnerData), /Stripe subscription can still bill/);
    assert.ok(await getStore().get("workspace", ws.id), "a refused delete keeps the workspace");
    assert.ok(await getStore().get("video", v.id));
    assert.equal(await ownerForApiKey(secret), ws.id, "and its keys keep working");
    // Once cancelled (it runs to the end of the period), the delete goes ahead and takes every lead.
    await setPlan(ws.id, { plan: "pro", provider: "stripe", status: "active", endsAt: "2030-01-01T00:00:00.000Z" });
    await deleteWorkspace(ws.id, alice, deleteOwnerData);
    assert.equal(await getStore().get("workspace", ws.id), null);
    assert.deepEqual(await getStore().list<VideoLead>("videolead", ws.id), [], "five leads gone, two per listing");
  });

  it("asks Stripe about every subscription of the customer before deciding", async () => {
    const { deleteOwnerData } = await import("../services");
    const subs: { status: string; cancel_at_period_end?: boolean }[] = [];
    let failure: { status: number; code: string; message: string } | null = null;
    const urls: string[] = [];
    let hasMore = false;
    setBillingProvider(new StripeBillingProvider("sk_test", "price_pro"));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(`${init?.method} ${String(input)}`);
      if (failure) return new Response(JSON.stringify({ error: failure }), { status: failure.status });
      return new Response(JSON.stringify({ data: subs, has_more: hasMore }), { status: 200 });
    }) as typeof fetch;
    try {
      // The stored plan says Pro and renewing, but Stripe has it cancelled: a missed webhook does not block.
      await setPlan("u1", { plan: "pro", provider: "stripe", status: "active", customerId: "cus_1", subscriptionId: "sub_1" });
      subs.push({ status: "active", cancel_at_period_end: true }, { status: "canceled" });
      await deleteOwnerData("u1");
      assert.deepEqual(urls, ["GET https://api.stripe.com/v1/subscriptions?customer=cus_1&status=all&limit=100"]);
      // The stored plan says Free (the webhook downgraded an unpaid subscription), but Stripe still bills it.
      await setPlan("u1", { plan: "free", provider: "stripe", customerId: "cus_1" });
      for (const blocking of [{ status: "unpaid" }, { status: "incomplete" }, { status: "past_due" }]) {
        subs.splice(0, subs.length, blocking);
        await assert.rejects(deleteOwnerData("u1"), /Stripe subscription can still bill/, blocking.status);
      }
      // One scheduled to stop (`cancel_at`) does not block; a full page with more behind it is not taken as checked.
      subs.splice(0, subs.length, { status: "active", cancel_at: 1900000000 } as { status: string });
      await deleteOwnerData("u1");
      await setPlan("u1", { plan: "free", provider: "stripe", customerId: "cus_1" });
      subs.splice(0, subs.length, { status: "canceled" });
      hasMore = true;
      await assert.rejects(deleteOwnerData("u1"), /Could not check the subscription/);
      hasMore = false;
      // A customer Stripe no longer has cannot be billed.
      failure = { status: 404, code: "resource_missing", message: "No such customer: 'cus_1'" };
      await deleteOwnerData("u1");
      // A test-mode customer looked up with a live key can never bill real money.
      await setPlan("u1", { plan: "free", provider: "stripe", customerId: "cus_1" });
      failure = { status: 400, code: "resource_missing", message: "No such customer: 'cus_1'; a similar object exists in test mode, but a live mode key was used to make this request." };
      await deleteOwnerData("u1");
      // A live customer looked up with a test key may be billing, and an outage says nothing either.
      await setPlan("u1", { plan: "free", provider: "stripe", customerId: "cus_1" });
      failure = { status: 400, code: "resource_missing", message: "No such customer: 'cus_1'; a similar object exists in live mode, but a test mode key was used to make this request." };
      await assert.rejects(deleteOwnerData("u1"), /Could not check the subscription/);
      failure = { status: 500, code: "api_error", message: "Something went wrong" };
      await assert.rejects(deleteOwnerData("u1"), /Could not check the subscription/);
      assert.ok(await getStore().get("plan", "plan_u1"), "a refusal deletes nothing");
    } finally {
      globalThis.fetch = realFetch;
      setBillingProvider(undefined);
    }
  });

  it("reads when a cancelled subscription ends from current Stripe events, and leaves deleted workspaces alone", async () => {
    const sub = (extra: Record<string, unknown>, ownerId = "u9") => ({ type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "active", metadata: { ownerId }, ...extra } } });
    await applyStripeEvent(sub({ cancel_at_period_end: true, items: { data: [{ current_period_end: 1800000000 }] } }));
    assert.equal((await getPlan("u9")).endsAt, new Date(1800000000 * 1000).toISOString(), "the period end moved onto the items in 2025");
    await applyStripeEvent(sub({ cancel_at: 1700000000 }));
    assert.equal((await getPlan("u9")).endsAt, new Date(1700000000 * 1000).toISOString());
    await applyStripeEvent(sub({}));
    assert.equal((await getPlan("u9")).endsAt, undefined, "renewing again clears the date");
    assert.equal(await applyStripeEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "canceled", metadata: { ownerId: "ws_gone" } } } }), null);
    assert.equal(await getStore().get("plan", "plan_ws_gone"), null, "no plan row comes back for a deleted workspace");
    // A checkout that completes after its workspace went is still recorded, so the ids Stripe bills are kept.
    assert.equal(await applyStripeEvent({ type: "checkout.session.completed", data: { object: { client_reference_id: "ws_gone", customer: "cus_9", subscription: "sub_9" } } }), "ws_gone");
    assert.equal((await getPlan("ws_gone")).customerId, "cus_9");
  });

  it("stops before deleting any content when a cloned voice cannot be removed, keeping its row for the retry", async () => {
    const { deleteOwnerData } = await import("../services");
    const v = await gatedVideo();
    const { secret } = await createApiKey("CI", "u1");
    await getStore().put("voice", { id: "clone_1", name: "Me", provider: "mock", source: "custom", ownerId: "u1" });
    const original = MockTtsProvider.prototype.deleteVoice;
    let failWith: number | null = 401;
    const asked: string[] = [];
    (MockTtsProvider.prototype as { deleteVoice: (id: string) => Promise<void> }).deleteVoice = async (id: string) => {
      asked.push(id);
      if (failWith) throw Object.assign(new Error(`voice delete failed: ${failWith}`), { status: failWith });
    };
    try {
      await assert.rejects(deleteOwnerData("u1"), (err: Error) => err instanceof ConflictError && /would not delete the cloned voice "Me" \(401\)\. Any API keys were already removed/.test(err.message));
      assert.equal(await ownerForApiKey(secret), null, "keys go first, and the message says so");
      assert.ok(await getStore().get("video", v.id), "the videos are kept");
      assert.ok(await getStore().get("voice", "clone_1"), "and the voice row, so the clone's id is not lost");
      failWith = null;
      const counts = await deleteOwnerData("u1");
      assert.deepEqual([counts.voice, counts.video], [1, 1]);
      assert.deepEqual(asked, ["clone_1", "clone_1"]);
      assert.equal(await getStore().get("video", v.id), null);
    } finally {
      MockTtsProvider.prototype.deleteVoice = original;
    }
  });

  it("treats a voice ElevenLabs no longer has as deleted, whichever way it says so", async () => {
    const { ElevenLabsTtsProvider } = await import("../providers/tts/elevenlabs");
    const answers = [
      new Response("", { status: 404 }),
      new Response(JSON.stringify({ detail: { status: "voice_not_found", message: "A voice with the voice_id does not exist." } }), { status: 400 }),
      new Response(JSON.stringify({ detail: { status: "invalid_api_key" } }), { status: 401 }),
      new Response(JSON.stringify({ detail: { status: "voice_cannot_be_deleted", message: "Not voice_not_found: this one stays." } }), { status: 400 }),
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => answers.shift()!) as typeof fetch;
    try {
      const el = new ElevenLabsTtsProvider("key");
      await el.deleteVoice("v1");
      await el.deleteVoice("v2");
      await assert.rejects(el.deleteVoice("v3"), (err: Error & { status?: number }) => err.status === 401);
      await assert.rejects(el.deleteVoice("v4"), (err: Error & { status?: number }) => err.status === 400, "a mention in the message is not the status");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("asks Stripe once for a workspace delete, before the keys are revoked", async () => {
    const { createWorkspace, deleteWorkspace } = await import("../workspaces");
    const { deleteOwnerData } = await import("../services");
    const alice = { id: "user_alice", email: "alice@example.com" };
    const ws = await createWorkspace("Acme", alice);
    await setPlan(ws.id, { plan: "free", provider: "stripe", customerId: "cus_ws" });
    const { secret } = await createApiKey("CI", ws.id, alice.id);
    let calls = 0;
    const keyDuringLookup: (string | null)[] = [];
    setBillingProvider(
      Object.assign(new StripeBillingProvider("sk_test", "price_pro"), {
        customerRenews: async () => {
          calls++;
          keyDuringLookup.push(await ownerForApiKey(secret));
          return false;
        },
      }),
    );
    try {
      await deleteWorkspace(ws.id, alice, (id) => deleteOwnerData(id, { billingChecked: true }));
      assert.equal(calls, 1);
      assert.deepEqual(keyDuringLookup, [ws.id], "the keys still worked while Stripe was asked");
      assert.equal(await ownerForApiKey(secret), null);
      assert.equal(await getStore().get("workspace", ws.id), null);
    } finally {
      setBillingProvider(undefined);
    }
  });

  it("leaves a Stripe-billed plan alone under demo billing", async () => {
    const { MockBillingProvider } = await import("../billing");
    await setPlan("u1", { plan: "pro", provider: "stripe", status: "active", customerId: "cus_1", subscriptionId: "sub_1" });
    const demo = new MockBillingProvider();
    await assert.rejects(demo.portal("u1", "/settings"), /billed through Stripe/);
    await assert.rejects(demo.checkout("u1", "/settings"), /billed through Stripe/);
    assert.deepEqual([(await getPlan("u1")).provider, (await getPlan("u1")).customerId], ["stripe", "cus_1"]);
    await demo.checkout("u2", "/settings");
    assert.equal((await getPlan("u2")).plan, "pro", "a demo account still upgrades instantly");
    // A Stripe plan with no customer yet (its subscription event came before the checkout one) is left alone too.
    await setPlan("u3", { plan: "pro", provider: "stripe", status: "active", subscriptionId: "sub_3" });
    await assert.rejects(demo.portal("u3", "/settings"), /billed through Stripe/);
    assert.equal((await getPlan("u3")).subscriptionId, "sub_3");
    // And a subscription event that names the customer records it.
    await applyStripeEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_3", status: "active", customer: "cus_3", metadata: { ownerId: "u3" } } } });
    assert.equal((await getPlan("u3")).customerId, "cus_3");
  });

  it("cancels at Stripe a subscription bought for a workspace deleted mid-checkout, retrying until it goes", async () => {
    // A store every instance shares; the in-memory one is not trusted to say a workspace is gone.
    class DurableStore extends MemoryStore {
      readonly durable = true;
    }
    globalThis.__avatarStudioStore = new DurableStore();
    const calls: { method?: string; url: string; body?: unknown; headers?: Record<string, string> }[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { id: "sub_9", status: "canceled" } };
    setBillingProvider(new StripeBillingProvider("sk_test", "price_pro"));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method, url: String(input), body: init?.body, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch;
    const down = { status: 500, body: { error: { message: "Stripe is down", code: "api_error" } } };
    const ok = { status: 200, body: { id: "sub_9", status: "canceled" } };
    const checkout = { type: "checkout.session.completed", data: { object: { client_reference_id: "ws_gone", customer: "cus_9", subscription: "sub_9" } } };
    const renewing = (id: string) => ({ type: "customer.subscription.updated", data: { object: { id, status: "active", metadata: { ownerId: "ws_gone" } } } });
    try {
      // Stripe down: the ids are kept and the event fails, so Stripe sends it again.
      answer = down;
      await assert.rejects(applyStripeEvent(checkout), /Stripe is down/);
      assert.equal((await getPlan("ws_gone")).subscriptionId, "sub_9", "the ids are recorded while the cancellation is owed");
      // The retry cancels it and takes the recorded ids away with it.
      answer = ok;
      calls.length = 0;
      assert.equal(await applyStripeEvent(checkout), null);
      assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["DELETE https://api.stripe.com/v1/subscriptions/sub_9"]);
      assert.equal(calls[0].body, undefined, "a DELETE carries no body");
      assert.deepEqual(calls[0].headers, { Authorization: "Bearer sk_test" });
      assert.equal(await getStore().get("plan", "plan_ws_gone"), null);
      // A subscription Stripe no longer has counts as cancelled; a live one behind a test key does not.
      answer = { status: 404, body: { error: { code: "resource_missing", message: "No such subscription: 'sub_9'" } } };
      assert.equal(await applyStripeEvent(checkout), null);
      answer = { status: 404, body: { error: { code: "resource_missing", message: "No such subscription: 'sub_9'; a similar object exists in live mode, but a test mode key was used" } } };
      await assert.rejects(applyStripeEvent(checkout), /exists in live mode/);
      await getStore().remove("plan", "plan_ws_gone");
      // With the checkout event missed, a renewing subscription event cancels it too and fails for a retry when it cannot.
      answer = down;
      await assert.rejects(applyStripeEvent(renewing("sub_10")), /Stripe is down/);
      answer = ok;
      calls.length = 0;
      await applyStripeEvent(renewing("sub_10"));
      await applyStripeEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_11", status: "canceled", metadata: { ownerId: "ws_gone" } } } });
      await applyStripeEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_10", status: "canceled", metadata: { ownerId: "ws_gone" } } } });
      assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["DELETE https://api.stripe.com/v1/subscriptions/sub_10"], "final events are left alone");
      assert.equal(await getStore().get("plan", "plan_ws_gone"), null);
      // A live workspace's checkout is recorded as before, with no call to Stripe.
      const { createWorkspace } = await import("../workspaces");
      const ws = await createWorkspace("Acme", { id: "user_alice", email: "alice@example.com" });
      calls.length = 0;
      await applyStripeEvent({ type: "checkout.session.completed", data: { object: { client_reference_id: ws.id, customer: "cus_1", subscription: "sub_1" } } });
      assert.deepEqual([calls.length, (await getPlan(ws.id)).plan], [0, "pro"]);
      // An in-memory store (another instance may hold the workspace) never cancels; the checkout is recorded instead.
      globalThis.__avatarStudioStore = new MemoryStore();
      calls.length = 0;
      await applyStripeEvent(checkout);
      await applyStripeEvent(renewing("sub_12"));
      assert.deepEqual([calls.length, (await getPlan("ws_gone")).subscriptionId], [0, "sub_9"]);
    } finally {
      globalThis.fetch = realFetch;
      setBillingProvider(undefined);
    }
  });
});
