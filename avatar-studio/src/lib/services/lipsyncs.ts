// Lip syncs: a video given a new audio track (a voice-over re-recorded, a line fixed, a dub of one's own), the speaker's
// mouth redrawn by the renderer to match (HeyGen lip sync). Used by API routes only.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { LIPSYNC_FRAME_RATES, LIPSYNC_MODES, MAX_LIPSYNC_SEC, MIN_LIPSYNC_PART_SEC, VOICE_RESULT_LINK_MS, type AudioClip, type LipsyncJob, type Video, type VoiceChange } from "../types";
import type { LipsyncInput } from "../providers/types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPublicHttpUrl } from "../safe-url";
import { owned, renameJob, stripUndefined, writeRefresh } from "./shared";
import { getVideo, prepareClipOnce } from "./videos";
import { findClip, getClip } from "./clips";
import { freshVideoUrl } from "./highlights";
import { checkWaitingJobs, jobChecker } from "./job-checks";
import { withSuffix } from "../text";

/** Lip-synced videos an account keeps; another needs one deleted first. */
export const MAX_LIPSYNCS = 50;

/** "" or only spaces, as a field left out. */
const emptyAsAbsent = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);

/** A moment of the footage in seconds, to a tenth; `null` or blank is none. */
const moment = (which: "start" | "end") =>
  z.preprocess(
    (v) => (v === null || (typeof v === "string" && !v.trim()) ? undefined : v),
    z
      .number({ error: `The part's ${which} is a number of seconds` })
      .min(0, `The part's ${which} is a number of seconds from the start of the video`)
      .max(MAX_LIPSYNC_SEC, `The part's ${which} is within the first ${MAX_LIPSYNC_SEC / 3600} hours of the video`)
      .transform((s) => Math.round(s * 10) / 10)
      .optional(),
  );

/** An option asked for is stored as true; false or absent is HeyGen's default and stored as absent. */
const optIn = (name: string) =>
  z.preprocess((v) => (v === null ? undefined : v), z.boolean({ error: `${name} is true or false` }).optional()).transform((v) => (v ? (true as const) : undefined));

export const lipsyncRequestSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    /** The footage: one of the account's finished videos, or a public https link to a video. */
    videoId: z.string().trim().min(1).optional(),
    sourceUrl: z.string().trim().max(2000, "The link is too long").optional(),
    /**
     * The new audio: one of the account's audio clips, a public https link to an audio file, or one of its recordings or
     * texts spoken in an instant voice (the voice changer's).
     */
    // An empty field is one not given, whichever it is.
    clipId: z.preprocess(emptyAsAbsent, z.string().trim().min(1).optional()),
    audioUrl: z.preprocess(emptyAsAbsent, z.string().trim().max(2000, "The link is too long").optional()),
    voiceChangeId: z.preprocess(emptyAsAbsent, z.string().trim().regex(/^vc_[A-Za-z0-9_-]{1,64}$/, "Choose one of your recordings in another voice").optional()),
    mode: z.enum(LIPSYNC_MODES).default("speed"),
    /** Only this part of the footage is synced (the rest kept as it is); from its start, or to its end, when one is left out. */
    startSec: moment("start"),
    endSec: moment("end"),
    removeMusic: optIn("removeMusic"),
    enhanceSpeech: optIn("enhanceSpeech"),
    keepLength: optIn("keepLength"),
    keepFormat: optIn("keepFormat"),
    /** How the result's frames are timed; HeyGen chooses when absent (or blank). */
    frameRate: z.preprocess((v) => (v === null || (typeof v === "string" && !v.trim()) ? undefined : v), z.enum(LIPSYNC_FRAME_RATES, { error: "frameRate is constant, variable, or source" }).optional()),
  })
  // From the start is the same as no start; a part needs some length to sync.
  .transform((v) => ({ ...v, startSec: v.startSec === 0 ? undefined : v.startSec }))
  .refine((v) => v.endSec === undefined || v.endSec - (v.startSec ?? 0) >= MIN_LIPSYNC_PART_SEC, { message: `The end of the part must be at least ${MIN_LIPSYNC_PART_SEC} second after its start`, path: ["endSec"] })
  .refine((v) => !!v.videoId !== !!v.sourceUrl, { message: "Choose one of your videos or paste a link to a video", path: ["sourceUrl"] })
  .refine((v) => [v.clipId, v.audioUrl, v.voiceChangeId].filter(Boolean).length === 1, { message: "Choose one of your audio clips or recordings in another voice, or paste a link to the new audio", path: ["audioUrl"] });

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

/** Renames one of the owner's lip syncs: `{ title }` → it as the account sees it. */
export async function renameLipsync(id: string, title: string, ownerId: string = LOCAL_OWNER): Promise<PublicLipsync> {
  if (!lipsyncIdSchema.safeParse(id).success) throw new NotFoundError("Lip sync not found");
  return publicLipsync(await renameJob<LipsyncJob>("lipsync", id, title, ownerId, "Lip sync"));
}

const checks = jobChecker<LipsyncJob>((job) => refreshLipsync(job));

/** The scheduled background check of these jobs, across every account (see checkWaitingJobs). */
export function checkLipsyncsInBackground(max?: number, now?: number): Promise<{ checked: number; moved: number }> {
  return checkWaitingJobs("lipsync", checks, max, now);
}

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
export async function resolveLipsyncSources(input: z.infer<typeof lipsyncRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<{ title: string; video?: Video; url?: string; clip?: AudioClip; audioUrl?: string; voiceChange?: VoiceChange }> {
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
  let voiceChange: VoiceChange | undefined;
  if (input.voiceChangeId) {
    // The renderer's own output, so its link is sent as it is (it is the renderer's, signed for a limited time).
    try {
      voiceChange = owned(await getStore().get<VoiceChange>("voicechange", input.voiceChangeId), ownerId, "Recording");
    } catch (err) {
      if (err instanceof NotFoundError) throw new ValidationError("That recording in another voice is no longer available; choose another");
      throw err;
    }
    if (voiceChange.status !== "completed" || !voiceChange.audioUrl) throw new ValidationError(voiceChange.status === "failed" ? `“${voiceChange.title}” could not be made; choose another recording` : `“${voiceChange.title}” is still being spoken; try again once it is ready`);
    // Its link is another renderer's, or past the time it is signed for: the renderer would fail the job after it started.
    if (voiceChange.provider !== provider.name) throw new ValidationError(`“${voiceChange.title}” was made by another renderer; make it again in the voice changer`);
    if (Date.now() - Date.parse(voiceChange.checkedAt ?? voiceChange.updatedAt) > VOICE_RESULT_LINK_MS) {
      // One kept as a clip is still there to use as the new audio.
      const kept = voiceChange.savedClipId ? await findClip(voiceChange.savedClipId, ownerId) : null;
      throw new ValidationError(`“${voiceChange.title}” was made over an hour ago, and its link from the renderer has expired; ${kept ? `choose the audio clip “${kept.name}” you kept of it instead` : "make it again in the voice changer"}`);
    }
  } else if (input.clipId) {
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
  return { title, video, url, clip, audioUrl, voiceChange };
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
    const sameAudio = input.voiceChangeId ? existing.voiceChangeId === input.voiceChangeId : input.clipId ? existing.clipId === input.clipId : !!input.audioUrl && existing.audioUrl === input.audioUrl;
    const sameOptions = (["startSec", "endSec", "removeMusic", "enhanceSpeech", "keepLength", "keepFormat", "frameRate"] as const).every((k) => existing[k] === input[k]);
    if (!sameVideo || !sameAudio || existing.mode !== input.mode || !sameOptions) throw new ConflictError("This Idempotency-Key was already used for another lip sync; send a new key");
    return existing;
  }
  const source = await resolveLipsyncSources(input, ownerId);
  // A library video's length is known: a part past its end is said before anything is sent.
  const length = source.video?.durationSec;
  if (length && input.startSec !== undefined && input.startSec >= length - MIN_LIPSYNC_PART_SEC) throw new ValidationError(`The video is ${lengthSaid(length)} long; start the part before ${lengthSaid(Math.floor(Math.max(0, length - MIN_LIPSYNC_PART_SEC)))}`);
  if (length && input.endSec !== undefined && input.endSec > length + 0.5) throw new ValidationError(`The video is ${lengthSaid(length)} long; end the part by then, or leave the end out to sync to the end`);
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
    audio = { type: "url", url: source.voiceChange?.audioUrl ?? source.audioUrl! };
  }
  const videoUrl = source.video ? await freshVideoUrl(source.video) : source.url!;
  const options = stripUndefined({ startSec: input.startSec, endSec: input.endSec, removeMusic: input.removeMusic, enhanceSpeech: input.enhanceSpeech, keepLength: input.keepLength, keepFormat: input.keepFormat, frameRate: input.frameRate });
  const { jobId } = await provider.startLipsync!({ videoUrl, audio, mode: input.mode, title: source.title, key: id, ...options });
  const now = nowIso();
  const job: LipsyncJob = stripUndefined({
    id,
    ownerId,
    title: source.title,
    videoId: source.video?.id,
    sourceUrl: source.url,
    clipId: source.clip?.id,
    audioUrl: source.audioUrl,
    voiceChangeId: source.voiceChange?.id,
    audioName: source.voiceChange?.title,
    mode: input.mode,
    ...options,
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

/**
 * A finished lip sync's captions, timed to the lip-synced video, as the renderer made them (read from it each time,
 * since its link is signed for a short while): its title and cues.
 */
export async function lipsyncCaptions(id: string, ownerId: string = LOCAL_OWNER, opts: { admit?: () => void } = {}): Promise<{ title: string; cues: Array<{ startMs: number; endMs: number; text: string }> }> {
  if (!lipsyncIdSchema.safeParse(id).success) throw new NotFoundError("Lip sync not found");
  const job = owned(await getStore().get<LipsyncJob>("lipsync", id), ownerId, "Lip sync");
  if (job.status !== "completed") throw new ValidationError(job.status === "failed" ? "This lip sync failed, so it has no captions" : "The captions are ready once the lip sync is finished");
  const provider = getAvatarProviderByName(job.provider);
  if (!provider.lipsyncCaptions) throw new ValidationError(`The ${provider.name} renderer makes no captions for lip syncs`);
  // Counted only once the renderer is about to be asked.
  opts.admit?.();
  const cues = await provider.lipsyncCaptions(job.providerJobId);
  if (cues === null) throw new NotFoundError("The renderer has no captions for this lip sync");
  if (!cues.length) throw new ValidationError("This lip sync has no spoken words to caption");
  return { title: job.title, cues };
}

/** Asks the renderer where a lip sync stands and stores the answer. Never throws: a failed check keeps what was known. */
async function refreshLipsync(job: LipsyncJob): Promise<LipsyncJob> {
  try {
    const provider = getAvatarProviderByName(job.provider);
    if (!provider.lipsyncStatus) return job;
    const out = await provider.lipsyncStatus(job.providerJobId);
    const now = nowIso();
    // Built over the latest row (a rename may land while the renderer is asked), and written only over it.
    return await writeRefresh<LipsyncJob>("lipsync", job, (current) => {
      const { videoUrl: _v, durationSec: _d, error: _e, ...kept } = current;
      void _v;
      void _d;
      void _e;
      return { ...kept, ...stripUndefined(out), checkedAt: now };
    });
  } catch (err) {
    console.error(`lip sync check failed for ${job.id}:`, err);
    return job;
  }
}

/** A length as said to the account: "42 seconds", "3:05". */
function lengthSaid(sec: number): string {
  const s = Math.round(sec);
  return s < 60 ? `${s} second${s === 1 ? "" : "s"}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
