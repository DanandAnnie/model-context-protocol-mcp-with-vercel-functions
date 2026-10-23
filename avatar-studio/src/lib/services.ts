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
import { MAX_SCENES, type Avatar, type Translation, type Video, type VideoRequest, type Voice } from "./types";

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

// ---------- Avatars ----------

export async function listAvatars(): Promise<Avatar[]> {
  const [provider, custom] = await Promise.all([
    getAvatarProvider().listAvatars(),
    getStore().list<Avatar>("avatar"),
  ]);
  custom.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return [...custom, ...provider];
}

export async function getAvatar(id: string): Promise<Avatar> {
  const custom = await getStore().get<Avatar>("avatar", id);
  if (custom) return custom;
  const match = (await getAvatarProvider().listAvatars()).find((a) => a.id === id);
  if (!match) throw new NotFoundError(`Avatar ${id} not found`);
  return match;
}

export const createAvatarSchema = z.object({
  name: z.string().trim().min(1).max(80),
  imageUrl: z.string().min(1).refine((v) => v.startsWith("data:image/") || /^https?:\/\//.test(v), "Must be an image URL or uploaded image"),
  gender: z.enum(["male", "female", "neutral"]).optional(),
});

export async function createAvatar(input: z.infer<typeof createAvatarSchema>): Promise<Avatar> {
  const avatar: Avatar = {
    id: newId("av"),
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

export async function deleteAvatar(id: string): Promise<void> {
  const existing = await getStore().get<Avatar>("avatar", id);
  if (!existing) throw new NotFoundError(`Avatar ${id} not found`);
  await getStore().remove("avatar", id);
}

// ---------- Voices ----------

export async function listVoices(): Promise<Voice[]> {
  return getTtsProvider().listVoices();
}

export async function previewVoice(voiceId: string, text: string, speed: number) {
  return getTtsProvider().synthesize(voiceId, text, speed);
}

// ---------- Scripts ----------

export const scriptSchema = z.object({
  topic: z.string().trim().min(3).max(500),
  tone: z.enum(["friendly", "professional", "formal", "energetic", "calm"]).default("friendly"),
  lengthSec: z.number().int().min(10).max(300).default(45),
  language: z.string().trim().min(2).max(40).default("English"),
  audience: z.string().trim().max(120).optional(),
});

export async function generateScript(input: z.infer<typeof scriptSchema>): Promise<string> {
  return getScriptProvider().generate(input);
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

export async function createVideo(req: VideoRequest): Promise<Video> {
  let avatar = await getAvatar(req.avatarId);
  const voices = await listVoices();
  const voice = voices.find((v) => v.id === req.voiceId) ?? null;
  if (!voice) throw new ValidationError(`Voice ${req.voiceId} is not available with the current voice provider`);
  const provider = getAvatarProvider();

  const base: Video = {
    ...req,
    id: newId("vid"),
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

export async function listVideos(): Promise<Video[]> {
  const videos = await getStore().list<Video>("video");
  videos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return videos;
}

/** Fetch a video and, if it is still rendering, refresh its status from the provider. */
export async function getVideo(id: string, refresh = true): Promise<Video> {
  const video = await getStore().get<Video>("video", id);
  if (!video) throw new NotFoundError(`Video ${id} not found`);
  if (!refresh || !video.providerJobId || (video.status !== "processing" && video.status !== "queued")) return video;

  try {
    const update = await getAvatarProviderByName(video.provider).getStatus(video.providerJobId);
    const next: Video = { ...video, ...stripUndefined(update), updatedAt: nowIso() };
    if (next.status !== video.status || next.videoUrl !== video.videoUrl) await getStore().put("video", next);
    return next;
  } catch (err) {
    // Transient provider errors should not flip the job to failed; surface in logs only.
    console.error(`status refresh failed for ${id}:`, err);
    return video;
  }
}

export async function deleteVideo(id: string): Promise<void> {
  const existing = await getStore().get<Video>("video", id);
  if (!existing) throw new NotFoundError(`Video ${id} not found`);
  await getStore().remove("video", id);
}

export async function applyAvatarWebhook(providerName: string, body: unknown): Promise<Video | null> {
  const provider = getAvatarProviderByName(providerName);
  const parsed = provider.parseWebhook?.(body);
  if (!parsed) return null;
  const video = await getStore().findBy<Video>("video", "providerJobId", parsed.providerJobId);
  if (!video) return null;
  const next: Video = { ...video, ...stripUndefined(parsed.update), updatedAt: nowIso() };
  return getStore().put("video", next);
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

export async function createTranslation(req: z.infer<typeof translationRequestSchema>): Promise<Translation> {
  const provider = getTranslateProvider();
  const base: Translation = {
    ...req,
    id: newId("tr"),
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

export async function listTranslations(): Promise<Translation[]> {
  const items = await getStore().list<Translation>("translation");
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

export async function getTranslation(id: string): Promise<Translation> {
  const item = await getStore().get<Translation>("translation", id);
  if (!item) throw new NotFoundError(`Translation ${id} not found`);
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
