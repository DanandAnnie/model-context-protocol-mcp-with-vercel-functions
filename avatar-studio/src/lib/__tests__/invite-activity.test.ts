import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityArea, activityRows, describeActivity, hideInviteAddresses } from "../activity-text";
import type { ActivityEvent } from "../types";

const base = { id: "act_1", ownerId: "ws_1", actorId: "u_1", actorEmail: "dana@example.com", createdAt: "2026-11-04T03:00:00.000Z" };
const ev = (e: Partial<ActivityEvent> & Pick<ActivityEvent, "kind">): ActivityEvent => ({ ...base, ...e });

describe("workspace invites in the activity feed", () => {
  it("words each invite event for an addressed invite, a link invite, and a batch", () => {
    assert.equal(describeActivity(ev({ kind: "invite.sent", subject: "ann@example.com", role: "viewer" }), "u_1"), `You invited "ann@example.com" as a viewer`);
    assert.equal(describeActivity(ev({ kind: "invite.sent", role: "editor" })), `dana@example.com made an editor invite link`);
    assert.equal(describeActivity(ev({ kind: "invite.sent", count: 3, role: "viewer" })), `dana@example.com invited 3 people as viewers`);
    assert.equal(describeActivity(ev({ kind: "invite.sent", count: 1, role: "owner" })), `dana@example.com invited 1 person as an owner`);
    assert.equal(describeActivity(ev({ kind: "invite.resent", subject: "ann@example.com", role: "viewer" })), `dana@example.com renewed the invite to "ann@example.com"`);
    assert.equal(describeActivity(ev({ kind: "invite.resent", role: "owner" })), `dana@example.com renewed an owner invite link`);
    assert.equal(describeActivity(ev({ kind: "invite.role", subject: "ann@example.com", role: "editor" })), `dana@example.com changed the invite to "ann@example.com" to join as an editor`);
    assert.equal(describeActivity(ev({ kind: "invite.role", role: "viewer" })), `dana@example.com changed an invite link to join as a viewer`);
    assert.equal(describeActivity(ev({ kind: "invite.revoked", subject: "ann@example.com", role: "viewer" })), `dana@example.com revoked the invite to "ann@example.com"`);
    assert.equal(describeActivity(ev({ kind: "invite.revoked", role: "editor" })), `dana@example.com revoked an editor invite link`);
  });

  it("files invites under Members and invites, in the feed and the CSV", () => {
    for (const kind of ["invite.sent", "invite.resent", "invite.role", "invite.revoked"] as const) assert.equal(activityArea(kind), "members");
    const [row] = activityRows([ev({ kind: "invite.sent", subject: "ann@example.com", role: "viewer" })]);
    assert.deepEqual([row.area, row.kind, row.what_happened], ["Members and invites", "invite.sent", `dana@example.com invited "ann@example.com" as a viewer`]);
  });

  it("hides pending invitees' addresses from readers who are not owners, without reading as a link invite", () => {
    const events = [
      ev({ id: "a", kind: "invite.sent", subject: "ann@example.com", role: "viewer" }),
      ev({ id: "b", kind: "invite.resent", subject: "ann@example.com", role: "viewer" }),
      ev({ id: "c", kind: "invite.role", subject: "ann@example.com", role: "editor" }),
      ev({ id: "d", kind: "invite.revoked", subject: "ann@example.com", role: "editor" }),
      ev({ id: "e", kind: "invite.sent", role: "editor" }),
      ev({ id: "f", kind: "invite.sent", count: 4, role: "viewer" }),
      ev({ id: "g", kind: "member.removed", subject: "bob@example.com" }),
    ];
    const hidden = hideInviteAddresses(events);
    assert.equal(JSON.stringify(hidden).includes("ann@example.com"), false, "no invitee address is left");
    assert.deepEqual(
      hidden.map((e) => describeActivity(e)),
      [
        "dana@example.com invited 1 person as a viewer",
        "dana@example.com renewed an invite",
        "dana@example.com changed an invite to join as an editor",
        "dana@example.com revoked an invite",
        "dana@example.com made an editor invite link",
        "dana@example.com invited 4 people as viewers",
        `dana@example.com removed "bob@example.com"`,
      ],
    );
    // Link invites, batches, and other kinds are left as they were; the events given are not changed.
    assert.equal(hidden[4], events[4]);
    assert.equal(hidden[5], events[5]);
    assert.equal(hidden[6], events[6]);
    assert.equal(events[0].subject, "ann@example.com");
  });
});
