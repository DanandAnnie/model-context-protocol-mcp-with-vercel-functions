// Duplicating a saved presenter: its setup under a new link that starts off, with no visits of its own.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { MAX_AGENTS, agentSchema, createAgent, duplicateAgent, listAgents, listConversations } from "../services";
import { describeActivity } from "../activity-text";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { ActivityEvent, Agent, Conversation } from "../types";

const OWNER = "user_agent_dup";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("duplicating a saved presenter", () => {
  it("copies the setup and the page it read under a new id, link off, with no visits", async () => {
    const agent = await createAgent(agentSchema.parse({
      name: "Dana",
      avatarId: STOCK_AVATARS[1].id,
      voiceId: STOCK_VOICES[1].id,
      instructions: "Answer as Dana.",
      greeting: "Hi there.",
      starters: ["Open houses?"],
      language: "Spanish",
      collectEmail: true,
      brandStyle: true,
    }), OWNER);
    // A page it read, and visits it had, as a saved presenter would.
    await getStore().put("agent", { ...agent, knowledgeUrl: "https://example.com/about", knowledge: "We sell homes.", knowledgeUpdatedAt: agent.createdAt, conversations: 4, messages: 9 } satisfies Agent);
    const visit: Conversation = { id: "conv_dup1", ownerId: OWNER, agentId: agent.id, messages: [{ role: "user", content: "Hi", at: agent.createdAt }], startedAt: agent.createdAt, updatedAt: agent.createdAt };
    await getStore().put("conversation", visit);
    const copy = await duplicateAgent(agent.id, OWNER);
    assert.notEqual(copy.id, agent.id);
    assert.equal(copy.ownerId, OWNER);
    assert.equal(copy.knowledgeUpdatedAt, agent.createdAt);
    assert.deepEqual((await listConversations(copy.id, OWNER)).length, 0, "transcripts stay with the original");
    assert.equal((await listConversations(agent.id, OWNER)).length, 1);
    assert.equal(copy.name, "Dana (copy)");
    assert.equal(copy.isPublic, false);
    assert.deepEqual({ conversations: copy.conversations, messages: copy.messages }, { conversations: 0, messages: 0 });
    assert.deepEqual(
      [copy.avatarId, copy.voiceId, copy.avatarName, copy.instructions, copy.greeting, copy.starters, copy.language, copy.collectEmail, copy.brandStyle, copy.knowledgeUrl, copy.knowledge],
      [STOCK_AVATARS[1].id, STOCK_VOICES[1].id, agent.avatarName, "Answer as Dana.", "Hi there.", ["Open houses?"], "Spanish", true, true, "https://example.com/about", "We sell homes."],
    );
    const original = (await listAgents(OWNER)).find((a) => a.id === agent.id)!;
    assert.equal(original.isPublic, true, "the original's link is left as it was");
    assert.equal((await duplicateAgent(agent.id, OWNER)).name, "Dana (copy 2)");
  });

  it("keeps a long name's copy within the 60 characters a name allows", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "x".repeat(60), avatarId: STOCK_AVATARS[0].id }), OWNER);
    const copy = await duplicateAgent(agent.id, OWNER);
    assert.equal(copy.name.length, 60);
    assert.ok(copy.name.endsWith(" (copy)"));
    assert.ok(agentSchema.shape.name.safeParse(copy.name).success);
  });

  it("answers not found for another owner's presenter and refuses past the limit", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Dana", avatarId: STOCK_AVATARS[0].id }), OWNER);
    await assert.rejects(duplicateAgent(agent.id, "someone_else"), /not found/i);
    for (let i = 1; i < MAX_AGENTS; i++) await duplicateAgent(agent.id, OWNER);
    await assert.rejects(duplicateAgent(agent.id, OWNER), new RegExp(`At most ${MAX_AGENTS}`));
  });

  it("is told in the workspace feed as a copy, not as a presenter shared", () => {
    const e = { id: "act_1", ownerId: "ws_1", kind: "agent.duplicated", actorId: "u_1", actorEmail: "dana@example.com", subject: "Dana (copy)", createdAt: "2026-10-31T00:00:00.000Z" } as ActivityEvent;
    assert.match(describeActivity(e), /copied a shared presenter as "Dana \(copy\)"$/);
  });
});
