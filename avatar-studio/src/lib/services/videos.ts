// Video renders. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { getStore } from "../store";
import { MAX_SCENES } from "../types";
import type { Avatar, Video, VideoRequest, Voice } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { renderLimitFor } from "../billing";
import { LimitError, NotFoundError, ValidationError } from "../errors";
import { getAvatar } from "./avatars";
import { listVoices } from "./voices";
import { owned, scheduleNotification, stripUndefined } from "./shared";

export const backgroundSchema = z.object({ type: z.enum(["color", "image"]), value: z.string().min(1) });

export const videoRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    /** Optional when `scenes` is given; derived from them otherwise. */
    script: z.string().trim().max(5000).optional(),
    scenes: z.array(z.object({ script: z.string().trim().min(1).max(5000), background: backgroundSchema })).min(1).max(MAX_SCENES).optional(),
    avatarId: z.string().min(1),
    voiceId: z.string().min(1),
    aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
    resolution: z.enum(["720p", "1080p"]).default("1080p"),
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

export async function enforceRenderLimit(ownerId: string): Promise<void> {
  const limit = await renderLimitFor(ownerId);
  if (!limit) return;
  const used = await rendersThisMonth(ownerId);
  if (used >= limit) {
    throw new LimitError(`Monthly render limit reached (${used} of ${limit}). The allowance resets on the 1st.`);
  }
}

export interface RenderContext {
  avatar: Avatar;
  voice: Voice;
}

export async function resolveRenderContext(req: Pick<VideoRequest, "avatarId" | "voiceId">, ownerId: string): Promise<RenderContext> {
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
