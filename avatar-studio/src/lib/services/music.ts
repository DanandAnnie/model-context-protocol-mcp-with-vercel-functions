// Background music: a track of the renderer's music catalog (HeyGen's), found by describing it, mixed under a finished
// library video with any sound effects of its catalog placed at moments of the video, and rendered as a new video
// (HeyGen HyperFrames). Used by API routes only.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { MAX_MUSIC_EFFECTS, MUSIC_VOLUMES, type MusicEffect, type MusicJob, type MusicTrack, type MusicVolume, type Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { owned, stripUndefined } from "./shared";
import { getVideo } from "./videos";
import { freshVideoUrl } from "./highlights";
import { jobChecker } from "./job-checks";
import { withSuffix } from "../text";

/** Videos with music an account keeps; another needs one deleted first. */
export const MAX_MUSIC_MIXES = 50;
/** The longest video music is mixed under (a render's length is the video's). */
export const MAX_MUSIC_VIDEO_SEC = 30 * 60;

export const musicQuerySchema = z.string().trim().min(2, "Describe the music in a few words").max(200, "Describe the music in at most 200 characters");
export const effectQuerySchema = z.string().trim().min(2, "Describe the sound effect in a few words").max(200, "Describe the sound effect in at most 200 characters");

/** A sound effect chosen from a search, and the moment of the video it plays from. */
export const musicEffectSchema = z.object({
  trackId: z.string().trim().min(1, "Choose a sound effect").max(200),
  query: effectQuerySchema,
  atSec: z.number({ error: "Say when the sound effect plays" }).min(0, "A sound effect plays from 0 seconds or later").max(MAX_MUSIC_VIDEO_SEC),
});

export const musicRequestSchema = z.object({
  /** One of the account's finished videos. */
  videoId: z.string({ error: "Choose one of your videos" }).trim().min(1, "Choose one of your videos"),
  /** The track chosen, and the description it was found with: the track's link is asked for again with it. */
  trackId: z.string().trim().min(1, "Choose a track").max(200),
  query: musicQuerySchema,
  volume: z.enum(Object.keys(MUSIC_VOLUMES) as [MusicVolume, ...MusicVolume[]]).default("low"),
  title: z.string().trim().max(120, "Keep the title to 120 characters").optional(),
  effects: z.array(musicEffectSchema).max(MAX_MUSIC_EFFECTS, `Add at most ${MAX_MUSIC_EFFECTS} sound effects`).default([]),
});

export const musicIdSchema = z.string().regex(/^mm_[A-Za-z0-9_-]{1,64}$/, "Unknown video with music");

/** A client's key for one start (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const musicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function musicAvailable(): boolean {
  const provider = getAvatarProvider();
  return typeof provider.startMusicMix === "function" && typeof provider.searchMusic === "function";
}

/** What the account sees of a mix: never the renderer or its job id, which stay on the server. */
export type PublicMusicJob = Omit<MusicJob, "ownerId" | "provider" | "providerJobId">;
export function publicMusicJob(job: MusicJob): PublicMusicJob {
  const { ownerId: _o, provider: _p, providerJobId: _j, ...rest } = job;
  void _o;
  void _p;
  void _j;
  return rest;
}

/**
 * Tracks of the renderer's catalog matching a description, best first, each with a short-lived link to hear it: music,
 * or with `kind: "effects"` sound effects.
 */
export async function searchMusicTracks(query: string, kind: "music" | "effects" = "music"): Promise<MusicTrack[]> {
  const provider = getAvatarProvider();
  if (!provider.searchMusic) throw new ValidationError(`Background music is not available with the ${provider.name} renderer`);
  return provider.searchMusic((kind === "effects" ? effectQuerySchema : musicQuerySchema).parse(query), kind);
}

/** Effects in the order they play, as compared and stored: one moment to the millisecond, then the track. */
function effectsInOrder<T extends { trackId: string; query: string; atSec: number }>(effects: T[]): T[] {
  return [...effects].map((e) => ({ ...e, atSec: Math.round(e.atSec * 1000) / 1000 })).sort((a, b) => a.atSec - b.atSec || a.trackId.localeCompare(b.trackId) || a.query.localeCompare(b.query));
}
const sameEffects = (a: Array<{ trackId: string; query: string; atSec: number }>, b: Array<{ trackId: string; query: string; atSec: number }>) => {
  const [x, y] = [effectsInOrder(a), effectsInOrder(b)];
  return x.length === y.length && x.every((e, i) => e.trackId === y[i].trackId && e.query === y[i].query && e.atSec === y[i].atSec);
};

/** Seconds as the page shows them, to a tenth (59.96 is 1:00.0), for a message. */
function clock(sec: number): string {
  const tenths = Math.round(sec * 10);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

const checks = jobChecker<MusicJob>((job) => refreshMusic(job));

/** Forgets when mixes were last asked about (tests). */
export function forgetMusicChecks(): void {
  checks.forget();
}

/** The account's videos with music, newest first; any still being mixed, or holding an old link, is asked about first. */
export async function listMusicJobs(ownerId: string = LOCAL_OWNER): Promise<MusicJob[]> {
  const jobs = await getStore().list<MusicJob>("music", ownerId);
  return (await checks.follow(jobs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The video a mix would be made of: checked before the hourly limit counts. */
async function resolveVideo(videoId: string, ownerId: string): Promise<Video> {
  const video = await getVideo(videoId, ownerId, false);
  if (video.deletedAt) throw new ValidationError("Restore the video from the trash to add music to it");
  if (video.status !== "completed" || !video.videoUrl) throw new ValidationError("Only a finished video can be given music; wait for this one to render");
  if (video.transparent) throw new ValidationError("A video with a transparent background has no frame to keep under music; add music to the video it is composited into");
  if (!(video.durationSec && video.durationSec > 0)) throw new ValidationError("This video's length is not known yet; open it once it has played, or try again in a moment");
  if (video.durationSec > MAX_MUSIC_VIDEO_SEC) throw new ValidationError(`Music can be added to videos of up to ${MAX_MUSIC_VIDEO_SEC / 60} minutes`);
  return video;
}

/**
 * Starts mixing a catalog track under one finished video; the renderer keeps the job and the studio follows it. The
 * track is looked up again by its description, as its link is signed only for a short time. With a client `key`, the
 * job's id is derived from the account and the key: a start retried with the same key returns the job already stored,
 * or sends the renderer the same idempotency key, so the mix is not rendered or paid for twice. `admit` runs once
 * everything is checked, before the renderer is asked (the hourly limit); `search` before the catalog is asked again
 * (the account's hourly searches).
 */
export async function startMusic(input: z.infer<typeof musicRequestSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void; search?: () => void } = {}): Promise<MusicJob> {
  const id = opts.key ? `mm_${createHash("sha256").update(`${ownerId}\0${opts.key}`).digest("base64url").slice(0, 32)}` : newId("mm");
  const existing = opts.key ? await getStore().get<MusicJob>("music", id) : null;
  if (existing && existing.ownerId === ownerId) {
    // A title given must be the one kept; one left out took the video's, which is not read again here.
    const same = existing.videoId === input.videoId && existing.trackId === input.trackId && existing.volume === input.volume && existing.query === input.query && sameEffects(existing.effects ?? [], input.effects) && (!input.title || existing.title === input.title);
    if (!same) throw new ConflictError("This Idempotency-Key was already used for another video with music; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (!provider.startMusicMix || !provider.searchMusic) throw new ValidationError(`Background music is not available with the ${provider.name} renderer`);
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<MusicJob>("music", ownerId)).length >= MAX_MUSIC_MIXES) throw new ConflictError(`An account keeps at most ${MAX_MUSIC_MIXES} videos with music; delete one to make another`);
  const video = await resolveVideo(input.videoId, ownerId);
  const wanted = effectsInOrder(input.effects);
  const late = wanted.find((e) => e.atSec >= video.durationSec!);
  if (late) throw new ValidationError(`A sound effect at ${clock(late.atSec)} is past the end of the video (${clock(video.durationSec!)}); move it earlier`);
  // The track's link, and each effect's (one search per description), are asked for again, as the links expire: all
  // counted first, then asked together, so a slow catalog takes one search's time rather than six.
  const queries = [...new Set(wanted.map((e) => e.query))];
  for (let i = 0; i <= queries.length; i++) opts.search?.();
  const [musicHits, ...effectHits] = await Promise.all([provider.searchMusic(input.query), ...queries.map((q) => provider.searchMusic!(q, "effects"))]);
  const track = musicHits.find((t) => t.id === input.trackId);
  if (!track) throw new ValidationError("That track is no longer offered for this description; search again and choose one");
  const found = new Map<string, MusicTrack[]>(queries.map((q, i) => [q, effectHits[i]]));
  const effects = wanted.map((e) => {
    const hit = found.get(e.query)?.find((t) => t.id === e.trackId);
    if (!hit) throw new ValidationError(`A sound effect is no longer offered for “${e.query}”; search again and choose one`);
    return { ...e, track: hit };
  });
  opts.admit?.();
  const title = input.title || withSuffix(video.title, " (with music)", 120);
  const { jobId } = await provider.startMusicMix({
    videoUrl: await freshVideoUrl(video),
    durationSec: video.durationSec!,
    aspect: video.aspect,
    musicUrl: track.previewUrl,
    musicDurationSec: track.durationSec,
    volume: MUSIC_VOLUMES[input.volume],
    ...(effects.length ? { effects: effects.map((e) => ({ url: e.track.previewUrl, atSec: e.atSec, durationSec: e.track.durationSec })) } : {}),
    title,
    key: id,
  });
  const now = nowIso();
  const job: MusicJob = stripUndefined({
    id,
    ownerId,
    title,
    videoId: video.id,
    trackId: track.id,
    trackName: track.name,
    query: input.query,
    volume: input.volume,
    effects: effects.length ? effects.map((e): MusicEffect => ({ trackId: e.trackId, name: e.track.name, query: e.query, atSec: e.atSec })) : undefined,
    provider: provider.name,
    providerJobId: jobId,
    status: "processing" as const,
    createdAt: now,
    updatedAt: now,
  });
  await getStore().put("music", job);
  // A video deleted for good while the mix was being started has already had its mixes cleared; this one goes too.
  if (!(await getStore().get<Video>("video", video.id))) {
    await getStore().remove("music", job.id);
    throw new NotFoundError(`Video ${video.id} not found`);
  }
  return job;
}

/**
 * Deletes a mix's render at the renderer: it is a full copy of the account's footage in the renderer's shared account.
 * Never throws; a render left behind is logged (the studio no longer offers it to anyone).
 */
export async function dropMusicRender(job: MusicJob): Promise<void> {
  try {
    await getAvatarProviderByName(job.provider).deleteMusicMix?.(job.providerJobId);
  } catch (err) {
    console.error(`music render ${job.id} was not deleted at the renderer:`, err);
  }
}

/** Removes every mix of a library video, when the video is deleted for good (the mix is its footage too). */
export async function clearMusicJobs(videoId: string, ownerId: string): Promise<void> {
  const all = (await getStore().list<MusicJob>("music", ownerId)).filter((j) => j.videoId === videoId);
  await Promise.all(all.map(async (j) => (await getStore().remove("music", j.id), await dropMusicRender(j))));
}

/** Forgets one video with music, and deletes its render at the renderer. */
export async function deleteMusicJob(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const job = owned(await getStore().get<MusicJob>("music", musicIdSchema.parse(id)), ownerId, "Video with music");
  await getStore().remove("music", job.id);
  await dropMusicRender(job);
}

/** Asks the renderer where a mix stands and stores the answer. Never throws: a failed check keeps what was known. */
async function refreshMusic(job: MusicJob): Promise<MusicJob> {
  try {
    const provider = getAvatarProviderByName(job.provider);
    if (!provider.musicMixStatus) return job;
    const out = await provider.musicMixStatus(job.providerJobId);
    const now = nowIso();
    const { videoUrl: _v, durationSec: _d, error: _e, ...kept } = job;
    void _v;
    void _d;
    void _e;
    const next: MusicJob = { ...kept, ...stripUndefined(out), checkedAt: now, updatedAt: out.status !== job.status ? now : job.updatedAt };
    // Written only over the record that was read, so a delete meanwhile stays deleted.
    return (await getStore().putIf("music", next, "updatedAt", job.updatedAt)) ? next : job;
  } catch (err) {
    console.error(`music check failed for ${job.id}:`, err);
    return job;
  }
}
