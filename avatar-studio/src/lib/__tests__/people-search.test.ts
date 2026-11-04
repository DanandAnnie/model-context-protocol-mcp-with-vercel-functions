import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PEOPLE_SEARCH_FROM, peopleMatchLine, personMatches } from "../invite-text";

describe("Find a member or invite", () => {
  it("matches what a row is listed by, ignoring case and spaces around the query", () => {
    assert.equal(personMatches("ANN", "ann@example.com"), true);
    assert.equal(personMatches("  example.com ", "Ann@Example.com"), true);
    assert.equal(personMatches("link", "Link invite"), true);
    assert.equal(personMatches("u_42", "u_42"), true);
    assert.equal(personMatches("bob", "ann@example.com"), false);
    assert.equal(personMatches("", "anyone"), true, "an empty query matches all");
    assert.equal(personMatches("   ", "anyone"), true);
    assert.equal(PEOPLE_SEARCH_FROM, 6);
  });

  it("says how many of each list match, leaving out lists that are empty", () => {
    assert.equal(peopleMatchLine({ members: [2, 12], pending: [1, 3], expired: [0, 0] }, " ann "), "2 of 12 members and 1 of 3 pending invites match “ann”.");
    assert.equal(peopleMatchLine({ members: [1, 1], pending: [0, 0], expired: [0, 0] }, "ann"), "1 of 1 member matches “ann”.");
    assert.equal(peopleMatchLine({ members: [0, 4], pending: [1, 2], expired: [1, 1] }, "dan"), "0 of 4 members, 1 of 2 pending invites, and 1 of 1 expired invite match “dan”.");
    assert.equal(peopleMatchLine({ members: [0, 4], pending: [0, 2], expired: [0, 1] }, "zed"), "No member or invite matches “zed”.");
    assert.equal(peopleMatchLine({ members: [0, 1], pending: [1, 5], expired: [0, 1] }, "link"), "0 of 1 member, 1 of 5 pending invites, and 0 of 1 expired invite match “link”.");
    assert.equal(peopleMatchLine({ members: [3, 12], pending: [0, 0], expired: [0, 0] }, "a"), "3 of 12 members match “a”.");
    // A reader who is not an owner sees no invites, so the line does not speak of them.
    assert.equal(peopleMatchLine({ members: [0, 7], pending: [0, 0], expired: [0, 0] }, "zed", { invites: false }), "No member matches “zed”.");
  });
});

describe("people download", () => {
  it("lists members, then pending, then expired invites, with no invite tokens", async () => {
    const { PEOPLE_CSV_COLUMNS, peopleRows } = await import("../invite-text");
    const { parseCsv, toCsv } = await import("../csv");
    const rows = peopleRows(
      {
        members: [
          { userId: "u_1", email: "ann@example.com", role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" },
          { userId: "u_2", role: "viewer", joinedAt: "2026-10-02T00:00:00.000Z" },
        ],
        // Listed latest first here, as one store does: the file puts the soonest to expire first.
        invites: [{ role: "viewer", expiresAt: "2026-11-11T00:00:00.000Z" }, { email: "=cmd@example.com", role: "editor", expiresAt: "2026-11-10T00:00:00.000Z", token: "secret_token" } as never],
        expiredInvites: [{ email: "eve@example.com", role: "viewer", expiresAt: "2026-10-20T00:00:00.000Z" }],
      },
      { u_1: "2026-11-03T12:00:00.000Z" },
    );
    assert.deepEqual(
      rows.map((r) => [r.email, r.user_id, r.role, r.status, r.joined, r.expires, r.last_active]),
      [
        ["ann@example.com", "u_1", "owner", "member", "2026-10-01T00:00:00.000Z", "", "2026-11-03T12:00:00.000Z"],
        ["", "u_2", "viewer", "member", "2026-10-02T00:00:00.000Z", "", ""],
        ["=cmd@example.com", "", "editor", "pending invite", "", "2026-11-10T00:00:00.000Z", ""],
        ["Link invite", "", "viewer", "pending invite", "", "2026-11-11T00:00:00.000Z", ""],
        ["eve@example.com", "", "viewer", "expired invite", "", "2026-10-20T00:00:00.000Z", ""],
      ],
    );
    const csv = toCsv(PEOPLE_CSV_COLUMNS, rows);
    assert.equal(csv.includes("secret_token"), false, "an invite's token never reaches the file");
    // A cell a spreadsheet would run as a formula is defused, as in the other downloads.
    assert.equal(parseCsv(csv).rows[2].email, "'=cmd@example.com");
    assert.deepEqual(parseCsv(csv).columns, ["email", "user_id", "role", "status", "joined", "expires", "last_active"]);
  });
});
