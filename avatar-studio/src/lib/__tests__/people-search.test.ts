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
