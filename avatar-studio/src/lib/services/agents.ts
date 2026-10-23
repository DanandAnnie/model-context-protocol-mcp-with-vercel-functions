// Shareable interactive presenters, their transcripts, and lead capture. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getScriptProvider } from "../providers";
import { getStore } from "../store";
import type { Agent, Conversation } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { dispatchNotification, getNotifySettings } from "../notifications";
import { NotFoundError, ValidationError } from "../errors";
import { getStreamingProvider } from "../streaming";
import { afterResponse, owned } from "./shared";
import { getAvatar } from "./avatars";
import { listVoices } from "./voices";
import { getBrandKit } from "./brand";
import { chatSchema } from "./scripts";
import { fetchPageText } from "../webpage";
import type { FetchLike } from "../safe-fetch";

export const MAX_AGENTS = 20;

const knowledgeUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), "The knowledge page must start with http:// or https://");

export const agentSchema = z.object({
  name: z.string().trim().min(1).max(60),
  avatarId: z.string().min(1),
  voiceId: z.string().min(1).optional(),
  instructions: z.string().trim().max(2000).default(""),
  /** A public page read once and kept as reference material for replies (see `readKnowledge`). */
  knowledgeUrl: knowledgeUrlSchema.optional(),
  language: z.string().trim().min(2).max(40).default("English"),
  isPublic: z.boolean().default(true),
  /** Ask visitors for an email after the first reply. */
  collectEmail: z.boolean().default(false),
});

/** `knowledgeUrl: null` forgets the page; a URL (the same one included) reads it again. */
export const agentPatchSchema = agentSchema.partial().extend({ knowledgeUrl: knowledgeUrlSchema.nullable().optional() });

/** Marks where the owner's instructions end and the page text begins in the persona handed to the model. */
export const KNOWLEDGE_MARKER = "Reference material from the page at ";

/** Reads a public page's text (same guard, size, and length limits as the script writer's page import). */
async function readKnowledge(url: string, fetchImpl?: FetchLike): Promise<Pick<Agent, "knowledgeUrl" | "knowledge" | "knowledgeUpdatedAt">> {
  try {
    const page = await fetchPageText(url, fetchImpl);
    return { knowledgeUrl: url, knowledge: page.text, knowledgeUpdatedAt: nowIso() };
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : "The knowledge page could not be read");
  }
}

/** The instructions the model sees: the owner's text, then the page text when there is one. */
export function withKnowledge(agent: Pick<Agent, "instructions" | "knowledgeUrl" | "knowledge">): string {
  return agent.knowledge ? `${agent.instructions}\n\n${KNOWLEDGE_MARKER}${agent.knowledgeUrl}:\n${agent.knowledge}` : agent.instructions;
}

export const leadSchema = z.object({
  conversationId: z.string().regex(/^conv_[a-z0-9]+$/),
  email: z.string().trim().email().max(200),
  name: z.string().trim().max(80).optional(),
});

/** A visitor leaves contact details on a conversation. Notifies the owner's webhook as lead.captured. */
export async function captureLead(agentId: string, input: z.infer<typeof leadSchema>): Promise<void> {
  const agent = await getStore().get<Agent>("agent", agentId);
  if (!agent || !agent.isPublic) throw new NotFoundError("This presenter is not available");
  const conversation = await getStore().get<Conversation>("conversation", input.conversationId);
  if (!conversation || conversation.agentId !== agentId) throw new NotFoundError("Conversation not found");
  const now = nowIso();
  await getStore().put("conversation", { ...conversation, visitor: { email: input.email, name: input.name }, updatedAt: now });
  const settings = await getNotifySettings(agent.ownerId).catch(() => null);
  if (settings) {
    await afterResponse(() => dispatchNotification(settings, "lead.captured", {
      agentId: agent.id,
      agentName: agent.name,
      conversationId: conversation.id,
      email: input.email,
      name: input.name,
      lastMessage: conversation.messages.filter((m) => m.role === "user").at(-1)?.content,
      capturedAt: now,
    }));
  }
}

export async function listAgents(ownerId: string = LOCAL_OWNER): Promise<Agent[]> {
  const agents = await getStore().list<Agent>("agent", ownerId);
  return agents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getAgent(id: string, ownerId: string | null = LOCAL_OWNER): Promise<Agent> {
  return owned(await getStore().get<Agent>("agent", id), ownerId, `Agent ${id}`);
}

/** Presenter details copied onto the agent so public turns and views never need a provider call. */
async function presenterSnapshot(avatarId: string, voiceId: string | undefined, ownerId: string) {
  const avatar = await getAvatar(avatarId, ownerId);
  let voiceLanguage: string | undefined;
  if (voiceId) {
    const voice = (await listVoices(ownerId)).find((v) => v.id === voiceId);
    if (!voice) throw new ValidationError(`Voice ${voiceId} is not available`);
    voiceLanguage = voice.language;
  }
  return { avatarName: avatar.name, avatarImageUrl: avatar.imageUrl, voiceLanguage };
}

export async function createAgent(input: z.infer<typeof agentSchema>, ownerId: string = LOCAL_OWNER, fetchImpl?: FetchLike): Promise<Agent> {
  if ((await listAgents(ownerId)).length >= MAX_AGENTS) throw new ValidationError(`At most ${MAX_AGENTS} agents per account`);
  const snapshot = await presenterSnapshot(input.avatarId, input.voiceId, ownerId);
  const { knowledgeUrl, ...rest } = input;
  const knowledge = knowledgeUrl ? await readKnowledge(knowledgeUrl, fetchImpl) : {};
  const now = nowIso();
  return getStore().put("agent", { id: newId("agent"), ownerId, ...rest, ...snapshot, ...knowledge, conversations: 0, messages: 0, createdAt: now, updatedAt: now });
}

export async function updateAgent(id: string, patch: z.infer<typeof agentPatchSchema>, ownerId: string = LOCAL_OWNER, fetchImpl?: FetchLike): Promise<Agent> {
  const existing = await getAgent(id, ownerId);
  const { knowledgeUrl, ...rest } = patch;
  const next: Agent = { ...existing, ...rest };
  const snapshot = patch.avatarId || patch.voiceId ? await presenterSnapshot(next.avatarId, next.voiceId, ownerId) : {};
  if (knowledgeUrl === null) {
    delete next.knowledgeUrl;
    delete next.knowledge;
    delete next.knowledgeUpdatedAt;
  } else if (knowledgeUrl) {
    Object.assign(next, await readKnowledge(knowledgeUrl, fetchImpl));
  }
  return getStore().put("agent", { ...next, ...snapshot, updatedAt: nowIso() });
}

export async function deleteAgent(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  await getAgent(id, ownerId);
  await clearConversations(id, ownerId);
  await getStore().remove("agent", id);
}

/** Public view for the talk page: never exposes instructions or the owner. */
export async function publicAgent(id: string) {
  const agent = await getStore().get<Agent>("agent", id);
  if (!agent || !agent.isPublic) throw new NotFoundError("This presenter is not available");
  const brand = await getBrandKit(agent.ownerId);
  return {
    id: agent.id,
    name: agent.name,
    language: agent.language,
    avatar: { id: agent.avatarId, name: agent.avatarName, imageUrl: agent.avatarImageUrl },
    voiceLanguage: agent.voiceLanguage,
    collectEmail: agent.collectEmail ?? false,
    liveVideo: getStreamingProvider().available,
    brand: brand ? { name: brand.name, logoUrl: brand.logoUrl, primaryColor: brand.primaryColor, accentColor: brand.accentColor } : null,
  };
}

export const talkSchema = z.object({
  messages: chatSchema.shape.messages,
  /** Returned by the first turn; send it back to keep one transcript per visit. */
  conversationId: z.string().regex(/^conv_[a-z0-9]+$/).optional(),
});

/** Transcript limits: per visit and per presenter (oldest visits are dropped). */
export const MAX_TRANSCRIPT_MESSAGES = 40;
export const MAX_CONVERSATIONS_PER_AGENT = 100;

/** A visitor's turn with a public agent. Records the transcript and counts conversations and messages. */
export async function talkToAgent(id: string, input: z.infer<typeof talkSchema>): Promise<{ reply: string; conversationId: string }> {
  const agent = await getStore().get<Agent>("agent", id);
  if (!agent || !agent.isPublic) throw new NotFoundError("This presenter is not available");
  const last = input.messages[input.messages.length - 1];
  if (last.role !== "user") throw new ValidationError("The last message must be from the visitor");
  const reply = await getScriptProvider().chat({ persona: { name: agent.avatarName, instructions: withKnowledge(agent), language: agent.language }, messages: input.messages });

  const now = nowIso();
  let conversation = input.conversationId ? await getStore().get<Conversation>("conversation", input.conversationId) : null;
  if (conversation && conversation.agentId !== agent.id) conversation = null; // a token from another presenter starts fresh
  const isNew = !conversation;
  if (!conversation) conversation = { id: newId("conv"), ownerId: agent.ownerId, agentId: agent.id, messages: [], startedAt: now, updatedAt: now };
  const messages = [...conversation.messages, { role: "user" as const, content: last.content, at: now }, { role: "assistant" as const, content: reply, at: now }].slice(-MAX_TRANSCRIPT_MESSAGES);
  // Transcripts and counters are best effort; a lost write never fails the visitor's turn.
  const record = async () => {
    // The chat took seconds: count on the stored row so an edit or rename that landed meanwhile is kept,
    // and write nothing for a presenter deleted meanwhile rather than bringing it back.
    const current = await getStore().get<Agent>("agent", agent.id);
    if (!current) return;
    await getStore().put("conversation", { ...conversation, messages, updatedAt: now });
    await getStore().put("agent", { ...current, conversations: current.conversations + (isNew ? 1 : 0), messages: current.messages + 1 });
    if (isNew) await pruneConversations(agent);
  };
  await record().catch((err) => console.error("transcript write failed:", err));
  return { reply, conversationId: conversation.id };
}

async function pruneConversations(agent: Agent) {
  const all = (await getStore().list<Conversation>("conversation", agent.ownerId)).filter((c) => c.agentId === agent.id);
  if (all.length <= MAX_CONVERSATIONS_PER_AGENT) return;
  all.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const c of all.slice(0, all.length - MAX_CONVERSATIONS_PER_AGENT)) await getStore().remove("conversation", c.id);
}

/** The owner's transcripts for one presenter, newest first. */
export async function listConversations(agentId: string, ownerId: string = LOCAL_OWNER, limit = 50): Promise<Conversation[]> {
  await getAgent(agentId, ownerId);
  const all = (await getStore().list<Conversation>("conversation", ownerId)).filter((c) => c.agentId === agentId);
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

export async function clearConversations(agentId: string, ownerId: string = LOCAL_OWNER): Promise<number> {
  await getAgent(agentId, ownerId);
  const all = (await getStore().list<Conversation>("conversation", ownerId)).filter((c) => c.agentId === agentId);
  for (const c of all) await getStore().remove("conversation", c.id);
  return all.length;
}
