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
import { MockBillingProvider, applyStripeEvent, getPlan, setBillingProvider, setPlan } from "../billing";
import { MockTtsProvider } from "../providers/tts/mock";
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
    await assert.rejects(deleteWorkspace(ws.id, alice, deleteOwnerData), /Cancel the Pro plan/);
    assert.ok(await getStore().get("workspace", ws.id), "a refused delete keeps the workspace");
    assert.ok(await getStore().get("video", v.id));
    assert.equal(await ownerForApiKey(secret), ws.id, "and its keys keep working");
    // Once cancelled (it runs to the end of the period), the delete goes ahead and takes every lead.
    await setPlan(ws.id, { plan: "pro", provider: "stripe", status: "active", endsAt: "2030-01-01T00:00:00.000Z" });
    await deleteWorkspace(ws.id, alice, deleteOwnerData);
    assert.equal(await getStore().get("workspace", ws.id), null);
    assert.deepEqual(await getStore().list<VideoLead>("videolead", ws.id), [], "five leads gone, two per listing");
  });

  it("asks Stripe before refusing, so a cancellation whose webhook was missed does not block", async () => {
    const { deleteOwnerData } = await import("../services");
    await setPlan("u1", { plan: "pro", provider: "stripe", status: "active", subscriptionId: "sub_gone" });
    const asked: string[] = [];
    const stripe = Object.assign(new MockBillingProvider(), {
      name: "stripe",
      subscriptionRenews: async (plan: { subscriptionId?: string }) => {
        asked.push(plan.subscriptionId ?? "");
        return asked.length > 1 ? false : true;
      },
    });
    setBillingProvider(stripe);
    try {
      await assert.rejects(deleteOwnerData("u1"), /Cancel the Pro plan/, "Stripe says it still renews");
      await deleteOwnerData("u1");
      assert.deepEqual(asked, ["sub_gone", "sub_gone"]);
      stripe.subscriptionRenews = async () => {
        throw new Error("Stripe is down");
      };
      await setPlan("u1", { plan: "pro", provider: "stripe", status: "active", subscriptionId: "sub_2" });
      await assert.rejects(deleteOwnerData("u1"), /Cancel the Pro plan/, "an unanswered lookup is treated as still renewing");
    } finally {
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
  });

  it("stops before deleting anything when a cloned voice cannot be removed yet, and moves on when it never can", async () => {
    const { deleteOwnerData } = await import("../services");
    const v = await gatedVideo();
    await getStore().put("voice", { id: "clone_1", name: "Me", provider: "mock", source: "custom", ownerId: "u1" });
    const original = MockTtsProvider.prototype.deleteVoice;
    let status = 503;
    MockTtsProvider.prototype.deleteVoice = async () => {
      throw Object.assign(new Error(`voice delete failed: ${status}`), { status });
    };
    try {
      await assert.rejects(deleteOwnerData("u1"), /503/);
      assert.ok(await getStore().get("video", v.id), "a passing failure stops the run before the videos go");
      assert.ok(await getStore().get("voice", "clone_1"), "and keeps the row so a retry finds the clone");
      status = 401;
      const counts = await deleteOwnerData("u1");
      assert.equal(counts.voiceLeftAtProvider, 1, "a refusal that will not change is reported, not retried for ever");
      assert.equal(await getStore().get("video", v.id), null);
    } finally {
      MockTtsProvider.prototype.deleteVoice = original;
    }
  });
});
