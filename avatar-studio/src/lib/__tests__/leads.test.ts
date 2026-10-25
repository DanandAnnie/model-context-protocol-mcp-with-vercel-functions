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
});
