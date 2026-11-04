// The Interactive page's Shared presenters list: sorts and search. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_SORTS, AGENT_SORT_KEY, agentSearchTexts, agentSortFrom, agentsInSortOrder, rankAgents, type RankableAgent } from "../agent-sort";
import { inRankOrder } from "../asset-sort";

const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
const agents: RankableAgent[] = [
  { id: "a1", name: "Front desk 2", createdAt: at(1), conversations: 4, lastVisitAt: at(50) },
  { id: "a2", name: "front desk 10", createdAt: at(2), conversations: 9 },
  { id: "a3", name: "Écoles", createdAt: at(3), conversations: 4, lastVisitAt: at(90) },
  { id: "a4", name: "Bakery", createdAt: at(4), conversations: 0 },
];
const order = (sort: Parameters<typeof rankAgents>[1]) => inRankOrder(agents, rankAgents(agents, sort, "en")).map((a) => a.id);

describe("rankAgents", () => {
  it("orders by when each was shared, newest or oldest first", () => {
    assert.deepEqual(order("newest"), ["a4", "a3", "a2", "a1"]);
    assert.deepEqual(order("oldest"), ["a1", "a2", "a3", "a4"]);
  });
  it("orders names as people read them: numbers by value, case and accents ignored", () => {
    assert.deepEqual(order("name"), ["a4", "a3", "a1", "a2"]);
  });
  it("puts the busiest first, equal counts newest first", () => {
    assert.deepEqual(order("conversations"), ["a2", "a3", "a1", "a4"]);
  });
  it("puts the most recently visited first and the never visited last, newest first among them", () => {
    assert.deepEqual(order("visited"), ["a3", "a1", "a4", "a2"]);
  });
  it("breaks a tie by id so every render agrees, and says when a list is out of order", () => {
    const twins: RankableAgent[] = [
      { id: "b2", name: "Same", createdAt: at(5), conversations: 1 },
      { id: "b1", name: "Same", createdAt: at(5), conversations: 1 },
    ];
    assert.deepEqual([...rankAgents(twins, "newest").entries()], [["b1", 0], ["b2", 1]]);
    assert.equal(agentsInSortOrder(twins, "name"), false);
    assert.equal(agentsInSortOrder([twins[1], twins[0]], "name"), true);
    assert.equal(agentsInSortOrder([], "visited"), true);
  });
});

describe("agentSortFrom", () => {
  it("reads back each sort, and anything else as newest first", () => {
    for (const o of AGENT_SORTS) assert.equal(agentSortFrom(o.value), o.value);
    for (const v of [null, undefined, "", "Name", "visits"]) assert.equal(agentSortFrom(v), "newest");
    assert.equal(AGENT_SORT_KEY, "avatar-studio:presenters-sort");
  });
});

describe("agentSearchTexts", () => {
  it("searches the name, the presenter, the opening line, and the knowledge page's site", () => {
    assert.deepEqual(agentSearchTexts({ name: "Desk", avatarName: "Ava", greeting: "Hi there", knowledgeUrl: "https://www.example.com/faq" }), ["Desk", "Ava", "Hi there", "www.example.com"]);
    assert.deepEqual(agentSearchTexts({ name: "Desk" }), ["Desk"]);
    assert.deepEqual(agentSearchTexts({ name: "Desk", knowledgeUrl: "not a url" }), ["Desk", "not a url"]);
  });
});
