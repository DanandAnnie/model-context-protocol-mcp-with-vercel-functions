// Video renders. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getAvatarProvider } from "../providers";
import { getStore } from "../store";
import { MAX_SCENES } from "../types";
import type { Avatar, Video, VideoRequest, Voice } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { renderLimitFor } from "../billing";
import { LimitError, ValidationError } from "../errors";
import { getAvatar } from "./avatars";
import { listVoices } from "./voices";

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
