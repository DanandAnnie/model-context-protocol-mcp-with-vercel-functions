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

describe("member sort", () => {
  it("orders by role, name, last active, or newest joined, falling back to name then join time", async () => {
    const { MEMBER_SORTS, memberSortFrom, sortMembers } = await import("../invite-text");
    const m = (userId: string, role: string, joinedAt: string, email?: string) => ({ userId, role, joinedAt, email });
    const members = [
      m("u1", "viewer", "2026-10-01T00:00:00.000Z", "zoe@example.com"),
      m("u2", "owner", "2026-09-01T00:00:00.000Z", "Bea@example.com"),
      m("u3", "editor", "2026-10-03T00:00:00.000Z", "amy@example.com"),
      m("u4", "owner", "2026-10-02T00:00:00.000Z", "al@example.com"),
      m("u5", "editor", "2026-10-04T00:00:00.000Z"),
    ];
    const names = (sort: Parameters<typeof sortMembers>[1], last?: Record<string, string>) => sortMembers(members, sort, last).map((x) => x.email ?? x.userId);
    assert.deepEqual(names("role"), ["al@example.com", "Bea@example.com", "amy@example.com", "u5", "zoe@example.com"]);
    assert.deepEqual(names("name"), ["al@example.com", "amy@example.com", "Bea@example.com", "u5", "zoe@example.com"]);
    assert.deepEqual(names("joined"), ["u5", "amy@example.com", "al@example.com", "zoe@example.com", "Bea@example.com"]);
    assert.deepEqual(
      names("active", { u1: "2026-11-03T00:00:00.000Z", u3: "2026-11-04T00:00:00.000Z" }),
      ["amy@example.com", "zoe@example.com", "al@example.com", "Bea@example.com", "u5"],
      "most recent first; those with nothing kept by name",
    );
    assert.deepEqual(names("active"), names("name"), "with nothing kept, last active reads as by name");
    assert.equal(members[0].userId, "u1", "the list given is not reordered");
    assert.deepEqual(MEMBER_SORTS, ["role", "name", "active", "joined"]);
    assert.equal(memberSortFrom("joined"), "joined");
    assert.equal(memberSortFrom(null), "role");
    assert.equal(memberSortFrom("oldest"), "role");
  });
});

describe("member order while editing", () => {
  it("waits for the last-active times before showing that order, and keeps rows in place while only details change", async () => {
    const { shownMemberSort, steadyMembers } = await import("../invite-text");
    assert.equal(shownMemberSort("active", false), "role", "no times yet: owners first");
    assert.equal(shownMemberSort("active", true), "active");
    assert.equal(shownMemberSort("name", false), "name", "other orders need nothing");
    const m = (userId: string, role: string, email: string) => ({ userId, role, email, joinedAt: "2026-10-01T00:00:00.000Z" });
    const first = steadyMembers(null, [m("a", "editor", "amy@x.com"), m("b", "owner", "bea@x.com")], "role");
    assert.deepEqual(first.members.map((x) => x.userId), ["b", "a"]);
    // Amy is made an owner: the same people under the same sort keep their places, with the fresh details.
    const edited = steadyMembers(first.order, [m("a", "owner", "amy@x.com"), m("b", "owner", "bea@x.com")], "role");
    assert.deepEqual(edited.members.map((x) => [x.userId, x.role]), [["b", "owner"], ["a", "owner"]]);
    assert.equal(edited.order, first.order);
    // A new sort, or someone joining or leaving, sorts afresh.
    assert.deepEqual(steadyMembers(edited.order, [m("a", "owner", "amy@x.com"), m("b", "owner", "bea@x.com")], "name").members.map((x) => x.userId), ["a", "b"]);
    const joined = steadyMembers(edited.order, [m("a", "owner", "amy@x.com"), m("b", "owner", "bea@x.com"), m("c", "owner", "al@x.com")], "role");
    assert.deepEqual(joined.members.map((x) => x.userId), ["c", "a", "b"]);
    const left = steadyMembers(joined.order, [m("a", "owner", "amy@x.com"), m("d", "viewer", "dan@x.com")], "role");
    assert.deepEqual(left.members.map((x) => x.userId), ["a", "d"]);
  });

  it("orders names as people read them, ids with numbers included", async () => {
    const { sortMembers } = await import("../invite-text");
    const m = (userId: string) => ({ userId, role: "editor", joinedAt: "2026-10-01T00:00:00.000Z" });
    assert.deepEqual(sortMembers([m("u10"), m("u2"), m("u1")], "name").map((x) => x.userId), ["u1", "u2", "u10"]);
  });
});
