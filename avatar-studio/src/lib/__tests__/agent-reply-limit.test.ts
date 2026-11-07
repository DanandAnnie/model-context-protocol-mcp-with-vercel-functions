// A presenter's daily reply limit: replies counted per UTC day, and a visitor turn refused before the model is asked
// once today's count reaches it. Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { agentPatchSchema, agentSchema, atReplyLimit, createAgent, duplicateAgent, getAgent, listConversations, publicAgent, talkToAgent, updateAgent } from "../services";
import { LimitError } from "../errors";
import { setScriptProvider } from "../providers";
import { MockScriptProvider } from "../providers/script/mock";
import type { Agent } from "../types";

const OWNER = "user_reply_limit";
let chats = 0;

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  chats = 0;
  const mock = new MockScriptProvider();
  setScriptProvider(Object.assign(Object.create(Object.getPrototypeOf(mock)), mock, {
    chat: (input: Parameters<MockScriptProvider["chat"]>[0]) => {
      chats++;
      return mock.chat(input);
    },
  }));
});

afterEach(() => setScriptProvider(undefined));

const ask = (id: string, content: string) => talkToAgent(id, { messages: [{ role: "user", content }] });

describe("a presenter's daily reply limit", () => {
  it("counts replies per UTC day and refuses the next turn, without asking the model, once the limit is reached", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Capped", avatarId: "stock_1", dailyReplyLimit: 2 }), OWNER);
    assert.equal(agent.dailyReplyLimit, 2);
    await ask(agent.id, "One");
    await ask(agent.id, "Two");
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual((await getAgent(agent.id, OWNER)).repliesByDay, { [today]: 2 });
    await assert.rejects(ask(agent.id, "Three"), (err: unknown) => err instanceof LimitError && /Capped can't answer any more questions for now/.test(err.message));
    assert.ok(atReplyLimit(await getAgent(agent.id, OWNER)));
    assert.ok(!atReplyLimit(await getAgent(agent.id, OWNER), "2099-01-01T00:00:00.000Z"), "a new UTC day starts afresh");
    assert.equal(chats, 2, "the refused turn never reached the model");
    assert.equal((await listConversations(agent.id, OWNER)).length, 2, "and was not recorded");
    // Yesterday's replies do not count against today.
    await getStore().put("agent", { ...(await getAgent(agent.id, OWNER)), repliesByDay: { "2020-01-01": 50 } } satisfies Agent);
    await ask(agent.id, "Four");
    // Raised, cleared, kept on a copy, and never in the visitor view.
    await updateAgent(agent.id, agentPatchSchema.parse({ dailyReplyLimit: 5 }), OWNER);
    assert.equal((await getAgent(agent.id, OWNER)).dailyReplyLimit, 5);
    assert.equal((await duplicateAgent(agent.id, OWNER)).dailyReplyLimit, 5);
    assert.equal("dailyReplyLimit" in (await publicAgent(agent.id)), false);
    assert.equal("repliesByDay" in (await publicAgent(agent.id)), false);
    await updateAgent(agent.id, agentPatchSchema.parse({ dailyReplyLimit: null }), OWNER);
    assert.equal("dailyReplyLimit" in (await getAgent(agent.id, OWNER)), false);
  });

  it("takes whole numbers from 1 to 10,000 only, and leaves the counts out of what the API sets", () => {
    for (const bad of [0, -1, 1.5, 10001, "5"]) assert.equal(agentSchema.safeParse({ name: "X", avatarId: "stock_1", dailyReplyLimit: bad }).success, false, String(bad));
    assert.equal(agentSchema.parse({ name: "X", avatarId: "stock_1", dailyReplyLimit: 10000 }).dailyReplyLimit, 10000);
    assert.equal("repliesByDay" in agentPatchSchema.parse({ repliesByDay: { "2026-01-01": 0 } }), false);
  });
});
