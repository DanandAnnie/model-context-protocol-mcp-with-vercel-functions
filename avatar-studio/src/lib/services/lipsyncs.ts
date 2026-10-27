// Lip syncs: a video given a new audio track (a voice-over re-recorded, a line fixed, a dub of one's own), the speaker's
// mouth redrawn by the renderer to match (HeyGen lip sync). Used by API routes only.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { LIPSYNC_MODES, type AudioClip, type LipsyncJob, type Video } from "../types";
import type { LipsyncInput } from "../providers/types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPublicHttpUrl } from "../safe-url";
import { owned, stripUndefined } from "./shared";
import { getVideo, prepareClipOnce } from "./videos";
import { getClip } from "./clips";
import { freshVideoUrl } from "./highlights";
import { jobChecker } from "./job-checks";
import { withSuffix } from "../text";

/** Lip-synced videos an account keeps; another needs one deleted first. */
export const MAX_LIPSYNCS = 50;

export const lipsyncRequestSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    /** The footage: one of the account's finished videos, or a public https link to a video. */
    videoId: z.string().trim().min(1).optional(),
    sourceUrl: z.string().trim().max(2000, "The link is too long").optional(),
    /** The new audio: one of the account's audio clips, or a public https link to an audio file. */
    clipId: z.string().trim().min(1).optional(),
    audioUrl: z.string().trim().max(2000, "The link is too long").optional(),
    mode: z.enum(LIPSYNC_MODES).default("speed"),
  })
  .refine((v) => !!v.videoId !== !!v.sourceUrl, { message: "Choose one of your videos or paste a link to a video", path: ["sourceUrl"] })
  .refine((v) => !!v.clipId !== !!v.audioUrl, { message: "Choose one of your audio clips or paste a link to the new audio", path: ["audioUrl"] });

export const lipsyncIdSchema = z.string().regex(/^ls_[A-Za-z0-9_-]{1,64}$/, "Unknown lip sync");

/** A client's key for one start (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const lipsyncKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function lipsyncAvailable(): boolean {
  return typeof getAvatarProvider().startLipsync === "function";
}

/** What the account sees of a lip sync: never the renderer or its job id, which stay on the server. */
export type PublicLipsync = Omit<LipsyncJob, "ownerId" | "provider" | "providerJobId">;
export function publicLipsync(job: LipsyncJob): PublicLipsync {
  const { ownerId: _o, provider: _p, providerJobId: _j, ...rest } = job;
  void _o;
  void _p;
  void _j;
  return rest;
}

const checks = jobChecker<LipsyncJob>((job) => refreshLipsync(job));

/** Forgets when lip syncs were last asked about (tests). */
export function forgetLipsyncChecks(): void {
  checks.forget();
}

/** The account's lip-synced videos, newest first; any still running, or holding an old link, is asked about first. */
export async function listLipsyncs(ownerId: string = LOCAL_OWNER): Promise<LipsyncJob[]> {
  const jobs = await getStore().list<LipsyncJob>("lipsync", ownerId);
  return (await checks.follow(jobs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A link the renderer downloads itself: a public https address (not this network's, say). */
async function publicLink(url: string, what: string): Promise<string> {
  if (!/^https:\/\/[^\s]+$/i.test(url) || !URL.canParse(url)) throw new ValidationError(`Paste a public https link to ${what}`);
  try {
    await assertPublicHttpUrl(url, `The link to ${what}`);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : `Paste a public https link to ${what}`);
  }
  return url;
}

/** What a start would sync, and its title: checked before it counts against the hourly limit. */
export async function resolveLipsyncSources(input: z.infer<typeof lipsyncRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<{ title: string; video?: Video; url?: string; clip?: AudioClip; audioUrl?: string }> {
  const provider = getAvatarProvider();
  if (!provider.startLipsync) throw new ValidationError(`Lip sync is not available with the ${provider.name} renderer`);
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<LipsyncJob>("lipsync", ownerId)).length >= MAX_LIPSYNCS) throw new ConflictError(`An account keeps at most ${MAX_LIPSYNCS} lip-synced videos; delete one to make another`);
  let video: Video | undefined;
  let url: string | undefined;
  if (input.videoId) {
    video = await getVideo(input.videoId, ownerId, false);
    if (video.deletedAt) throw new ValidationError("Restore the video from the trash to lip-sync it");
    if (video.status !== "completed" || !video.videoUrl) throw new ValidationError("Only a finished video can be lip-synced; wait for this one to render");
  } else {
    url = await publicLink(input.sourceUrl!, "the video");
  }
  let clip: AudioClip | undefined;
  let audioUrl: string | undefined;
  if (input.clipId) {
    try {
      clip = await getClip(input.clipId, ownerId);
    } catch (err) {
      if (err instanceof NotFoundError) throw new ValidationError("That audio clip is no longer available; choose another or upload it again");
      throw err;
    }
  } else {
    audioUrl = await publicLink(input.audioUrl!, "the new audio");
  }
  const title = input.title || (video ? withSuffix(video.title, " (lip-synced)", 120) : "Lip-synced video");
  return { title, video, url, clip, audioUrl };
}

/**
 * Starts syncing one video to new audio; the renderer keeps the job and the studio follows it. With a client `key`, the
 * job's id is derived from the account and the key: a start retried with the same key (after a timeout, say) returns the
 * job already stored, or, when the first try reached the renderer but was never stored, sends the renderer the same
 * idempotency key, so it is not synced or paid for twice. `admit` runs once everything is checked, before the renderer
 * is asked (the hourly limit), so a refused or repeated start does not count.
 */
export async function startLipsync(input: z.infer<typeof lipsyncRequestSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<LipsyncJob> {
  const id = opts.key ? `ls_${createHash("sha256").update(`${ownerId}\0${opts.key}`).digest("base64url").slice(0, 32)}` : newId("ls");
  const existing = opts.key ? await getStore().get<LipsyncJob>("lipsync", id) : null;
  if (existing && existing.ownerId === ownerId) {
    // The same key with other footage, audio, or mode is a mistake to say, not a start to repeat.
    const sameVideo = input.videoId ? existing.videoId === input.videoId : existing.sourceUrl === input.sourceUrl;
    const sameAudio = input.clipId ? existing.clipId === input.clipId : existing.audioUrl === input.audioUrl;
    if (!sameVideo || !sameAudio || existing.mode !== input.mode) throw new ConflictError("This Idempotency-Key was already used for another lip sync; send a new key");
    return existing;
  }
  const source = await resolveLipsyncSources(input, ownerId);
  opts.admit?.();
  const provider = getAvatarProvider();
  let audio: LipsyncInput["audio"];
  if (source.clip) {
    // A clip is uploaded to the renderer once, as for an audio scene, and named by its asset id from then on.
    if (!provider.prepareAudio) throw new ValidationError(`Audio clips cannot be sent to the ${provider.name} renderer; paste a link to the audio instead`);
    const prepared = await prepareClipOnce(provider, source.clip, ownerId);
    const assetId = prepared.providerAssetIds?.[provider.assetKey ?? provider.name];
    if (!assetId) throw new Error(`The ${provider.name} renderer kept no upload of audio clip ${source.clip.id}`);
    audio = { type: "asset", assetId };
  } else {
    audio = { type: "url", url: source.audioUrl! };
  }
  const videoUrl = source.video ? await freshVideoUrl(source.video) : source.url!;
  const { jobId } = await provider.startLipsync!({ videoUrl, audio, mode: input.mode, title: source.title, key: id });
  const now = nowIso();
  const job: LipsyncJob = stripUndefined({
    id,
    ownerId,
    title: source.title,
    videoId: source.video?.id,
    sourceUrl: source.url,
    clipId: source.clip?.id,
    audioUrl: source.audioUrl,
    mode: input.mode,
    provider: provider.name,
    providerJobId: jobId,
    status: "processing" as const,
    createdAt: now,
    updatedAt: now,
  });
  await getStore().put("lipsync", job);
  // A video deleted for good while the job was being started has already had its lip syncs cleared; this one goes too.
  if (source.video && !(await getStore().get<Video>("video", source.video.id))) {
    await getStore().remove("lipsync", job.id);
    throw new NotFoundError(`Video ${source.video.id} not found`);
  }
  return job;
}

/** Removes every lip sync of a library video, when the video is deleted for good (the synced copy is its footage too). */
export async function clearLipsyncs(videoId: string, ownerId: string): Promise<void> {
  const all = await getStore().list<LipsyncJob>("lipsync", ownerId);
  await Promise.all(all.filter((j) => j.videoId === videoId).map((j) => getStore().remove("lipsync", j.id)));
}

/** Forgets one lip-synced video (the renderer's copy expires on its own). */
export async function deleteLipsync(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const job = owned(await getStore().get<LipsyncJob>("lipsync", lipsyncIdSchema.parse(id)), ownerId, "Lip sync");
  await getStore().remove("lipsync", job.id);
}

/** Asks the renderer where a lip sync stands and stores the answer. Never throws: a failed check keeps what was known. */
async function refreshLipsync(job: LipsyncJob): Promise<LipsyncJob> {
  try {
    const provider = getAvatarProviderByName(job.provider);
    if (!provider.lipsyncStatus) return job;
    const out = await provider.lipsyncStatus(job.providerJobId);
    const now = nowIso();
    const { videoUrl: _v, durationSec: _d, error: _e, ...kept } = job;
    void _v;
    void _d;
    void _e;
    const next: LipsyncJob = { ...kept, ...stripUndefined(out), checkedAt: now, updatedAt: out.status !== job.status ? now : job.updatedAt };
    // Written only over the record that was read, so a delete meanwhile stays deleted.
    return (await getStore().putIf("lipsync", next, "updatedAt", job.updatedAt)) ? next : job;
  } catch (err) {
    console.error(`lip sync check failed for ${job.id}:`, err);
    return job;
  }
}
