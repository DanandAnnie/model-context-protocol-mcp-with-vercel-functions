// Video renders. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { getStore } from "../store";
import { EMPTY_WATCH, MAX_SCENES } from "../types";
import type { Avatar, Scene, Video, VideoRequest, Voice, WatchQuarter } from "../types";
import type { AvatarProvider, RenderCast } from "../providers/types";
import { LOCAL_OWNER } from "../owner-id";
import { renderLimitFor } from "../billing";
import { ConflictError, LimitError, NotFoundError, ValidationError } from "../errors";
import { getAvatar } from "./avatars";
import { listVoices } from "./voices";
import { PUBLIC_ACCESS, owned, scheduleNotification, stripUndefined } from "./shared";
import { SHARE_PASSWORD_MAX, SHARE_PASSWORD_MIN, clearShareLock, setShareLock, shareUnlocked } from "../share-lock";
import { clearCover, setCover } from "../cover";
import { shareOffline } from "../client";

export const backgroundSchema = z.object({ type: z.enum(["color", "image"]), value: z.string().min(1) });

export const videoRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    /** Optional when `scenes` is given; derived from them otherwise. */
    script: z.string().trim().max(5000).optional(),
    scenes: z
      .array(
        z.object({
          script: z.string().trim().min(1).max(5000),
          background: backgroundSchema,
          /** Presenter and voice for this scene; the video's when omitted. */
          avatarId: z.string().min(1).optional(),
          voiceId: z.string().min(1).optional(),
        }),
      )
      .min(1)
      .max(MAX_SCENES)
      .optional(),
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
  /** The video's avatar and voice plus every one a scene names, keyed by id. */
  cast: RenderCast;
}

export async function resolveRenderContext(req: Pick<VideoRequest, "avatarId" | "voiceId"> & { scenes?: Array<Pick<Scene, "avatarId" | "voiceId">> }, ownerId: string): Promise<RenderContext> {
  const avatarIds = Array.from(new Set([req.avatarId, ...(req.scenes ?? []).map((s) => s.avatarId).filter((id): id is string => !!id)]));
  const [avatarList, voices] = await Promise.all([Promise.all(avatarIds.map((id) => getAvatar(id, ownerId))), listVoices(ownerId)]);
  const avatars = Object.fromEntries(avatarList.map((a) => [a.id, a]));
  const voiceIds = Array.from(new Set([req.voiceId, ...(req.scenes ?? []).map((s) => s.voiceId).filter((id): id is string => !!id)]));
  const cast: RenderCast = { avatars, voices: {} };
  for (const id of voiceIds) {
    const voice = voices.find((v) => v.id === id);
    if (!voice) throw new ValidationError(`Voice ${id} is not available with the current voice provider`);
    cast.voices[id] = voice;
  }
  return { avatar: avatars[req.avatarId], voice: cast.voices[req.voiceId], cast };
}

/**
 * Start a render. The allowance check is read-then-write and therefore
 * best-effort under concurrent requests; batches reserve their rows up front.
 */
/** Library fields a caller may set on a new video alongside the render request (batch row, folder, retry link). */
export type VideoExtras = Partial<Pick<Video, "folder" | "batchId" | "rowLabel" | "retryOf">>;

export async function createVideo(req: VideoRequest, ownerId: string = LOCAL_OWNER, ctx?: RenderContext, skipLimit = false, extras: VideoExtras = {}): Promise<Video> {
  if (!skipLimit) await enforceRenderLimit(ownerId);
  const resolved = ctx ?? (await resolveRenderContext(req, ownerId));
  let avatar = resolved.avatar;
  const voice = resolved.voice;
  // Shared with the caller on purpose: a batch passes one context for every row, so a custom
  // portrait prepared (uploaded) for the first row is reused by the rest.
  const cast = resolved.cast;
  const provider = getAvatarProvider();

  // Scenes keep the names of their own presenter and voice for the library and detail page.
  const scenes = req.scenes?.map((sc) =>
    stripUndefined({
      ...sc,
      avatarName: sc.avatarId ? cast.avatars[sc.avatarId]?.name : undefined,
      voiceName: sc.voiceId ? cast.voices[sc.voiceId]?.name : undefined,
    }),
  );
  const base: Video = {
    ...req,
    ...(scenes ? { scenes } : {}),
    ...stripUndefined(extras),
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
    if (provider.prepareAvatar) {
      for (const a of Object.values(cast.avatars)) {
        if (a.source === "custom") cast.avatars[a.id] = await prepareOnce(provider, a);
      }
      avatar = cast.avatars[avatar.id] ?? avatar;
    }
    const { providerJobId } = await provider.createVideo(base, avatar, voice, cast);
    base.providerJobId = providerJobId;
    base.status = "processing";
  } catch (err) {
    base.status = "failed";
    base.error = err instanceof Error ? err.message : String(err);
  }
  return getStore().put("video", base);
}

/** How many in-flight renders one library request may check with the provider. */
export const REFRESH_PER_LIST = 10;
/** After a failed provider check, leave a render alone for this long so it cannot hog the refresh slots. */
export const REFRESH_RETRY_MS = 60_000;

function isPending(video: Video): boolean {
  return !!video.providerJobId && (video.status === "processing" || video.status === "queued");
}

/** Renders whose last provider check failed, and when they may be checked again (per instance). */
const refreshRetryAt = new Map<string, number>();

/** True while a render sits out of the list's refresh after a failed provider check. */
export function isRefreshDeferred(videoId: string, now = Date.now()): boolean {
  return (refreshRetryAt.get(videoId) ?? 0) > now;
}

/**
 * The owner's videos, newest first. In-flight renders (newest `REFRESH_PER_LIST`, skipping
 * any whose last check failed recently) are refreshed from the provider on the way out, so
 * the library's polling sees completions without a webhook or a visit to the detail page.
 */
/** Uploads in flight, so rows rendering side by side wait for one upload instead of each starting their own. */
const preparing = new Map<string, Promise<Avatar>>();

/** Makes a custom portrait usable by the provider (uploading it once) and persists the result. */
function prepareOnce(provider: AvatarProvider, avatar: Avatar): Promise<Avatar> {
  const running = preparing.get(avatar.id);
  if (running) return running;
  const run = (async () => {
    const prepared = await provider.prepareAvatar!(avatar);
    return prepared === avatar ? avatar : getStore().put("avatar", prepared);
  })().finally(() => preparing.delete(avatar.id));
  preparing.set(avatar.id, run);
  return run;
}

export async function listVideos(ownerId: string = LOCAL_OWNER, refresh = true): Promise<Video[]> {
  const videos = await getStore().list<Video>("video", ownerId);
  videos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!refresh) return videos;
  const now = Date.now();
  const pending = videos.filter((v) => isPending(v) && !isRefreshDeferred(v.id, now)).slice(0, REFRESH_PER_LIST);
  if (pending.length === 0) return videos;
  const refreshed = new Map((await Promise.all(pending.map((v) => refreshStatus(v)))).map((v) => [v.id, v]));
  return videos.map((v) => refreshed.get(v.id) ?? v);
}

/**
 * Fetch a video and, if it is still rendering, refresh its status from the provider.
 * Pass `PUBLIC_ACCESS` (null) for public access (share page); otherwise the video must belong to the owner.
 */
export async function getVideo(id: string, ownerId: string | null = LOCAL_OWNER, refresh = true): Promise<Video> {
  const video = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  // A share link the owner switched off is indistinguishable from a missing video to the public
  // (the beacons make the same distinction themselves, since they read the store directly).
  if (ownerId === PUBLIC_ACCESS && shareOffline(video)) throw new NotFoundError(`Video ${id} not found`);
  return refresh ? refreshStatus(video) : video;
}

/**
 * Asks the provider for the latest status of an in-flight render and stores any change.
 * Never throws. The write builds on the record as stored now, not on the caller's snapshot,
 * so an edit made while the provider was answering survives, and a transition that another
 * request (a webhook, a second poll) has already recorded is not stored or announced twice.
 */
export function refreshStatus(video: Video): Promise<Video> {
  if (!isPending(video)) return Promise.resolve(video);
  // One check per render at a time within this instance: a library poll and a detail visit
  // that land together share the same provider call and the same single write.
  const running = inFlight.get(video.id);
  if (running) return running;
  const run = refreshNow(video).finally(() => inFlight.delete(video.id));
  inFlight.set(video.id, run);
  return run;
}

const inFlight = new Map<string, Promise<Video>>();

async function refreshNow(video: Video): Promise<Video> {
  let update: Partial<Video>;
  try {
    update = await getAvatarProviderByName(video.provider).getStatus(video.providerJobId!);
    refreshRetryAt.delete(video.id);
  } catch (err) {
    // Transient provider errors should not flip the job to failed; surface in logs only.
    console.error(`status refresh failed for ${video.id}:`, err);
    refreshRetryAt.set(video.id, Date.now() + REFRESH_RETRY_MS);
    return video;
  }
  const current = await getStore().get<Video>("video", video.id);
  if (!current) return video; // deleted meanwhile; do not bring it back
  if (!isPending(current)) return current; // someone else already recorded the outcome
  const next: Video = { ...current, ...stripUndefined(update), updatedAt: nowIso() };
  if (next.status !== current.status || next.videoUrl !== current.videoUrl) {
    await getStore().put("video", next);
    await scheduleNotification(current, next);
  }
  return next;
}

export const MAX_FOLDER_NAME = 40;

export const videoPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    /** Folder name; an empty string moves the video back to "unfiled". */
    folder: z.string().trim().max(MAX_FOLDER_NAME).optional(),
    /** Whether the public share page offers a download link. */
    shareDownload: z.boolean().optional(),
    shareDisabled: z.boolean().optional(),
    /** When the public link stops working (ISO 8601 with a UTC offset, in the future); null keeps it open indefinitely. */
    shareExpiresAt: z.iso
      .datetime({ offset: true, message: "The expiry must be an ISO 8601 date and time with a UTC offset" })
      .refine((v) => Date.parse(v) > Date.now(), "The expiry must be in the future")
      .nullable()
      .optional(),
    /** A `data:image/...` URL (PNG, JPEG, WebP, or GIF; 2 MB decoded) or null to remove the cover. */
    cover: z
      .string()
      .max(3_000_000, "The cover image is too large (2 MB max)")
      .refine((v) => v.startsWith("data:image/"), "The cover must be an uploaded image")
      .nullable()
      .optional(),
    sharePassword: z
      .string()
      .trim()
      .min(SHARE_PASSWORD_MIN, `The share password needs at least ${SHARE_PASSWORD_MIN} characters`)
      .max(SHARE_PASSWORD_MAX, `The share password can have at most ${SHARE_PASSWORD_MAX} characters`)
      .nullable()
      .optional(),
    /** A call-to-action button on the share page; null removes it. */
    shareCta: z
      .object({
        label: z.string().trim().min(1).max(40),
        url: z
          .string()
          .trim()
          .max(2000)
          .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), "The link must start with http:// or https://"),
      })
      .nullable()
      .optional(),
  })
  .refine(
    (p) =>
      p.title !== undefined ||
      p.folder !== undefined ||
      p.shareDownload !== undefined ||
      p.shareDisabled !== undefined ||
      p.shareExpiresAt !== undefined ||
      p.sharePassword !== undefined ||
      p.shareCta !== undefined ||
      p.cover !== undefined,
    "Nothing to update",
  );

export async function updateVideo(id: string, patch: z.infer<typeof videoPatchSchema>, ownerId: string = LOCAL_OWNER): Promise<Video> {
  const existing = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  const next: Video = { ...existing, updatedAt: nowIso() };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.folder !== undefined) {
    if (patch.folder) next.folder = patch.folder;
    else delete next.folder;
  }
  if (patch.shareDownload !== undefined) {
    if (patch.shareDownload) next.shareDownload = true;
    else delete next.shareDownload;
  }
  if (patch.shareDisabled !== undefined) {
    if (patch.shareDisabled) next.shareDisabled = true;
    else delete next.shareDisabled;
  }
  if (patch.shareExpiresAt !== undefined) {
    if (patch.shareExpiresAt) next.shareExpiresAt = new Date(patch.shareExpiresAt).toISOString();
    else delete next.shareExpiresAt;
  }
  if (patch.shareCta !== undefined) {
    if (patch.shareCta) next.shareCta = patch.shareCta;
    else delete next.shareCta;
  }
  if (patch.cover !== undefined) {
    if (patch.cover) {
      const cover = await setCover(next, patch.cover);
      next.cover = { updatedAt: cover.updatedAt, mimeType: cover.mimeType, bytes: cover.bytes };
    } else {
      await clearCover(next.id);
      delete next.cover;
    }
  }
  if (patch.sharePassword !== undefined) {
    if (patch.sharePassword) {
      await setShareLock(next, patch.sharePassword);
      next.shareLocked = true;
    } else {
      await clearShareLock(next.id);
      delete next.shareLocked;
    }
  }
  return putKeepingCounters(next);
}

// ---------------------------------------------------------------------------
// Share-page counters. Each counter is a read-modify-write of the whole video record, and the
// beacons from one share page can land together (a view and a quarter, or several quarters at
// once after a seek), so writes to one video's counters run one after another within this
// instance. Other instances still race; a store-side increment would close that fully.

const counterQueue = new Map<string, Promise<unknown>>();

function withCounterLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = counterQueue.get(id) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // The stored tail never rejects, so a refused beacon (404) cannot block the ones behind it.
  // Once the tail settles with nobody chained behind it, the entry goes, so the map holds only
  // videos with a write in flight.
  const tail = run.catch(() => undefined);
  counterQueue.set(id, tail);
  void tail.then(() => {
    if (counterQueue.get(id) === tail) counterQueue.delete(id);
  });
  return run;
}

/** The counters that beacons own; an owner edit or provider update must never roll them back. */
const COUNTER_FIELDS = ["views", "lastViewedAt", "watch", "ctaClicks", "lastCtaClickAt"] as const;

/**
 * Writes a video built from `base` while keeping whatever counters the stored record holds by
 * then: an edit that read the record before a scrypt or a network round trip must not undo the
 * views, watch marks, and clicks counted meanwhile. Runs under the video's counter lock.
 */
function putKeepingCounters(base: Video): Promise<Video> {
  return withCounterLock(base.id, async () => {
    const stored = await getStore().get<Video>("video", base.id);
    const next: Video = { ...base };
    for (const field of COUNTER_FIELDS) delete next[field];
    const counters: Partial<Video> = {};
    for (const field of COUNTER_FIELDS) if (stored?.[field] !== undefined) Object.assign(counters, { [field]: stored[field] });
    return getStore().put("video", { ...next, ...counters });
  });
}

/**
 * Count a share-page view. Public: no owner check. Only completed videos accumulate views,
 * so a page opened while rendering is not a view. `gate` runs only for a countable view
 * (the route's per-viewer window), so an early visit does not use up the viewer's slot.
 */
export function recordView(id: string, gate: () => boolean = () => true, shareCookie?: string): Promise<{ views: number; counted: boolean }> {
  return withCounterLock(id, async () => {
    const video = await getStore().get<Video>("video", id);
    if (!video || shareOffline(video)) throw new NotFoundError(`Video ${id} not found`);
    if (video.status !== "completed" || !(await shareUnlocked(video, shareCookie)) || !gate()) return { views: video.views ?? 0, counted: false };
    const views = (video.views ?? 0) + 1;
    await getStore().put("video", { ...video, views, lastViewedAt: nowIso() });
    return { views, counted: true };
  });
}

export const watchSchema = z.object({ quarter: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]) });
export const WATCH_QUARTERS: readonly WatchQuarter[] = [25, 50, 75, 100];

/**
 * Count a viewer reaching a point in the share-page player. Every quarter up to `quarter` that
 * the viewer has not been counted for yet is counted in one write, so a seek past three
 * markers (or a player that reports them together) is one write, not three. `gate(q)` is the
 * route's per-viewer window for each quarter.
 */
export function recordWatch(
  id: string,
  quarter: WatchQuarter,
  gate: (q: WatchQuarter) => boolean = () => true,
  shareCookie?: string,
): Promise<{ watch: Video["watch"]; counted: boolean }> {
  return withCounterLock(id, async () => {
    const video = await getStore().get<Video>("video", id);
    if (!video || shareOffline(video)) throw new NotFoundError(`Video ${id} not found`);
    const watch = { ...EMPTY_WATCH, ...video.watch };
    if (video.status !== "completed" || !(await shareUnlocked(video, shareCookie))) return { watch, counted: false };
    let counted = false;
    for (const q of WATCH_QUARTERS) {
      if (q > quarter || !gate(q)) continue;
      watch[`q${q}`] += 1;
      counted = true;
    }
    if (counted) await getStore().put("video", { ...video, watch });
    return { watch, counted };
  });
}

/**
 * Count a click on the share-page call to action. Public, like `recordView`; only a completed
 * video that still carries a button counts, and `gate` applies the route's per-viewer window.
 */
export function recordCtaClick(id: string, gate: () => boolean = () => true, shareCookie?: string): Promise<{ clicks: number; counted: boolean }> {
  return withCounterLock(id, async () => {
    const video = await getStore().get<Video>("video", id);
    if (!video || shareOffline(video)) throw new NotFoundError(`Video ${id} not found`);
    if (video.status !== "completed" || !video.shareCta || !(await shareUnlocked(video, shareCookie)) || !gate()) {
      return { clicks: video.ctaClicks ?? 0, counted: false };
    }
    const clicks = (video.ctaClicks ?? 0) + 1;
    await getStore().put("video", { ...video, ctaClicks: clicks, lastCtaClickAt: nowIso() });
    return { clicks, counted: true };
  });
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
    if (input.action === "delete") {
      await getStore().remove("video", id);
      await clearShareLock(id);
      await clearCover(id);
    }
    else await updateVideo(id, { folder: input.folder }, ownerId);
    done += 1;
  }
  return { done, missing };
}

/**
 * Submit a failed render again with the same request (scenes, presenter, look, quality) as a new
 * video, keeping its folder and batch row. Only failed videos can be retried; the original stays.
 */
export async function retryVideo(id: string, ownerId: string = LOCAL_OWNER): Promise<Video> {
  const failed = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  if (failed.status !== "failed") throw new ConflictError("Only failed renders can be retried");
  const req: VideoRequest = {
    title: failed.title,
    script: failed.script,
    scenes: failed.scenes,
    avatarId: failed.avatarId,
    voiceId: failed.voiceId,
    aspect: failed.aspect,
    resolution: failed.resolution,
    background: failed.background,
    captions: failed.captions,
    speed: failed.speed,
  };
  // One write: the provider's webhook can land as soon as the job exists, so nothing may overwrite the stored video afterwards.
  return createVideo(req, ownerId, undefined, false, { folder: failed.folder, batchId: failed.batchId, rowLabel: failed.rowLabel, retryOf: failed.id });
}

export async function deleteVideo(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  await getStore().remove("video", id);
  await clearShareLock(id);
  await clearCover(id);
}

export async function applyAvatarWebhook(providerName: string, body: unknown): Promise<Video | null> {
  const provider = getAvatarProviderByName(providerName);
  const parsed = provider.parseWebhook?.(body);
  if (!parsed) return null;
  const video = await getStore().findBy<Video>("video", "providerJobId", parsed.providerJobId);
  if (!video) return null;
  // A late or repeated terminal webhook must not overwrite a recorded outcome (and the counts
  // that landed on it since), nor announce the completion twice.
  if (!isPending(video)) return video;
  const next: Video = { ...video, ...stripUndefined(parsed.update), updatedAt: nowIso() };
  await getStore().put("video", next);
  await scheduleNotification(video, next);
  return next;
}

// ---------------------------------------------------------------------------
// Library queries: filtering, sorting, and paging for GET /api/videos.

export const videoQuerySchema = z.object({
  /** Case-insensitive match on title, script, avatar, and voice names. */
  q: z.string().trim().max(200).default(""),
  /** "processing" also covers queued renders. */
  status: z.enum(["all", "processing", "completed", "failed"]).default("all"),
  /** A folder name; an empty string means unfiled; absent means every folder. */
  folder: z.string().trim().max(MAX_FOLDER_NAME).optional(),
  batch: z.string().max(80).optional(),
  sort: z.enum(["newest", "oldest", "title", "views"]).default("newest"),
  /** Omit for every match (scripts); the library pages with it. */
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type VideoQuery = z.infer<typeof videoQuerySchema>;

export interface VideoPage {
  videos: Video[];
  /** Matches for the query, before `limit`. */
  matched: number;
  /** Every video the owner has, before filtering. */
  total: number;
  hasMore: boolean;
  /** Folder names in use, for the filter control. */
  folders: string[];
  /** Renders still in flight, across the whole library. */
  rendering: number;
}

const SORTERS: Record<VideoQuery["sort"], (a: Video, b: Video) => number> = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || b.createdAt.localeCompare(a.createdAt),
  views: (a, b) => (b.views ?? 0) - (a.views ?? 0) || b.createdAt.localeCompare(a.createdAt),
};

/** The videos matching `query`, sorted; `limit` is not applied here. */
export function filterVideos(videos: Video[], query: VideoQuery): Video[] {
  const needle = query.q.toLowerCase();
  return videos
    .filter((v) => {
      if (query.batch && v.batchId !== query.batch) return false;
      if (query.folder !== undefined && (v.folder ?? "") !== query.folder) return false;
      if (query.status === "processing" ? v.status !== "processing" && v.status !== "queued" : query.status !== "all" && v.status !== query.status) return false;
      return !needle || `${v.title} ${v.script} ${v.avatarName ?? ""} ${v.voiceName ?? ""}`.toLowerCase().includes(needle);
    })
    .sort(SORTERS[query.sort]);
}

/** One page of the owner's library (in-flight renders refreshed first; see listVideos). */
export async function queryVideos(ownerId: string = LOCAL_OWNER, query: VideoQuery): Promise<VideoPage> {
  const all = await listVideos(ownerId);
  const matched = filterVideos(all, query);
  const videos = query.limit ? matched.slice(0, query.limit) : matched;
  return {
    videos,
    matched: matched.length,
    total: all.length,
    hasMore: videos.length < matched.length,
    folders: Array.from(new Set(all.map((v) => v.folder).filter((f): f is string => !!f))).sort(),
    rendering: all.filter((v) => v.status === "processing" || v.status === "queued").length,
  };
}
