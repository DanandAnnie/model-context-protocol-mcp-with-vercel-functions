// Cleaned recordings: filler words ("um", "uh") and overlong silences cut out of a video by the renderer (HeyGen filler
// word removal), one cleaned cut back. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import type { CleanupJob } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, ValidationError } from "../errors";
import { assertPublicHttpUrl } from "../safe-url";
import { owned, stripUndefined } from "./shared";
import { getVideo } from "./videos";
import { freshVideoUrl } from "./highlights";
import { jobChecker } from "./job-checks";

/** Cleaned recordings an account keeps; another needs one deleted first. */
export const MAX_CLEANUPS = 50;

export const cleanupRequestSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    /** One of the account's finished videos, or a public https link to a recording. */
    videoId: z.string().trim().min(1).optional(),
    sourceUrl: z.string().trim().optional(),
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
export async function resolveCleanupSource(input: z.infer<typeof cleanupRequestSchema>, ownerId: string = LOCAL_OWNER) {
  const provider = getAvatarProvider();
  if (!provider.startCleanup) throw new ValidationError(`Cleaning up recordings is not available with the ${provider.name} renderer`);
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<CleanupJob>("cleanup", ownerId)).length >= MAX_CLEANUPS) throw new ConflictError(`An account keeps at most ${MAX_CLEANUPS} cleaned recordings; delete one to clean another`);
  if (input.videoId) {
    const video = await getVideo(input.videoId, ownerId, false);
    if (video.deletedAt) throw new ValidationError("Restore the video from the trash to clean it up");
    if (video.status !== "completed" || !video.videoUrl) throw new ValidationError("Only a finished video can be cleaned up; wait for this one to render");
    return { video, title: input.title || `${video.title} (cleaned)`.slice(0, 120) };
  }
  // The renderer downloads the link itself, so it must be a public https address (not this network's, say).
  const url = input.sourceUrl!;
  if (!/^https:\/\//i.test(url)) throw new ValidationError("Paste a public https link to the recording");
  try {
    await assertPublicHttpUrl(url, "The recording's link");
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : "Paste a public https link to the recording");
  }
  return { url, title: input.title || "Cleaned recording" };
}

/** Starts cleaning one recording; the renderer keeps the job and the studio follows it. */
export async function startCleanup(input: z.infer<typeof cleanupRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<CleanupJob> {
  const source = await resolveCleanupSource(input, ownerId);
  const provider = getAvatarProvider();
  const id = newId("cu");
  // The studio's id doubles as the renderer's idempotency key, so a retried start never pays twice.
  const videoUrl = "video" in source && source.video ? await freshVideoUrl(source.video) : source.url!;
  const { jobId } = await provider.startCleanup!({ videoUrl, title: source.title, key: id });
  const now = nowIso();
  const job: CleanupJob = stripUndefined({
    id,
    ownerId,
    title: source.title,
    videoId: "video" in source ? source.video?.id : undefined,
    sourceUrl: "url" in source ? source.url : undefined,
    provider: provider.name,
    providerJobId: jobId,
    status: "processing" as const,
    createdAt: now,
    updatedAt: now,
  });
  return getStore().put("cleanup", job);
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
    const next: CleanupJob = {
      ...kept,
      ...stripUndefined({ ...out, progress: out.status === "processing" ? out.progress : undefined }),
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
