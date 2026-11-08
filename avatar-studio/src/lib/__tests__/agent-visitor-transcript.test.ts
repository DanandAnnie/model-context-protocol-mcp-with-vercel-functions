// A visitor's download of their own conversation: their messages and ratings, never the owner's mark or note, and only
// for the presenter the visit belongs to while its link is on. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { agentPatchSchema, agentSchema, createAgent, rateReply, talkToAgent, updateAgent, updateVisit, visitorTranscript, visitorTranscriptSchema } from "../services";
import { NotFoundError } from "../errors";
import { transcriptText } from "../transcripts";

const OWNER = "user_visitor_transcript";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("a visitor's own transcript", () => {
  it("has the visit's messages and the visitor's ratings, without the owner's mark or note", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Dana", avatarId: "stock_1" }), OWNER);
    const first = await talkToAgent(agent.id, { messages: [{ role: "user", content: "When are showings?" }] });
    assert.ok(first.at);
    await rateReply(agent.id, { conversationId: first.conversationId, at: first.at, rating: "up" });
    await updateVisit(agent.id, first.conversationId, { followedUp: true, note: "Hot lead, call Monday" }, OWNER);

    const { agentName, conversation } = await visitorTranscript(agent.id, { conversationId: first.conversationId });
    assert.equal(agentName, "Dana");
    assert.deepEqual(Object.keys(conversation).sort(), ["agentId", "id", "messages", "ownerId", "startedAt", "updatedAt"]);
    assert.deepEqual(conversation.messages.map((m) => Object.keys(m).sort()), [["at", "content", "role"], ["at", "content", "rating", "role"]]);
    const text = transcriptText(agentName, conversation);
    assert.match(text, /^Conversation with Dana$/m);
    assert.match(text, /\] Visitor: When are showings\?$/m);
    assert.match(text, /\] Presenter \(rated helpful\): /m);
    assert.doesNotMatch(text, /Hot lead|Followed up|Note:/);
  });

  it("is only for the presenter the visit belongs to, while its link is on", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Dana", avatarId: "stock_1" }), OWNER);
    const other = await createAgent(agentSchema.parse({ name: "Lee", avatarId: "stock_1" }), OWNER);
    const { conversationId } = await talkToAgent(agent.id, { messages: [{ role: "user", content: "Hi" }] });
    const missing = (err: unknown) => err instanceof NotFoundError;
    await assert.rejects(visitorTranscript(other.id, { conversationId }), missing);
    await assert.rejects(visitorTranscript(agent.id, { conversationId: "conv_nosuch" }), missing);
    await updateAgent(agent.id, agentPatchSchema.parse({ isPublic: false }), OWNER);
    await assert.rejects(visitorTranscript(agent.id, { conversationId }), missing);
    assert.equal(visitorTranscriptSchema.safeParse({ conversationId: "../agent_x" }).success, false);
  });
});
