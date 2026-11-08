// Highlight clips: a finished video cut into short clips by the renderer (HeyGen AI Clipping). Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { HIGHLIGHT_FRAMES, HIGHLIGHT_LENGTHS, type HighlightJob, type Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { owned } from "./shared";
import { getVideo } from "./videos";
import { jobChecker } from "./job-checks";

/** Clipping jobs kept per video; another needs one deleted first. */
export const MAX_HIGHLIGHT_JOBS = 5;

/** How long the renderer is given to say where the source video is. */
const SOURCE_TIMEOUT_MS = 10_000;

/** What the account sees of a set: never the renderer or its job id, which stay on the server. */
export type PublicHighlight = Omit<HighlightJob, "ownerId" | "provider" | "providerJobId">;
export function publicHighlight(job: HighlightJob): PublicHighlight {
  const { ownerId: _o, provider: _p, providerJobId: _j, ...rest } = job;
  void _o;
  void _p;
  void _j;
  return rest;
}

/** Follows sets being cut, and renews finished sets' links, without asking the renderer more than it needs. */
const checks = jobChecker<HighlightJob>((job) => refreshHighlights(job));

/** Forgets when sets were last asked about (tests). */
export function forgetHighlightChecks(): void {
  checks.forget();
}

export const highlightRequestSchema = z.object({
  lengths: z
    .array(z.enum(HIGHLIGHT_LENGTHS, { error: "A clip is 30, 60, or 180 seconds long" }))
    .min(1, "Choose at least one clip length")
    .max(HIGHLIGHT_LENGTHS.length)
    .transform((ls) => HIGHLIGHT_LENGTHS.filter((l) => ls.includes(l))),
  frame: z.enum(HIGHLIGHT_FRAMES, { error: "Clips are framed 9:16, 16:9, or 1:1" }).default("9:16"),
  captions: z.boolean().default(true),
  // One line, as the renderer reads it; blank is none.
  prompt: z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().max(500, "Say what to look for in at most 500 characters"))
    .optional()
    .transform((s) => s || undefined),
});

export const highlightJobIdSchema = z.string().regex(/^hl_[A-Za-z0-9_-]{1,64}$/, "Unknown clipping job");

export function highlightsAvailable(): boolean {
  return typeof getAvatarProvider().startHighlights === "function";
}

/** The account's clipping jobs for a video, newest first; any still running, or holding old links, is asked about first. */
export async function listHighlights(videoId: string, ownerId: string = LOCAL_OWNER): Promise<HighlightJob[]> {
  await getVideo(videoId, ownerId, false);
  const jobs = (await getStore().list<HighlightJob>("highlight", ownerId)).filter((j) => j.videoId === videoId);
  const fresh = await checks.follow(jobs);
  return fresh.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Everything a start would refuse, checked before it counts against the hourly limit. */
export async function assertCanStartHighlights(videoId: string, input: z.infer<typeof highlightRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<Video> {
  const provider = getAvatarProvider();
  if (!provider.startHighlights) throw new ValidationError(`Cutting highlight clips is not available with the ${provider.name} renderer`);
  const video = await getVideo(videoId, ownerId, false);
  if (video.deletedAt) throw new ValidationError("Restore the video from the trash to cut clips from it");
  if (video.status !== "completed" || !video.videoUrl) throw new ValidationError("Clips are cut from a finished video; wait for this one to render");
  // A clip as long as the whole video would be the video again.
  if (video.durationSec) {
    const tooLong = input.lengths.filter((l) => Number(l) >= video.durationSec!);
    if (tooLong.length) throw new ValidationError(`This video runs ${Math.round(video.durationSec)} seconds, so it has no ${tooLong.map((l) => `${l}-second`).join(" or ")} highlight; choose a shorter length`);
  }
  // Read then written: two starts at the same moment can between them pass the cap.
  const existing = (await getStore().list<HighlightJob>("highlight", ownerId)).filter((j) => j.videoId === videoId);
  if (existing.length >= MAX_HIGHLIGHT_JOBS) throw new ConflictError(`A video keeps at most ${MAX_HIGHLIGHT_JOBS} sets of clips; delete one to cut more`);
  return video;
}

/**
 * Starts cutting one of the account's finished videos into short clips, one per length. The renderer gets a fresh link
 * to the video (a stored one may have expired) and keeps the job; the studio keeps the settings and follows it.
 */
export async function startHighlights(videoId: string, input: z.infer<typeof highlightRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<HighlightJob> {
  const video = await assertCanStartHighlights(videoId, input, ownerId);
  const provider = getAvatarProvider();
  const { jobId } = await provider.startHighlights!({ videoUrl: await freshVideoUrl(video), title: video.title, ...input });
  const now = nowIso();
  const job: HighlightJob = {
    id: newId("hl"),
    ownerId,
    videoId,
    provider: provider.name,
    providerJobId: jobId,
    status: "processing",
    lengths: input.lengths,
    frame: input.frame,
    captions: input.captions,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    clips: [],
    createdAt: now,
    updatedAt: now,
  };
  await getStore().put("highlight", job);
  // A video deleted for good while the job was being started has already had its sets cleared; this one goes too.
  if (!(await getStore().get<Video>("video", videoId))) {
    await getStore().remove("highlight", job.id);
    throw new NotFoundError(`Video ${videoId} not found`);
  }
  return job;
}

/** Forgets one of a video's clipping jobs and its clips (the renderer's copy expires on its own). */
export async function deleteHighlights(videoId: string, jobId: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const job = owned(await getStore().get<HighlightJob>("highlight", highlightJobIdSchema.parse(jobId)), ownerId, "Clipping job");
  if (job.videoId !== videoId) throw new NotFoundError("Clipping job not found");
  await getStore().remove("highlight", job.id);
}

/** Removes every clipping job of a video, when the video is deleted for good. */
export async function clearHighlights(videoId: string, ownerId: string): Promise<void> {
  const all = await getStore().list<HighlightJob>("highlight", ownerId);
  await Promise.all(all.filter((j) => j.videoId === videoId).map((j) => getStore().remove("highlight", j.id)));
}

/** Asks the renderer where a job stands and stores the answer. Never throws: a failed check keeps what was known. */
async function refreshHighlights(job: HighlightJob): Promise<HighlightJob> {
  try {
    const provider = getAvatarProviderByName(job.provider);
    if (!provider.highlightsStatus) return job;
    const out = await provider.highlightsStatus(job.providerJobId);
    const now = nowIso();
    const next: HighlightJob = {
      ...job,
      status: out.status,
      clips: out.clips,
      checkedAt: now,
      updatedAt: out.status !== job.status || out.clips.length !== job.clips.length ? now : job.updatedAt,
    };
    if (out.progress !== undefined && out.status === "processing") next.progress = out.progress;
    else delete next.progress;
    if (out.error) next.error = out.error;
    else delete next.error;
    // Written only over the record that was read, so a delete meanwhile stays deleted.
    return (await getStore().putIf("highlight", next, "updatedAt", job.updatedAt)) ? next : job;
  } catch (err) {
    console.error(`highlight check failed for ${job.id}:`, err);
    return job;
  }
}

/** A link the renderer can download the video from now: asked afresh from the renderer that made it, when that is the clipping one. */
export async function freshVideoUrl(video: Video): Promise<string> {
  if (video.providerJobId && video.provider === getAvatarProvider().name && video.provider !== "mock") {
    try {
      const status = await Promise.race([
        getAvatarProvider().getStatus(video.providerJobId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), SOURCE_TIMEOUT_MS).unref?.()),
      ]);
      if (status.status === "completed" && status.videoUrl) return status.videoUrl;
    } catch {
      // The stored link is tried instead.
    }
  }
  return video.videoUrl!;
}
