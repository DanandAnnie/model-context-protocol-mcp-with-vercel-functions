// Editing a saved presenter: a change made while its knowledge page is read is not written over.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { agentSchema, createAgent, getAgent, updateAgent } from "../services";
import { STOCK_AVATARS } from "../stock";
import type { Agent } from "../types";

const OWNER = "user_agent_edit";
const PAGE = `<!doctype html><html><head><title>About</title></head><body><main><p>${"We sell homes in Maple County and answer every call ourselves. ".repeat(4)}</p></main></body></html>`;

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("editing a saved presenter", () => {
  it("keeps a link turned off while its knowledge page was being read", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Dana", avatarId: STOCK_AVATARS[0].id }), OWNER);
    const slowPage = (async () => {
      // The owner pauses the link while the page is fetched.
      const now = (await getStore().get<Agent>("agent", agent.id))!;
      await getStore().put("agent", { ...now, isPublic: false });
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    const saved = await updateAgent(agent.id, { instructions: "New.", knowledgeUrl: "https://203.0.113.5/about" }, OWNER, slowPage);
    assert.equal(saved.isPublic, false, "the pause holds");
    assert.equal(saved.instructions, "New.");
    assert.match(saved.knowledge ?? "", /answer every call ourselves/);
  });

  it("does not bring back a presenter deleted while its page was being read", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Dana", avatarId: STOCK_AVATARS[0].id }), OWNER);
    const slowPage = (async () => {
      await getStore().remove("agent", agent.id);
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    await assert.rejects(updateAgent(agent.id, { knowledgeUrl: "https://203.0.113.5/about" }, OWNER, slowPage), /not found/i);
    await assert.rejects(getAgent(agent.id, OWNER), /not found/i);
  });

  it("changes only the fields sent", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Dana", avatarId: STOCK_AVATARS[0].id, isPublic: false, collectEmail: true, greeting: "Hi." }), OWNER);
    const saved = await updateAgent(agent.id, { instructions: "Only this." }, OWNER);
    assert.deepEqual(
      { isPublic: saved.isPublic, collectEmail: saved.collectEmail, greeting: saved.greeting, voiceId: saved.voiceId, instructions: saved.instructions },
      { isPublic: false, collectEmail: true, greeting: "Hi.", voiceId: agent.voiceId, instructions: "Only this." },
    );
  });
});
