// Cleaned recordings: filler words ("um", "uh") and overlong silences cut out of a video by the renderer (HeyGen filler
// word removal), one cleaned cut back. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import type { CleanupJob, Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { createHash } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPublicHttpUrl } from "../safe-url";
import { owned, stripUndefined } from "./shared";
import { getVideo } from "./videos";
import { freshVideoUrl } from "./highlights";
import { jobChecker } from "./job-checks";
import { withSuffix } from "../text";

/** Cleaned recordings an account keeps; another needs one deleted first. */
export const MAX_CLEANUPS = 50;

export const cleanupRequestSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    /** One of the account's finished videos, or a public https link to a recording. */
    videoId: z.string().trim().min(1).optional(),
    sourceUrl: z.string().trim().max(2000, "The link is too long").optional(),
  })
  .refine((v) => !!v.videoId !== !!v.sourceUrl, { message: "Choose one of your videos or paste a link to a recording", path: ["sourceUrl"] });

export const cleanupIdSchema = z.string().regex(/^cu_[A-Za-z0-9_-]{1,64}$/, "Unknown cleanup");

export function cleanupAvailable(): boolean {
  return typeof getAvatarProvider().startCleanup === "function";
}

/** What the account sees of a cleanup: never the renderer or its job id, which stay on the server. */
export type PublicCleanup = Omit<CleanupJob, "ownerId" | "provider" | "providerJobId">;
export function publicCleanup(job: CleanupJob): PublicCleanup {
  const { ownerId: _o, provider: _p, providerJobId: _j, ...rest } = job;
  void _o;
  void _p;
  void _j;
  return rest;
}

const checks = jobChecker<CleanupJob>((job) => refreshCleanup(job));

/** Forgets when cleanups were last asked about (tests). */
export function forgetCleanupChecks(): void {
  checks.forget();
}

/** The account's cleaned recordings, newest first; any still running, or holding an old link, is asked about first. */
export async function listCleanups(ownerId: string = LOCAL_OWNER): Promise<CleanupJob[]> {
  const jobs = await getStore().list<CleanupJob>("cleanup", ownerId);
  return (await checks.follow(jobs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** What a start would clean, and its title: checked before it counts against the hourly limit. */
export async function resolveCleanupSource(input: z.infer<typeof cleanupRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<{ title: string; video?: Video; url?: string }> {
  const provider = getAvatarProvider();
  if (!provider.startCleanup) throw new ValidationError(`Cleaning up recordings is not available with the ${provider.name} renderer`);
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<CleanupJob>("cleanup", ownerId)).length >= MAX_CLEANUPS) throw new ConflictError(`An account keeps at most ${MAX_CLEANUPS} cleaned recordings; delete one to clean another`);
  if (input.videoId) {
    const video = await getVideo(input.videoId, ownerId, false);
    if (video.deletedAt) throw new ValidationError("Restore the video from the trash to clean it up");
    if (video.status !== "completed" || !video.videoUrl) throw new ValidationError("Only a finished video can be cleaned up; wait for this one to render");
    return { video, title: input.title || withSuffix(video.title, " (cleaned)", 120) };
  }
  // The renderer downloads the link itself, so it must be a public https address (not this network's, say).
  const url = input.sourceUrl!;
  if (!/^https:\/\/[^\s]+$/i.test(url) || !URL.canParse(url)) throw new ValidationError("Paste a public https link to the recording");
  try {
    await assertPublicHttpUrl(url, "The recording's link");
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : "Paste a public https link to the recording");
  }
  return { url, title: input.title || "Cleaned recording" };
}

/** A client's key for one start (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const cleanupKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

/**
 * Starts cleaning one recording; the renderer keeps the job and the studio follows it. With a client `key`, the job's id
 * is derived from the account and the key: a start retried with the same key (after a timeout, say) returns the job
 * already stored, or, when the first try reached the renderer but was never stored, sends the renderer the same
 * idempotency key, so it is not cleaned or paid for twice. `admit` runs once everything is checked, before the renderer
 * is asked (the hourly limit), so a refused or repeated start does not count.
 */
export async function startCleanup(input: z.infer<typeof cleanupRequestSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<CleanupJob> {
  const id = opts.key ? `cu_${createHash("sha256").update(`${ownerId}\0${opts.key}`).digest("base64url").slice(0, 32)}` : newId("cu");
  const existing = opts.key ? await getStore().get<CleanupJob>("cleanup", id) : null;
  if (existing && existing.ownerId === ownerId) {
    // The same key with another recording is a mistake to say, not a start to repeat.
    const same = input.videoId ? existing.videoId === input.videoId : existing.sourceUrl === input.sourceUrl;
    if (!same) throw new ConflictError("This Idempotency-Key was already used to clean another recording; send a new key");
    return existing;
  }
  const source = await resolveCleanupSource(input, ownerId);
  opts.admit?.();
  const provider = getAvatarProvider();
  const videoUrl = source.video ? await freshVideoUrl(source.video) : source.url!;
  const { jobId } = await provider.startCleanup!({ videoUrl, title: source.title, key: id });
  const now = nowIso();
  const job: CleanupJob = stripUndefined({
    id,
    ownerId,
    title: source.title,
    videoId: source.video?.id,
    sourceUrl: source.url,
    provider: provider.name,
    providerJobId: jobId,
    status: "processing" as const,
    createdAt: now,
    updatedAt: now,
  });
  await getStore().put("cleanup", job);
  // A video deleted for good while the job was being started has already had its cleanups cleared; this one goes too.
  if (source.video && !(await getStore().get<Video>("video", source.video.id))) {
    await getStore().remove("cleanup", job.id);
    throw new NotFoundError(`Video ${source.video.id} not found`);
  }
  return job;
}

/** Removes every cleanup of a library video, when the video is deleted for good (the cleaned copy is its content too). */
export async function clearCleanups(videoId: string, ownerId: string): Promise<void> {
  const all = await getStore().list<CleanupJob>("cleanup", ownerId);
  await Promise.all(all.filter((j) => j.videoId === videoId).map((j) => getStore().remove("cleanup", j.id)));
}

/** Forgets one cleaned recording (the renderer's copy expires on its own). */
export async function deleteCleanup(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const job = owned(await getStore().get<CleanupJob>("cleanup", cleanupIdSchema.parse(id)), ownerId, "Cleanup");
  await getStore().remove("cleanup", job.id);
}

/** Asks the renderer where a cleanup stands and stores the answer. Never throws: a failed check keeps what was known. */
async function refreshCleanup(job: CleanupJob): Promise<CleanupJob> {
  try {
    const provider = getAvatarProviderByName(job.provider);
    if (!provider.cleanupStatus) return job;
    const out = await provider.cleanupStatus(job.providerJobId);
    const now = nowIso();
    const { progress: _p, videoUrl: _v, thumbnailUrl: _t, error: _e, ...kept } = job;
    void _p;
    void _v;
    void _t;
    void _e;
    // The share removed is worked out from the two lengths when both are known (the renderer's own figure otherwise).
    const reductionPct = out.originalSec && out.outputSec !== undefined ? Math.round((1 - out.outputSec / out.originalSec) * 1000) / 10 : out.reductionPct;
    const next: CleanupJob = {
      ...kept,
      ...stripUndefined({ ...out, reductionPct, progress: out.status === "processing" ? out.progress : undefined }),
      checkedAt: now,
      updatedAt: out.status !== job.status ? now : job.updatedAt,
    };
    // Written only over the record that was read, so a delete meanwhile stays deleted.
    return (await getStore().putIf("cleanup", next, "updatedAt", job.updatedAt)) ? next : job;
  } catch (err) {
    console.error(`cleanup check failed for ${job.id}:`, err);
    return job;
  }
}
