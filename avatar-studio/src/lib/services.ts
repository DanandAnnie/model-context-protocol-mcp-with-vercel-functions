// Application services: orchestrate providers + store. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "./ids";
import {
  getAvatarProvider,
  getAvatarProviderByName,
  getScriptProvider,
  getTranslateProvider,
  getTranslateProviderByName,
  getTtsProvider,
} from "./providers";
import { getStore } from "./store";
import { MAX_SCENES, type Agent, type Avatar, type Conversation, type BrandKit, type Translation, type Video, type VideoRequest, type Voice } from "./types";

import { LOCAL_OWNER } from "./owner-id";
import { after } from "next/server";
import { dispatchNotification, getNotifySettings, notifyVideoTransition } from "./notifications";
import { renderLimitFor } from "./billing";
import { memo } from "./cache";
import { decodeDataUrl } from "./providers/image";
import { LimitError, NotFoundError, ValidationError } from "./errors";
export { NotFoundError, ValidationError, UnauthorizedError, LimitError } from "./errors";
import { config } from "./config";
import { fillTemplate, parseCsv, placeholdersIn } from "./csv";
import { fetchPageText } from "./webpage";
import { getStreamingProvider } from "./streaming";

/** Pass as the owner to skip the ownership check (public share pages). */
export const PUBLIC_ACCESS = null;

/** Throws NotFound when an item belongs to a different owner (missing ownerId counts as local). */
function owned<T extends { ownerId?: string }>(item: T | null, ownerId: string | null, what: string): T {
  if (!item) throw new NotFoundError(`${what} not found`);
  if (ownerId !== PUBLIC_ACCESS && (item.ownerId ?? LOCAL_OWNER) !== ownerId) throw new NotFoundError(`${what} not found`);
  return item;
}

// ---------- Avatars ----------

const LIST_TTL_MS = 5 * 60 * 1000;

/** Provider avatar list, memoised per provider for a few minutes. */
function providerAvatars(): Promise<Avatar[]> {
  const p = getAvatarProvider();
  return memo(`avatars:${p.name}`, LIST_TTL_MS, () => p.listAvatars());
}

export async function listAvatars(ownerId: string = LOCAL_OWNER): Promise<Avatar[]> {
  const [provider, custom] = await Promise.all([providerAvatars(), getStore().list<Avatar>("avatar", ownerId)]);
  custom.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return [...custom, ...provider];
}

export async function getAvatar(id: string, ownerId: string = LOCAL_OWNER): Promise<Avatar> {
  const custom = await getStore().get<Avatar>("avatar", id);
  if (custom) return owned(custom, ownerId, `Avatar ${id}`);
  const match = (await providerAvatars()).find((a) => a.id === id);
  if (!match) throw new NotFoundError(`Avatar ${id} not found`);
  return match;
}

export const createAvatarSchema = z.object({
  name: z.string().trim().min(1).max(80),
  imageUrl: z
    .string()
    .min(1)
    .max(8_000_000, "Uploaded image must be under 6 MB")
    .refine((v) => v.startsWith("data:image/") || /^https?:\/\//.test(v), "Must be an image URL or uploaded image"),
  gender: z.enum(["male", "female", "neutral"]).optional(),
});

export async function createAvatar(input: z.infer<typeof createAvatarSchema>, ownerId: string = LOCAL_OWNER): Promise<Avatar> {
  const avatar: Avatar = {
    id: newId("av"),
    ownerId,
    name: input.name,
    imageUrl: input.imageUrl,
    gender: input.gender,
    source: "custom",
    provider: getAvatarProvider().name,
    tags: ["photo avatar"],
    createdAt: nowIso(),
  };
  return getStore().put("avatar", avatar);
}

export async function deleteAvatar(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  owned(await getStore().get<Avatar>("avatar", id), ownerId, `Avatar ${id}`);
  await getStore().remove("avatar", id);
}

// ---------- Voices ----------

/** Provider voices (memoised) plus the owner's cloned voices, which are listed first. */
export async function listVoices(ownerId?: string): Promise<Voice[]> {
  const p = getTtsProvider();
  const provider = await memo(`voices:${p.name}`, LIST_TTL_MS, () => p.listVoices());
  if (!ownerId) return provider;
  const custom = (await getStore().list<Voice>("voice", ownerId)).filter((v) => v.provider === p.name);
  custom.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return [...custom, ...provider];
}

export const MAX_VOICE_SAMPLE_BYTES = 10 * 1024 * 1024;
export const MAX_CLONED_VOICES = 5;

export const cloneVoiceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Audio samples as data URLs (audio/*), one to five, 10 MB in total. */
  samples: z.array(z.string().min(1).max(14_000_000)).min(1).max(5),
  language: z.string().trim().max(40).optional(),
});

export function voiceCloningAvailable(): boolean {
  return typeof getTtsProvider().cloneVoice === "function";
}

/** Clones a voice with the TTS provider and keeps it as a custom voice of the owner. */
export async function cloneVoice(input: z.infer<typeof cloneVoiceSchema>, ownerId: string = LOCAL_OWNER): Promise<Voice> {
  const provider = getTtsProvider();
  if (!provider.cloneVoice) throw new ValidationError(`Voice cloning is not available with the ${provider.name} voice provider`);
  const mine = (await getStore().list<Voice>("voice", ownerId)).filter((v) => v.provider === provider.name);
  if (mine.length >= MAX_CLONED_VOICES) throw new ValidationError(`At most ${MAX_CLONED_VOICES} cloned voices per account`);
  let total = 0;
  const samples = input.samples.map((dataUrl, i) => {
    if (!dataUrl.startsWith("data:audio/")) throw new ValidationError("Samples must be audio recordings or files");
    const { bytes, mimeType } = decodeDataUrl(dataUrl);
    total += bytes.byteLength;
    if (total > MAX_VOICE_SAMPLE_BYTES) throw new ValidationError("Samples must be under 10 MB in total");
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("wav") ? "wav" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : "mp3";
    return { bytes, mimeType, filename: `sample-${i + 1}.${ext}` };
  });
  const { voiceId } = await provider.cloneVoice({ name: input.name, samples });
  const voice: Voice = { id: voiceId, name: input.name, provider: provider.name, language: input.language, source: "custom", ownerId, tags: ["your voice"], createdAt: nowIso() };
  return getStore().put("voice", voice);
}

export async function deleteClonedVoice(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const voice = owned(await getStore().get<Voice>("voice", id), ownerId, `Voice ${id}`);
  const provider = getTtsProvider();
  if (provider.name === voice.provider) await provider.deleteVoice?.(id);
  await getStore().remove("voice", id);
}

export async function previewVoice(voiceId: string, text: string, speed: number) {
  return getTtsProvider().synthesize(voiceId, text, speed);
}

// ---------- Brand kit ----------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const brandKitSchema = z.object({
  name: z.string().trim().max(80).default(""),
  logoUrl: z
    .string()
    .max(8_000_000, "Logo must be under 6 MB")
    .refine((v) => v === "" || v.startsWith("data:image/") || /^https?:\/\//.test(v), "Logo must be an image URL or uploaded image")
    .default(""),
  primaryColor: z.string().regex(HEX_COLOR, "Use a 6-digit hex color like #4f46e5"),
  accentColor: z.string().regex(HEX_COLOR, "Use a 6-digit hex color like #4f46e5").optional(),
  defaultAvatarId: z.string().trim().max(200).optional(),
  defaultVoiceId: z.string().trim().max(200).optional(),
  defaultAspect: z.enum(["16:9", "9:16", "1:1"]).optional(),
  captionsByDefault: z.boolean().optional(),
});

export const brandKitId = (ownerId: string) => `brand_${ownerId}`;

/** The owner's brand kit, or null when none has been saved. */
export async function getBrandKit(ownerId: string = LOCAL_OWNER): Promise<BrandKit | null> {
  const kit = await getStore().get<BrandKit>("brand", brandKitId(ownerId));
  return kit && kit.ownerId === ownerId ? kit : null;
}

export async function saveBrandKit(input: z.infer<typeof brandKitSchema>, ownerId: string = LOCAL_OWNER): Promise<BrandKit> {
  if (input.defaultAvatarId) await getAvatar(input.defaultAvatarId, ownerId); // throws NotFound for foreign or unknown ids
  if (input.defaultVoiceId && !(await listVoices(ownerId)).some((v) => v.id === input.defaultVoiceId)) {
    throw new ValidationError(`Voice ${input.defaultVoiceId} is not available`);
  }
  const kit: BrandKit = {
    id: brandKitId(ownerId),
    ownerId,
    name: input.name,
    logoUrl: input.logoUrl || undefined,
    primaryColor: input.primaryColor.toLowerCase(),
    accentColor: input.accentColor?.toLowerCase(),
    defaultAvatarId: input.defaultAvatarId || undefined,
    defaultVoiceId: input.defaultVoiceId || undefined,
    defaultAspect: input.defaultAspect,
    captionsByDefault: input.captionsByDefault,
    updatedAt: nowIso(),
  };
  return getStore().put("brand", kit);
}

export async function deleteBrandKit(ownerId: string = LOCAL_OWNER): Promise<void> {
  await getStore().remove("brand", brandKitId(ownerId));
}

// ---------- Scripts ----------

export const scriptSchema = z
  .object({
    topic: z.string().trim().max(500).default(""),
    /** A public web page to write from; the topic defaults to its title. */
    url: z.string().trim().url().max(2000).optional(),
    tone: z.enum(["friendly", "professional", "formal", "energetic", "calm"]).default("friendly"),
    lengthSec: z.number().int().min(10).max(300).default(45),
    language: z.string().trim().min(2).max(40).default("English"),
    audience: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.topic.length >= 3 || !!v.url, { path: ["topic"], message: "Give a topic or a page URL" });

export async function generateScript(input: z.infer<typeof scriptSchema>, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (input.url) {
    let page: { title: string; text: string };
    try {
      page = await fetchPageText(input.url, fetchImpl);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : "The page could not be read");
    }
    const topic = input.topic.length >= 3 ? input.topic : page.title || "this page";
    return getScriptProvider().generate({ ...input, topic, source: page.text });
  }
  return getScriptProvider().generate(input);
}

export const reviseSchema = z.object({
  script: z.string().trim().min(1).max(5000),
  action: z.enum(["shorten", "expand", "tone", "translate", "polish"]),
  tone: z.enum(["friendly", "professional", "formal", "energetic", "calm"]).optional(),
  language: z.string().trim().min(2).max(40).optional(),
});

export async function reviseScript(input: z.infer<typeof reviseSchema>): Promise<string> {
  return getScriptProvider().revise(input);
}

export const chatSchema = z.object({
  avatarId: z.string().min(1),
  instructions: z.string().trim().max(2000).default(""),
  language: z.string().trim().min(2).max(40).default("English"),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) })).min(1).max(40),
});

/** One reply from the interactive avatar; the last message must come from the visitor. */
export async function chatWithAvatar(input: z.infer<typeof chatSchema>, ownerId: string = LOCAL_OWNER): Promise<string> {
  if (input.messages[input.messages.length - 1].role !== "user") throw new ValidationError("The last message must be from the visitor");
  const avatar = await getAvatar(input.avatarId, ownerId);
  return getScriptProvider().chat({ persona: { name: avatar.name, instructions: input.instructions, language: input.language }, messages: input.messages });
}

// ---------- Agents (shareable interactive avatars) ----------

export const MAX_AGENTS = 20;

export const agentSchema = z.object({
  name: z.string().trim().min(1).max(60),
  avatarId: z.string().min(1),
  voiceId: z.string().min(1).optional(),
  instructions: z.string().trim().max(2000).default(""),
  language: z.string().trim().min(2).max(40).default("English"),
  isPublic: z.boolean().default(true),
  /** Ask visitors for an email after the first reply. */
  collectEmail: z.boolean().default(false),
});

export const agentPatchSchema = agentSchema.partial();

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

export async function createAgent(input: z.infer<typeof agentSchema>, ownerId: string = LOCAL_OWNER): Promise<Agent> {
  if ((await listAgents(ownerId)).length >= MAX_AGENTS) throw new ValidationError(`At most ${MAX_AGENTS} agents per account`);
  const snapshot = await presenterSnapshot(input.avatarId, input.voiceId, ownerId);
  const now = nowIso();
  return getStore().put("agent", { id: newId("agent"), ownerId, ...input, ...snapshot, conversations: 0, messages: 0, createdAt: now, updatedAt: now });
}

export async function updateAgent(id: string, patch: z.infer<typeof agentPatchSchema>, ownerId: string = LOCAL_OWNER): Promise<Agent> {
  const existing = await getAgent(id, ownerId);
  const next = { ...existing, ...patch };
  const snapshot = patch.avatarId || patch.voiceId ? await presenterSnapshot(next.avatarId, next.voiceId, ownerId) : {};
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
  const reply = await getScriptProvider().chat({ persona: { name: agent.avatarName, instructions: agent.instructions, language: agent.language }, messages: input.messages });

  const now = nowIso();
  let conversation = input.conversationId ? await getStore().get<Conversation>("conversation", input.conversationId) : null;
  if (conversation && conversation.agentId !== agent.id) conversation = null; // a token from another presenter starts fresh
  const isNew = !conversation;
  if (!conversation) conversation = { id: newId("conv"), ownerId: agent.ownerId, agentId: agent.id, messages: [], startedAt: now, updatedAt: now };
  const messages = [...conversation.messages, { role: "user" as const, content: last.content, at: now }, { role: "assistant" as const, content: reply, at: now }].slice(-MAX_TRANSCRIPT_MESSAGES);
  // Transcripts and counters are best effort; a lost write never fails the visitor's turn.
  const record = async () => {
    await getStore().put("conversation", { ...conversation, messages, updatedAt: now });
    await getStore().put("agent", { ...agent, conversations: agent.conversations + (isNew ? 1 : 0), messages: agent.messages + 1 });
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

// ---------- Videos ----------

const backgroundSchema = z.object({ type: z.enum(["color", "image"]), value: z.string().min(1) });

export const videoRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    /** Optional when `scenes` is given; derived from them otherwise. */
    script: z.string().trim().max(5000).optional(),
    scenes: z.array(z.object({ script: z.string().trim().min(1).max(5000), background: backgroundSchema })).min(1).max(MAX_SCENES).optional(),
    avatarId: z.string().min(1),
    voiceId: z.string().min(1),
    aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
    background: backgroundSchema.default({ type: "color", value: "#f1f5f9" }),
    captions: z.boolean().default(false),
    speed: z.number().min(0.5).max(1.5).default(1),
  })
  .transform((v, ctx) => {
    if (v.scenes) {
      const script = v.scenes.map((s) => s.script).join("\n\n");
      if (script.length > 5000) {
        ctx.addIssue({ code: "custom", path: ["scenes"], message: "Combined scene scripts must be 5000 characters or fewer" });
        return z.NEVER;
      }
      return { ...v, script, background: v.scenes[0].background };
    }
    if (!v.script) {
      ctx.addIssue({ code: "custom", path: ["script"], message: "Script is required" });
      return z.NEVER;
    }
    return { ...v, script: v.script };
  });

/** Renders started by this owner since the start of the current UTC month, excluding ones that failed to start. */
export async function rendersThisMonth(ownerId: string): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const since = monthStart.toISOString();
  const videos = await getStore().list<Video>("video", ownerId);
  return videos.filter((v) => v.createdAt >= since && v.status !== "failed").length;
}

async function enforceRenderLimit(ownerId: string): Promise<void> {
  const limit = await renderLimitFor(ownerId);
  if (!limit) return;
  const used = await rendersThisMonth(ownerId);
  if (used >= limit) {
    throw new LimitError(`Monthly render limit reached (${used} of ${limit}). The allowance resets on the 1st.`);
  }
}

interface RenderContext {
  avatar: Avatar;
  voice: Voice;
}

async function resolveRenderContext(req: Pick<VideoRequest, "avatarId" | "voiceId">, ownerId: string): Promise<RenderContext> {
  const [avatar, voices] = await Promise.all([getAvatar(req.avatarId, ownerId), listVoices(ownerId)]);
  const voice = voices.find((v) => v.id === req.voiceId) ?? null;
  if (!voice) throw new ValidationError(`Voice ${req.voiceId} is not available with the current voice provider`);
  return { avatar, voice };
}

/**
 * Start a render. The allowance check is read-then-write and therefore
 * best-effort under concurrent requests; batches reserve their rows up front.
 */
export async function createVideo(req: VideoRequest, ownerId: string = LOCAL_OWNER, ctx?: RenderContext, skipLimit = false): Promise<Video> {
  if (!skipLimit) await enforceRenderLimit(ownerId);
  const resolved = ctx ?? (await resolveRenderContext(req, ownerId));
  let avatar = resolved.avatar;
  const voice = resolved.voice;
  const provider = getAvatarProvider();

  const base: Video = {
    ...req,
    id: newId("vid"),
    ownerId,
    status: "queued",
    provider: provider.name,
    avatarName: avatar.name,
    voiceName: voice?.name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  try {
    if (provider.prepareAvatar && avatar.source === "custom") {
      const prepared = await provider.prepareAvatar(avatar);
      if (prepared !== avatar) avatar = await getStore().put("avatar", prepared);
    }
    const { providerJobId } = await provider.createVideo(req, avatar, voice);
    base.providerJobId = providerJobId;
    base.status = "processing";
  } catch (err) {
    base.status = "failed";
    base.error = err instanceof Error ? err.message : String(err);
  }
  return getStore().put("video", base);
}

// ---------- Personalized batches ----------

export const MAX_BATCH_ROWS = 100;

export const batchRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  /** Script with {column} placeholders. */
  scriptTemplate: z.string().trim().min(1).max(5000),
  /** Raw CSV text; the first row is the header. */
  csv: z.string().min(1).max(200_000),
  avatarId: z.string().min(1),
  voiceId: z.string().min(1),
  aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
  background: backgroundSchema.default({ type: "color", value: "#f1f5f9" }),
  captions: z.boolean().default(false),
  speed: z.number().min(0.5).max(1.5).default(1),
});

export interface BatchResult {
  batchId: string;
  videos: Video[];
  /** Rows not started because the allowance was reached. */
  skipped: Array<{ row: number; reason: string }>;
  /** Rows whose render could not be started by the provider (stored with status "failed"). */
  failed: Array<{ row: number; reason: string }>;
}

/** Pure preview: the substituted scripts for the first rows, plus columns the template uses but the CSV lacks. */
export function previewBatch(scriptTemplate: string, csv: string, limit = 3) {
  const table = parseCsv(csv);
  const used = placeholdersIn(scriptTemplate);
  const missing = used.filter((c) => !table.columns.includes(c));
  const samples = table.rows.slice(0, limit).map((row) => ({ label: row[table.columns[0]] ?? "", script: fillTemplate(scriptTemplate, row) }));
  return { columns: table.columns, rowCount: table.rows.length, missing, samples };
}

export async function createBatch(input: z.infer<typeof batchRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<BatchResult> {
  const table = parseCsv(input.csv);
  if (table.columns.length === 0 || table.rows.length === 0) throw new ValidationError("The CSV needs a header row and at least one data row");
  if (table.rows.length > MAX_BATCH_ROWS) throw new ValidationError(`A batch can have at most ${MAX_BATCH_ROWS} rows`);
  const missing = placeholdersIn(input.scriptTemplate).filter((c) => !table.columns.includes(c));
  if (missing.length) throw new ValidationError(`The script uses columns the CSV does not have: ${missing.join(", ")}`);

  const batchId = newId("batch");
  const labelColumn = table.columns[0];

  // Resolve avatar and voice once (they may cost provider round-trips) and reserve
  // the allowance for the whole batch before starting any row.
  const ctx = await resolveRenderContext(input, ownerId);
  const limit = await renderLimitFor(ownerId);
  const used = limit ? await rendersThisMonth(ownerId) : 0;
  const allowedRows = limit ? Math.max(0, Math.min(table.rows.length, limit - used)) : table.rows.length;
  const skipped: BatchResult["skipped"] = [];
  for (let j = allowedRows; j < table.rows.length; j++) {
    skipped.push({ row: j + 1, reason: `Monthly render limit reached (${used} of ${limit}). The allowance resets on the 1st.` });
  }

  const videos: Video[] = new Array(allowedRows);
  const failed: BatchResult["failed"] = [];
  const startRow = async (i: number) => {
    const row = table.rows[i];
    const label = row[labelColumn] || `row ${i + 1}`;
    const video = await createVideo(
      {
        title: `${input.title} – ${label}`.slice(0, 120),
        script: fillTemplate(input.scriptTemplate, row),
        avatarId: input.avatarId,
        voiceId: input.voiceId,
        aspect: input.aspect,
        background: input.background,
        captions: input.captions,
        speed: input.speed,
      },
      ownerId,
      ctx,
      true,
    );
    videos[i] = await getStore().put("video", { ...video, batchId, rowLabel: label });
    if (video.status === "failed") failed.push({ row: i + 1, reason: video.error ?? "The render could not be started" });
  };
  await runWithConcurrency(allowedRows, BATCH_CONCURRENCY, startRow);
  failed.sort((a, b) => a.row - b.row);
  return { batchId, videos, skipped, failed };
}

const BATCH_CONCURRENCY = 5;

async function runWithConcurrency(count: number, concurrency: number, task: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const i = next++;
      await task(i);
    }
  });
  await Promise.all(workers);
}

export async function listVideos(ownerId: string = LOCAL_OWNER): Promise<Video[]> {
  const videos = await getStore().list<Video>("video", ownerId);
  videos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return videos;
}

/**
 * Fetch a video and, if it is still rendering, refresh its status from the provider.
 * Pass `PUBLIC_ACCESS` (null) for public access (share page); otherwise the video must belong to the owner.
 */
export async function getVideo(id: string, ownerId: string | null = LOCAL_OWNER, refresh = true): Promise<Video> {
  const video = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  if (!refresh || !video.providerJobId || (video.status !== "processing" && video.status !== "queued")) return video;

  try {
    const update = await getAvatarProviderByName(video.provider).getStatus(video.providerJobId);
    const next: Video = { ...video, ...stripUndefined(update), updatedAt: nowIso() };
    if (next.status !== video.status || next.videoUrl !== video.videoUrl) {
      await getStore().put("video", next);
      await scheduleNotification(video, next);
    }
    return next;
  } catch (err) {
    // Transient provider errors should not flip the job to failed; surface in logs only.
    console.error(`status refresh failed for ${id}:`, err);
    return video;
  }
}

/**
 * Deliver the owner's webhook after the response is sent, so a status poll never waits on a
 * third-party endpoint. Outside a request (tests, scripts) the delivery runs inline.
 */
async function scheduleNotification(prev: Video, next: Video): Promise<void> {
  await afterResponse(() => notifyVideoTransition(prev, next));
}

/** Runs work after the response is sent (Next's after()); inline when there is no request scope. */
async function afterResponse(work: () => Promise<unknown>): Promise<void> {
  const run = () => work().catch((err) => console.error("deferred work failed:", err));
  try {
    after(run);
  } catch {
    await run();
  }
}

export const MAX_FOLDER_NAME = 40;

export const videoPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    /** Folder name; an empty string moves the video back to "unfiled". */
    folder: z.string().trim().max(MAX_FOLDER_NAME).optional(),
  })
  .refine((p) => p.title !== undefined || p.folder !== undefined, "Nothing to update");

export async function updateVideo(id: string, patch: z.infer<typeof videoPatchSchema>, ownerId: string = LOCAL_OWNER): Promise<Video> {
  const existing = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  const next: Video = { ...existing, updatedAt: nowIso() };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.folder !== undefined) {
    if (patch.folder) next.folder = patch.folder;
    else delete next.folder;
  }
  return getStore().put("video", next);
}

/**
 * Count a share-page view. Public: no owner check. Only completed videos accumulate views,
 * so a page opened while rendering is not a view. `gate` runs only for a countable view
 * (the route's per-viewer window), so an early visit does not use up the viewer's slot.
 */
export async function recordView(id: string, gate: () => boolean = () => true): Promise<{ views: number; counted: boolean }> {
  const video = await getStore().get<Video>("video", id);
  if (!video) throw new NotFoundError(`Video ${id} not found`);
  if (video.status !== "completed" || !gate()) return { views: video.views ?? 0, counted: false };
  const views = (video.views ?? 0) + 1;
  await getStore().put("video", { ...video, views, lastViewedAt: nowIso() });
  return { views, counted: true };
}

export const bulkVideoSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), ids: z.array(z.string().min(1)).min(1).max(200) }),
  z.object({ action: z.literal("move"), ids: z.array(z.string().min(1)).min(1).max(200), folder: z.string().trim().max(MAX_FOLDER_NAME) }),
]);

/** Delete or move many videos at once. Ids that are missing or belong to someone else are reported, not failed. */
export async function bulkVideos(input: z.infer<typeof bulkVideoSchema>, ownerId: string = LOCAL_OWNER): Promise<{ done: number; missing: string[] }> {
  const missing: string[] = [];
  let done = 0;
  for (const id of Array.from(new Set(input.ids))) {
    const existing = await getStore().get<Video>("video", id);
    if (!existing || (existing.ownerId ?? LOCAL_OWNER) !== ownerId) {
      missing.push(id);
      continue;
    }
    if (input.action === "delete") await getStore().remove("video", id);
    else await updateVideo(id, { folder: input.folder }, ownerId);
    done += 1;
  }
  return { done, missing };
}

export async function deleteVideo(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  await getStore().remove("video", id);
}

export async function applyAvatarWebhook(providerName: string, body: unknown): Promise<Video | null> {
  const provider = getAvatarProviderByName(providerName);
  const parsed = provider.parseWebhook?.(body);
  if (!parsed) return null;
  const video = await getStore().findBy<Video>("video", "providerJobId", parsed.providerJobId);
  if (!video) return null;
  const next: Video = { ...video, ...stripUndefined(parsed.update), updatedAt: nowIso() };
  await getStore().put("video", next);
  await scheduleNotification(video, next);
  return next;
}

export async function applyTranslationWebhook(providerName: string, body: unknown): Promise<Translation | null> {
  const provider = getTranslateProviderByName(providerName);
  const parsed = provider.parseWebhook?.(body);
  if (!parsed) return null;
  const item = await getStore().findBy<Translation>("translation", "providerJobId", parsed.providerJobId);
  if (!item) return null;
  const next: Translation = { ...item, ...stripUndefined(parsed.update), updatedAt: nowIso() };
  return getStore().put("translation", next);
}

// ---------- Translations ----------

export const translationRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  sourceVideoUrl: z.string().url(),
  targetLanguage: z.string().trim().min(2).max(40),
});

export async function createTranslation(req: z.infer<typeof translationRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const provider = getTranslateProvider();
  const base: Translation = {
    ...req,
    id: newId("tr"),
    ownerId,
    status: "queued",
    provider: provider.name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  try {
    const { providerJobId } = await provider.createTranslation(req);
    base.providerJobId = providerJobId;
    base.status = "processing";
  } catch (err) {
    base.status = "failed";
    base.error = err instanceof Error ? err.message : String(err);
  }
  return getStore().put("translation", base);
}

export async function listTranslations(ownerId: string = LOCAL_OWNER): Promise<Translation[]> {
  const items = await getStore().list<Translation>("translation", ownerId);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

export async function getTranslation(id: string, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const item = owned(await getStore().get<Translation>("translation", id), ownerId, `Translation ${id}`);
  if (!item.providerJobId || (item.status !== "processing" && item.status !== "queued")) return item;
  try {
    const update = await getTranslateProviderByName(item.provider).getStatus(item.providerJobId);
    const next: Translation = { ...item, ...stripUndefined(update), updatedAt: nowIso() };
    if (next.status !== item.status) await getStore().put("translation", next);
    return next;
  } catch (err) {
    console.error(`translation refresh failed for ${id}:`, err);
    return item;
  }
}

export function supportedLanguages(): string[] {
  return getTranslateProvider().supportedLanguages();
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
