// Video renders. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { getStore } from "../store";
import { EMPTY_WATCH, MAX_SCENES, TRASH_RETENTION_DAYS, backdropIdOf, isDefaultCaptionStyle, framingFor, isDefaultLayout } from "../types";
import type { AudioClip, Avatar, Backdrop, Background, CaptionCue, Scene, Video, VideoRequest, Voice, WatchQuarter } from "../types";
import { buildCues } from "../captions";
import { captionDurationSec, sceneBoundsMs, type Timed } from "../chapters";
import { graphemes, wellFormed } from "../text";
import { pauseSeconds, silentProblem, silentSeconds, stripPauses } from "../pauses";
import type { AvatarProvider, RenderCast } from "../providers/types";
import { LOCAL_OWNER } from "../owner-id";
import { renderLimitFor } from "../billing";
import { ConflictError, ForbiddenError, LimitError, NotFoundError, ValidationError } from "../errors";
import { isWorkspaceId, type User } from "../workspaces";
import { getAvatar, madeLooksOf, rememberMadeLooks } from "./avatars";
import { getClip, getClipAudio, saveClipAssetIds } from "./clips";
import { getBackdrop, getBackdropImage, saveBackdropAssetIds } from "./backdrops";
import { listVoices } from "./voices";
import { PUBLIC_ACCESS, owned, scheduleNotification, stripUndefined } from "./shared";
import { SHARE_PASSWORD_MAX, SHARE_PASSWORD_MIN, clearShareLock, setShareLock, shareUnlocked } from "../share-lock";
import { clearCover, setCover } from "../cover";
import { posterUrl, shareOffline } from "../client";
import { bumpViewsByDay } from "../insights";

import { accentSchema, avatarEngineSchema, transparentSchema, backgroundSchema, captionStyleSchema, emotionSchema, expressivenessSchema, motionPromptSchema, pitchSchema, sceneLayoutSchema, sceneTextSchema } from "./schemas";
import { getBrandKit } from "./brand";
import { spokenCopy } from "../pronounce";
import { clearComments } from "./comments";
import { clearVideoLeads } from "./leads";
import { clearHighlights } from "./highlights";
import { clearCleanups } from "./cleanups";
import { clearLipsyncs } from "./lipsyncs";
import { clearMusicJobs } from "./music";
import { reviseScript } from "./scripts";
import { RELINK_MS, RETRY_FINISHED_MS } from "./job-checks";
import { config } from "../config";
export { accentSchema, avatarEngineSchema, transparentSchema, backgroundSchema, captionStyleSchema, emotionSchema, expressivenessSchema, motionPromptSchema, pitchSchema, sceneLayoutSchema, sceneTextSchema };

export const videoRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    /** Optional when `scenes` is given; derived from them otherwise. */
    script: z.string().trim().max(5000).optional(),
    scenes: z
      .array(
        z.object({
          // A scene of only pauses is a silent one, the presenter holding without a word (HeyGen's silent voice).
          // (Its length is checked below, where an audio scene, whose script is only what the clip says, is known.)
          script: z.string().trim().min(1).max(5000),
          background: backgroundSchema,
          /** No presenter: the scene's picture or video fills the frame, narrated or silent. */
          hidePresenter: z.literal(true).optional(),
          /** Presenter and voice for this scene; the video's when omitted. */
          avatarId: z.string().min(1).optional(),
          voiceId: z.string().min(1).optional(),
          /** Speaking speed for this scene; the video's when omitted. */
          speed: z.number().min(0.5).max(1.5).optional(),
          /** An audio clip the presenter lip-syncs to; the script is then what the clip says, for captions and search. */
          audioId: z.string().min(1).max(64).optional(),
          layout: sceneLayoutSchema.optional(),
          /** Text shown on screen for the scene (a title, a lower third). */
          overlay: sceneTextSchema.optional(),
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
    captionStyle: captionStyleSchema.optional(),
    speed: z.number().min(0.5).max(1.5).default(1),
    pitch: pitchSchema.optional(),
    emotion: emotionSchema.optional(),
    expressiveness: expressivenessSchema,
    motionPrompt: motionPromptSchema,
    accent: accentSchema,
    avatarEngine: avatarEngineSchema,
    transparent: transparentSchema,
  })
  .transform((v, ctx) => {
    if (v.transparent && v.scenes && (v.scenes.length > 1 || v.scenes[0]?.hidePresenter)) {
      ctx.addIssue({ code: "custom", path: ["transparent"], message: "A transparent background is for a one-scene video that shows the presenter" });
      return z.NEVER;
    }
    if (v.scenes) {
      const script = v.scenes.map((s) => s.script).join("\n\n");
      if (script.length > 5000) {
        ctx.addIssue({ code: "custom", path: ["scenes"], message: "Combined scene scripts must be 5000 characters or fewer" });
        return z.NEVER;
      }
      const silence = v.scenes.findIndex((s) => !s.audioId && silentProblem(s.script));
      if (silence >= 0) {
        ctx.addIssue({ code: "custom", path: ["scenes", silence, "script"], message: silentProblem(v.scenes[silence].script)! });
        return z.NEVER;
      }
      const bare = v.scenes.findIndex((s) => s.hidePresenter && s.background.type === "color");
      if (bare >= 0) {
        ctx.addIssue({ code: "custom", path: ["scenes", bare, "hidePresenter"], message: "A scene without the presenter shows its picture or video: give it an image or video background" });
        return z.NEVER;
      }
      if (!v.scenes.some((s) => s.audioId || !silentSeconds(s.script))) {
        ctx.addIssue({ code: "custom", path: ["scenes"], message: "The video needs some words, not only pauses: every scene is silent" });
        return z.NEVER;
      }
      // A scene without the presenter names none: its presenter would otherwise be looked up and prepared for nothing.
      const scenes = v.scenes.map((sc) => {
        if (!sc.hidePresenter) return sc;
        const { avatarId: _avatar, layout: _layout, ...rest } = sc;
        return rest as typeof sc;
      });
      // A lone scene's pace is the video's (the page and the editor show one speed).
      if (scenes.length === 1 && scenes[0].speed !== undefined) {
        return { ...v, speed: scenes[0].speed, scenes: [{ ...scenes[0], speed: undefined }], script, background: scenes[0].background };
      }
      return { ...v, scenes, script, background: scenes[0].background };
    }
    if (!v.script || !stripPauses(v.script).trim()) {
      ctx.addIssue({ code: "custom", path: ["script"], message: v.script ? "The script needs some words, not only pauses" : "Script is required" });
      return z.NEVER;
    }
    return { ...v, script: v.script };
  });

/** Renders an owner started in a calendar month (UTC), kept apart from the videos so deleting them gives nothing back. */
interface RenderUsage {
  id: string;
  ownerId: string;
  month: string;
  count: number;
  updatedAt: string;
}
const usageMonth = (at = new Date()) => at.toISOString().slice(0, 7);
const usageId = (ownerId: string, month: string) => `usage_${ownerId}_${month}`;

/**
 * Moves the owner's count for a month by `delta` (never below zero). Conditional writes, so concurrent
 * renders each count. A refund for a month with no record (a render from before the record existed) does nothing.
 */
async function adjustRenderUsage(ownerId: string, month: string, delta: 1 | -1): Promise<boolean> {
  const id = usageId(ownerId, month);
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await getStore().get<RenderUsage>("usage", id);
    const updatedAt = new Date(Math.max(Date.now(), current ? Date.parse(current.updatedAt) + 1 : 0)).toISOString();
    if (!current) {
      if (delta < 0) return true;
      // The month's first render; when a concurrent first render inserted already, go round again and add to it.
      if (await getStore().insert<RenderUsage>("usage", { id, ownerId, month, count: 1, updatedAt })) return true;
      continue;
    }
    const count = Math.max(0, current.count + delta);
    if (await getStore().putIf("usage", { ...current, count, updatedAt }, "updatedAt", current.updatedAt)) return true;
  }
  console.error(`render usage for ${ownerId} could not be updated after repeated conflicts`);
  return false;
}

/**
 * Counts a render the provider accepted against the month it was created in and stamps that month on it
 * (`countedIn`). Never throws: the render is already running, so a usage write that fails is logged and the
 * render goes uncounted rather than answering an error that would invite a second render.
 */
async function countRender(video: Video, ownerId: string): Promise<void> {
  const month = usageMonth(new Date(video.createdAt));
  try {
    if (await adjustRenderUsage(ownerId, month, 1)) video.countedIn = month;
  } catch (err) {
    console.error(`render usage for ${ownerId} could not be recorded:`, err);
  }
}

/**
 * Announces a render's transition and, when the provider reports a counted render failed, gives it back to the
 * month that counted it. The lock around a transition is per instance, so two instances can both record the same
 * failure; a marker record that only one of them can insert makes the refund happen once.
 */
async function afterTransition(before: Video, next: Video): Promise<void> {
  if (next.status === "failed" && before.status !== "failed" && next.countedIn) {
    const ownerId = next.ownerId ?? LOCAL_OWNER;
    try {
      const marker = { id: `refund_${next.id}`, ownerId, month: next.countedIn, refundedAt: nowIso() };
      if (await getStore().insert("usage", marker)) await adjustRenderUsage(ownerId, next.countedIn, -1);
    } catch (err) {
      console.error(`render usage refund for ${next.id} failed:`, err);
    }
  }
  await scheduleNotification(before, next);
}

/**
 * Renders started by this owner since the start of the current UTC month, excluding ones that failed: the month's
 * usage record, which deleting videos (or the trash, or all data) does not lower; while a month began before the
 * record existed, the videos still stored count instead when they are more.
 */
export async function rendersThisMonth(ownerId: string): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const since = monthStart.toISOString();
  const [videos, usage] = await Promise.all([getStore().list<Video>("video", ownerId), getStore().get<RenderUsage>("usage", usageId(ownerId, usageMonth()))]);
  const stored = videos.filter((v) => v.createdAt >= since && v.status !== "failed").length;
  return Math.max(stored, usage?.count ?? 0);
}

export async function enforceRenderLimit(ownerId: string): Promise<void> {
  const limit = await renderLimitFor(ownerId);
  if (!limit) return;
  const used = await rendersThisMonth(ownerId);
  if (used >= limit) {
    throw new LimitError(`Monthly render limit reached (${used} of ${limit}). The allowance resets on the 1st.`);
  }
}

/** The uploaded background images a request names, on the video or on any scene. */
function backdropIdsOf(req: { background?: Background; scenes?: Array<{ background?: Background }>; transparent?: true }): string[] {
  // A transparent video has no background, so its image is neither looked up nor uploaded.
  if (req.transparent) return [];
  const ids = [req.background, ...(req.scenes ?? []).map((s) => s.background)].map(backdropIdOf).filter((id): id is string => !!id);
  return Array.from(new Set(ids));
}

export interface RenderContext {
  avatar: Avatar;
  voice: Voice;
  /** The video's avatar and voice plus every one a scene names, keyed by id. */
  cast: RenderCast;
}

export async function resolveRenderContext(
  req: Pick<VideoRequest, "avatarId" | "voiceId" | "transparent"> & { background?: Background; scenes?: Array<Pick<Scene, "avatarId" | "voiceId" | "audioId"> & { background?: Background }> },
  ownerId: string,
): Promise<RenderContext> {
  const avatarIds = Array.from(new Set([req.avatarId, ...(req.scenes ?? []).map((s) => s.avatarId).filter((id): id is string => !!id)]));
  const clipIds = Array.from(new Set((req.scenes ?? []).map((s) => s.audioId).filter((id): id is string => !!id)));
  const backdropIds = backdropIdsOf(req);
  const [avatarList, voices, clipList, backdropList] = await Promise.all([
    Promise.all(avatarIds.map((id) => getAvatar(id, ownerId))),
    listVoices(ownerId),
    // A clip or background image from another account reads as not found, like any record the caller does not own.
    Promise.all(clipIds.map((id) => getClip(id, ownerId))),
    Promise.all(backdropIds.map((id) => getBackdrop(id, ownerId))),
  ]);
  const avatars = Object.fromEntries(avatarList.map((a) => [a.id, a]));
  // An audio scene speaks its clip, so its voice is neither needed nor checked.
  const voiceIds = Array.from(new Set([req.voiceId, ...(req.scenes ?? []).filter((s) => !s.audioId).map((s) => s.voiceId).filter((id): id is string => !!id)]));
  const cast: RenderCast = {
    avatars,
    voices: {},
    ...(clipList.length ? { clips: Object.fromEntries(clipList.map((c) => [c.id, c])) } : {}),
    ...(backdropList.length ? { backdrops: Object.fromEntries(backdropList.map((b) => [b.id, b])) } : {}),
  };
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
export type VideoExtras = Partial<Pick<Video, "folder" | "description" | "batchId" | "rowLabel" | "retryOf" | "resizedFrom" | "captionCues" | "subtitles">> & {
  /** The video's id, when a client key decides it (a template render retried after a lost answer). */
  id?: string;
  /** Called once the renderer has started this render here, never for a replay of one started before (never stored). */
  onStarted?: () => void;
};

export async function createVideo(req: VideoRequest, ownerId: string = LOCAL_OWNER, ctx?: RenderContext, skipLimit = false, allExtras: VideoExtras = {}): Promise<Video> {
  if (req.studioTemplate) return createStudioTemplateVideo({ ...req, studioTemplate: req.studioTemplate }, ownerId, skipLimit, allExtras);
  if (req.cinematic) return createCinematicVideo({ ...req, cinematic: req.cinematic }, ownerId, skipLimit, allExtras);
  // A callback is never part of the stored video; the studio's own renders do not report starting.
  const { onStarted: _started, ...extras } = allExtras;
  void _started;
  if (!skipLimit) await enforceRenderLimit(ownerId);
  const resolved = ctx ?? (await resolveRenderContext(req, ownerId));
  let avatar = resolved.avatar;
  const voice = resolved.voice;
  // Shared with the caller on purpose: a batch passes one context for every row, so a custom
  // portrait prepared (uploaded) for the first row is reused by the rest.
  const cast = resolved.cast;
  const provider = getAvatarProvider();

  // Scenes keep the names of their own presenter and voice for the library and detail page.
  const scenes = req.scenes?.map((sc) => {
    const clip = sc.audioId ? cast.clips?.[sc.audioId] : undefined;
    // A framing is stored as the presenter gets it (a photo avatar's close-up is its full frame), so the page lists what renders.
    const framing = sc.layout ? framingFor(sc.layout.framing, (sc.avatarId && cast.avatars[sc.avatarId]) || avatar) : undefined;
    const layout = sc.layout ? { scale: sc.layout.scale, x: sc.layout.x, y: sc.layout.y, ...(framing && framing !== "full" ? { framing } : {}) } : undefined;
    return stripUndefined({
      ...sc,
      // The renderer's default layout is stored as absent whichever client sent it, so the page and the provider see no customisation.
      // A scene without the presenter has neither a presenter of its own nor a layout for one.
      layout: layout && !isDefaultLayout(layout) && !sc.hidePresenter ? layout : undefined,
      avatarId: sc.hidePresenter ? undefined : sc.avatarId,
      avatarName: sc.avatarId && !sc.hidePresenter ? cast.avatars[sc.avatarId]?.name : undefined,
      // An audio scene has no voice of its own: the clip speaks.
      voiceId: clip ? undefined : sc.voiceId,
      // A clip has its own pace and a silent scene none; a scene's chosen speed is kept, even one equal to the video's,
      // so it still holds when the video's speed changes in a copy.
      speed: clip || silentSeconds(sc.script) ? undefined : sc.speed,
      voiceName: !clip && sc.voiceId ? cast.voices[sc.voiceId]?.name : undefined,
      audioName: clip?.name,
      audioSeconds: clip?.durationSec,
    });
  });
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
  // Like a scene's layout: the default look is stored as absent whichever client spelled it out, so every
  // renderer sees one shape (and burns captions in when it can).
  if (base.captionStyle && isDefaultCaptionStyle(base.captionStyle)) delete base.captionStyle;
  if (!base.pitch) delete base.pitch; // no shift is stored as absent
  if (!base.expressiveness) delete base.expressiveness;
  if (!base.motionPrompt) delete base.motionPrompt;
  if (!base.accent) delete base.accent;
  if (!base.avatarEngine) delete base.avatarEngine;
  if (!base.transparent) delete base.transparent;

  try {
    if (provider.prepareAvatar) {
      // Side by side, so several presenters waiting on the renderer wait once, not one after another. Only the
      // presenters some scene shows: one every scene leaves out, or replaces with its own, is never rendered.
      const shown = new Set(req.scenes?.length ? req.scenes.filter((sc) => !sc.hidePresenter).map((sc) => sc.avatarId ?? req.avatarId) : [req.avatarId]);
      await Promise.all(
        Object.values(cast.avatars)
          .filter((a) => a.source === "custom" && shown.has(a.id))
          .map(async (a) => {
            cast.avatars[a.id] = await prepareOnce(provider, a);
          }),
      );
      avatar = cast.avatars[avatar.id] ?? avatar;
    }
    if (cast.clips) {
      if (!provider.prepareAudio) throw new Error(`The ${provider.name} renderer cannot lip-sync to recorded audio`);
      for (const clip of Object.values(cast.clips)) cast.clips[clip.id] = await prepareClipOnce(provider, clip, ownerId);
    }
    // A context made for other backgrounds (a batch's, say) may lack an image this request names.
    for (const id of backdropIdsOf(req)) {
      if (!cast.backdrops?.[id]) cast.backdrops = { ...cast.backdrops, [id]: await getBackdrop(id, ownerId) };
    }
    if (cast.backdrops && provider.prepareBackdrop) {
      for (const b of Object.values(cast.backdrops)) cast.backdrops[b.id] = await prepareBackdropOnce(provider, b, ownerId);
    }
    // The renderer speaks the brand kit's pronunciations; the stored script and its captions keep the spelling.
    const rules = (await getBrandKit(ownerId))?.pronunciations ?? [];
    const { providerJobId } = await provider.createVideo(spokenCopy(base, rules), avatar, voice, cast);
    base.providerJobId = providerJobId;
    base.status = "processing";
  } catch (err) {
    base.status = "failed";
    base.error = err instanceof Error ? err.message : String(err);
  }
  // A render the provider started counts against its month, even once deleted; a failed start does not. Counted
  // before the video is stored, so a failure webhook that finds the video finds it already counted.
  if (base.status !== "failed") await countRender(base, ownerId);
  return getStore().put("video", base);
}

export const reviewActionSchema = z
  .object({
    action: z.enum(["request", "approve", "changes", "withdraw"]),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.action !== "changes" || !!v.note, { message: "Say what should change", path: ["note"] });

/**
 * Review and approval for a workspace video. Anyone who can edit asks for a review (again after
 * changes, which resets the decision); a workspace owner approves or asks for changes, with a note
 * for the latter; the person who asked, or an owner, withdraws a pending request. Videos in a
 * personal space have nobody to review them, so they are refused.
 */
export function reviewVideo(id: string, ownerId: string, actor: User, canDecide: boolean, input: z.infer<typeof reviewActionSchema>): Promise<Video> {
  if (!isWorkspaceId(ownerId)) return Promise.reject(new ValidationError("Reviews are for workspace videos; switch to a workspace to ask for one"));
  // A script with an API key acts as the workspace itself, so every key would share one requester; keys only ask.
  const viaKey = actor.id === ownerId;
  if (viaKey && input.action === "withdraw") return Promise.reject(new ForbiddenError("A review asked for with an API key is withdrawn by a person signed in"));
  return updateKeepingCounters(id, ownerId, (video) => {
    if (video.deletedAt) throw new ConflictError("Restore the video from the trash first");
    const now = nowIso();
    const by = { id: actor.id, ...(actor.email ? { email: actor.email } : {}) };
    switch (input.action) {
      case "request":
        if (video.status !== "completed") throw new ConflictError("Only a finished render can go for review");
        if (video.review?.status === "pending") throw new ConflictError("A review is already pending");
        return {
          ...video,
          review: stripUndefined({ status: "pending" as const, requestedById: by.id, requestedByEmail: by.email, requestedAt: now, note: input.note || undefined }),
          updatedAt: now,
        };
      case "approve":
      case "changes": {
        if (!canDecide) throw new ForbiddenError("Only workspace owners can approve videos or ask for changes");
        if (video.review?.status !== "pending") throw new ConflictError("Ask for a review first");
        return {
          ...video,
          review: stripUndefined({
            ...video.review,
            status: input.action === "approve" ? ("approved" as const) : ("changes" as const),
            // An approval may carry a note of its own; without one the request's note is kept.
            note: input.note || (input.action === "approve" ? video.review.note : undefined),
            decidedById: by.id,
            decidedByEmail: by.email,
            decidedAt: now,
          }),
          updatedAt: now,
        };
      }
      case "withdraw": {
        if (video.review?.status !== "pending") throw new ConflictError("There is no pending review to withdraw");
        if (!canDecide && video.review.requestedById !== actor.id) throw new ForbiddenError("Only the person who asked, or a workspace owner, can withdraw the review");
        const next: Video = { ...video, updatedAt: now };
        delete next.review;
        return next;
      }
    }
  });
}

/** Translated subtitle tracks a video may carry. */
export const MAX_SUBTITLE_LANGUAGES = 5;
/** A language name: letters (any script), with spaces, brackets, apostrophes, and hyphens; never a bare symbol or an object key like `__proto__`. */
export const subtitleSchema = z.object({
  language: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^\p{L}[\p{L}\p{M}\s().'-]*$/u, "Name the language in letters, like Spanish or Portuguese (Brazil)"),
});
/** The remove route takes whatever key a track is stored under, so a track kept under an older naming rule can still go. */
export const removeSubtitleSchema = z.object({ language: z.string().trim().min(1).max(80) });
/** Translates a script into a language; the default asks the script provider. Injectable for tests. */
export type Translator = (script: string, language: string) => Promise<string>;
/** The default translator: the script provider, keeping the owner's brand glossary as written. */
const translateFor = (ownerId: string): Translator => (script, language) => reviseScript({ script, action: "translate", language }, ownerId);

/** The stored key for a language, matched without regard to case so "spanish" and "Spanish" are one track. */
function subtitleKey(video: Video, language: string): string | undefined {
  return findLanguage(Object.keys(video.subtitles ?? {}), language);
}

/** The stored key for a language: the exact name when the video carries it, else the first that names the same track. */
function findLanguage(keys: string[], language: string): string | undefined {
  return keys.find((k) => k === language) ?? keys.find((k) => sameLanguage(k, language));
}

/**
 * Whether two language names name the same track: case aside, and with any lone surrogate read as U+FFFD,
 * so a name stored with half an emoji (before names were checked) is still reached by the URL-safe form
 * the pages send for it.
 */
function sameLanguage(a: string, b: string): boolean {
  return wellFormed(a).toLowerCase() === wellFormed(b).toLowerCase();
}

/**
 * Translates the script into a language with the script provider and keeps it as a subtitle track
 * (the share page offers it, `GET /api/videos/:id/captions?lang=` serves it). Asking again for a
 * language the video already has translates it afresh. An approval is cleared, since the new track
 * has not been reviewed.
 */
export async function addSubtitles(id: string, language: string, ownerId: string = LOCAL_OWNER, translate: Translator = translateFor(ownerId)): Promise<Video> {
  // Refuse early, before a provider call, what the write below would refuse anyway.
  const video = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  if (purgeDue(video, Date.now())) throw new NotFoundError(`Video ${id} not found`);
  if (video.deletedAt) throw new ConflictError("Restore the video from the trash before adding subtitles");
  if (video.cinematic) throw new ValidationError("A cinematic shot has no script to subtitle");
  if (!subtitleKey(video, language) && Object.keys(video.subtitles ?? {}).length >= MAX_SUBTITLE_LANGUAGES) {
    throw new ValidationError(`At most ${MAX_SUBTITLE_LANGUAGES} subtitle languages per video`);
  }
  // The pause markers go along (the default translator keeps them as tokens), so the translated
  // captions leave the same gaps; a translator that loses one only loses that gap.
  const text = await translate(video.script, language);
  // The translation took a while: build on the record as stored under the lock, so edits made
  // meanwhile are kept and a track added or removed by a concurrent request is seen. The language
  // and the cap are decided again there, so two overlapping adds cannot store one language twice
  // or pass the cap together.
  return updateKeepingCounters(id, ownerId, (current) => {
    if (current.deletedAt) throw new ConflictError("Restore the video from the trash before adding subtitles");
    const subtitles = { ...current.subtitles };
    const existing = subtitleKey(current, language);
    if (existing) delete subtitles[existing];
    else if (Object.keys(subtitles).length >= MAX_SUBTITLE_LANGUAGES) throw new ValidationError(`At most ${MAX_SUBTITLE_LANGUAGES} subtitle languages per video`);
    subtitles[language] = text;
    // A new track is text viewers of the share page see that nobody approved, as with edited captions.
    const next: Video = { ...current, subtitles, updatedAt: nowIso() };
    if (next.review?.status === "approved") delete next.review;
    return next;
  });
}

export function removeSubtitles(id: string, language: string, ownerId: string = LOCAL_OWNER): Promise<Video> {
  return updateKeepingCounters(id, ownerId, (video) => {
    const key = subtitleKey(video, language);
    if (!key) throw new NotFoundError(`No ${language} subtitles on this video`);
    const subtitles = { ...video.subtitles };
    delete subtitles[key];
    const next: Video = { ...video, updatedAt: nowIso() };
    if (Object.keys(subtitles).length) next.subtitles = subtitles;
    else delete next.subtitles;
    return next;
  });
}

/** The subtitle text for a language the video carries, matched without regard to case; undefined when it has none. */
export function subtitlesFor(video: Pick<Video, "subtitles">, language: string): { language: string; text: string } | undefined {
  const key = findLanguage(Object.keys(video.subtitles ?? {}), language);
  return key ? { language: key, text: video.subtitles![key] } : undefined;
}

/** The most caption lines one video may carry, the longest a line may be, and the latest it may end (four hours). */
export const MAX_CAPTION_CUES = 500;
export const MAX_CAPTION_CUE_CHARS = 300;
const MAX_CAPTION_MS = 4 * 60 * 60 * 1000;

/** Captions an editor corrected: lines in order, each showing for a while, none overlapping the next. */
export const captionCuesSchema = z
  .object({
    cues: z
      .array(
        z.object({
          startMs: z.number().int().min(0).max(MAX_CAPTION_MS),
          endMs: z.number().int().min(1).max(MAX_CAPTION_MS),
          text: z.string().trim().max(MAX_CAPTION_CUE_CHARS),
        }),
      )
      .min(1, "Keep at least one caption line, or reset the captions to follow the script")
      .max(MAX_CAPTION_CUES),
  })
  .superRefine(({ cues }, ctx) => {
    cues.forEach((c, i) => {
      if (!c.text) ctx.addIssue({ code: "custom", path: ["cues", i, "text"], message: `Line ${i + 1} needs some text` });
      if (c.endMs <= c.startMs) ctx.addIssue({ code: "custom", path: ["cues", i, "endMs"], message: `Line ${i + 1} must end after it starts` });
      else if (i > 0 && c.startMs < cues[i - 1].endMs) ctx.addIssue({ code: "custom", path: ["cues", i, "startMs"], message: `Line ${i + 1} starts before line ${i} ends` });
    });
  });

export { captionDurationSec };
/**
 * Cues for `texts`, one per scene, each scene's lines within its share of the running time (shares follow each
 * scene's estimated length, so a slower scene or a long clip keeps its lines on screen longer). Without one text per
 * scene, the lines share the whole running time.
 */
function timedCues(video: Timed, texts: string[]): CaptionCue[] {
  const totalSec = captionDurationSec(video);
  const plain = (cues: CaptionCue[]) => cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
  const bounds = sceneBoundsMs(video);
  if (!bounds || texts.length !== bounds.length) return plain(buildCues(texts.join("\n\n"), totalSec));
  const cues: CaptionCue[] = [];
  texts.forEach((text, i) => {
    const { startMs, endMs } = bounds[i];
    // A scene's share already counts its pauses, so they may take most of it (a short line before a long pause).
    for (const c of buildCues(text, (endMs - startMs) / 1000, 0.9)) cues.push({ startMs: startMs + c.startMs, endMs: startMs + c.endMs, text: c.text });
  });
  return cues;
}

const paragraphsOf = (text: string) => text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);

/** The paragraphs that have words; one of only pauses (a silent scene) is left to the scene's own share. */
const spokenParagraphs = (text: string) => paragraphsOf(text).filter((p) => stripPauses(p).trim());

/**
 * A translated subtitle track's cues. A translation keeps the script's paragraphs, so with as many spoken paragraphs
 * as the scenes hold in all, each scene's are timed within its share (a silent scene's share left without a line,
 * whether or not the translation kept its pause); any other shape is timed evenly over the running time.
 */
export function subtitleCues(video: Timed, text: string): CaptionCue[] {
  const paragraphs = spokenParagraphs(text);
  const counts = (video.scenes ?? []).map((sc) => spokenParagraphs(sc.script).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (counts.length < 2 || !total || paragraphs.length !== total) return timedCues(video, [text]);
  let at = 0;
  return timedCues(video, counts.map((n) => paragraphs.slice(at, (at += n)).join("\n\n")));
}

/**
 * What the share page's transcript can show: the script's captions first (no language), then one set per
 * translated subtitle track, timed like that track is in the player.
 */
export function transcriptsFor(video: Timed & Pick<Video, "captionCues" | "subtitles">): Array<{ language?: string; cues: CaptionCue[] }> {
  return [
    { cues: captionCuesFor(video).cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })) },
    ...Object.entries(video.subtitles ?? {}).map(([language, text]) => ({ language, cues: subtitleCues(video, text) })),
  ];
}

/** The captions in the script's language: the editor's corrections when there are some, else lines timed from the script. */
export function captionCuesFor(video: Timed & Pick<Video, "captionCues">): { cues: CaptionCue[]; edited: boolean } {
  if (video.captionCues?.length) return { cues: video.captionCues, edited: true };
  return { cues: timedCues(video, video.scenes && video.scenes.length > 1 ? video.scenes.map((sc) => sc.script) : [video.script]), edited: false };
}

/**
 * Keeps an editor's corrected captions, which then serve the share page and the caption downloads.
 * Captions are part of what viewers see, so an approval is cleared; a trashed video is refused.
 */
export function saveCaptionCues(id: string, input: z.infer<typeof captionCuesSchema>, ownerId: string = LOCAL_OWNER): Promise<Video> {
  return updateKeepingCounters(id, ownerId, (video) => {
    if (video.deletedAt) throw new ConflictError("Restore the video from the trash before editing its captions");
    if (video.cinematic) throw new ValidationError("A cinematic shot has no script, so no captions to edit");
    const next: Video = { ...video, captionCues: input.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), updatedAt: nowIso() };
    if (next.review?.status === "approved") delete next.review;
    return next;
  });
}

/** Drops the corrections so captions follow the script again. */
export function resetCaptionCues(id: string, ownerId: string = LOCAL_OWNER): Promise<Video> {
  return updateKeepingCounters(id, ownerId, (video) => {
    if (!video.captionCues) return video;
    const next: Video = { ...video, updatedAt: nowIso() };
    delete next.captionCues;
    if (next.review?.status === "approved") delete next.review;
    return next;
  });
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
export function prepareOnce(provider: AvatarProvider, avatar: Avatar): Promise<Avatar> {
  const running = preparing.get(avatar.id);
  if (running) return running;
  const run = (async () => {
    const prepared = await provider.prepareAvatar!(avatar);
    if (prepared === avatar) return avatar;
    // The look is the studio's from now on, even if the avatar is deleted while it was being made.
    await rememberMadeLooks(madeLooksOf("avatar", prepared));
    // The upload takes seconds; a rename that landed meanwhile must survive, so only the asset ids are written,
    // and an avatar deleted meanwhile is not brought back (this render still uses the upload).
    const current = await getStore().get<Avatar>("avatar", avatar.id);
    return current ? getStore().put("avatar", { ...current, providerAssetIds: { ...current.providerAssetIds, ...prepared.providerAssetIds } }) : prepared;
  })().finally(() => preparing.delete(avatar.id));
  preparing.set(avatar.id, run);
  return run;
}

/** Clip uploads in flight, so two renders naming one clip share one upload. */
const preparingClips = new Map<string, Promise<AudioClip>>();

/** Uploads a clip to the renderer once and remembers its asset id, so retries and copies reuse it. */
export function prepareClipOnce(provider: AvatarProvider, clip: AudioClip, ownerId: string): Promise<AudioClip> {
  if (clip.providerAssetIds?.[provider.assetKey ?? provider.name]) return Promise.resolve(clip);
  const key = `${provider.name}:${clip.id}`;
  const running = preparingClips.get(key);
  if (running) return running;
  const run = (async () => {
    const prepared = await provider.prepareAudio!(clip, await getClipAudio(clip.id, ownerId));
    return prepared.providerAssetIds ? saveClipAssetIds(clip, prepared.providerAssetIds) : prepared;
  })().finally(() => preparingClips.delete(key));
  preparingClips.set(key, run);
  return run;
}

/** Background image uploads in flight, so two renders naming one image share one upload. */
const preparingBackdrops = new Map<string, Promise<Backdrop>>();

/** Uploads a background image to the renderer once and remembers its asset id, so later renders reuse it. */
function prepareBackdropOnce(provider: AvatarProvider, backdrop: Backdrop, ownerId: string): Promise<Backdrop> {
  if (backdrop.providerAssetIds?.[provider.assetKey ?? provider.name]) return Promise.resolve(backdrop);
  const key = `${provider.name}:${backdrop.id}`;
  const running = preparingBackdrops.get(key);
  if (running) return running;
  const run = (async () => {
    const prepared = await provider.prepareBackdrop!(backdrop, await getBackdropImage(backdrop.id, ownerId));
    return prepared.providerAssetIds ? saveBackdropAssetIds(backdrop, prepared.providerAssetIds) : prepared;
  })().finally(() => preparingBackdrops.delete(key));
  preparingBackdrops.set(key, run);
  return run;
}

/** True once a trashed video has sat in the trash for the whole retention period. */
function purgeDue(video: Video, now: number): boolean {
  return !!video.deletedAt && Date.parse(video.deletedAt) + TRASH_RETENTION_DAYS * 86_400_000 <= now;
}

/** Removes a video and its side records for good. */
async function purgeVideo(id: string, ownerId: string): Promise<void> {
  // Side records first and the video row last: a failure part-way leaves the video listed, so the
  // next listing retries the whole purge (every remove is idempotent) instead of orphaning a record.
  await clearShareLock(id);
  await clearCover(id);
  await clearComments(id, ownerId);
  await clearVideoLeads(id, ownerId);
  await clearHighlights(id, ownerId);
  await clearCleanups(id, ownerId);
  await clearLipsyncs(id, ownerId);
  await clearMusicJobs(id, ownerId);
  await getStore().remove("video", id);
}

/**
 * The owner's videos split into the library and the trash, newest first (the trash by deletion
 * time). Trashed videos past the retention period are deleted for good on the way, so the trash
 * empties itself without a scheduler.
 */
/** How many due videos one listing purges; the rest go on the next listing, so a big purge cannot stall a page. */
export const PURGE_PER_LIST = 20;

/** Purges in flight per owner, so concurrent listings (library poll, home, settings) share one pass. */
const purging = new Map<string, Promise<void>>();

/**
 * Deletes due videos for good, a bounded batch at a time, one pass per owner at a time. A failed
 * purge is logged and left for the next listing; it never fails the listing itself.
 */
function purgeDueVideos(ownerId: string, due: Video[]): Promise<void> {
  const running = purging.get(ownerId);
  if (running) return running;
  const run = Promise.allSettled(due.slice(0, PURGE_PER_LIST).map((v) => purgeVideo(v.id, ownerId)))
    .then((results) => {
      for (const r of results) if (r.status === "rejected") console.error(`purge failed for a trashed video of ${ownerId}:`, r.reason);
    })
    .finally(() => purging.delete(ownerId));
  purging.set(ownerId, run);
  return run;
}

async function loadVideos(ownerId: string): Promise<{ live: Video[]; trashed: Video[] }> {
  const videos = await getStore().list<Video>("video", ownerId);
  const now = Date.now();
  const due = videos.filter((v) => purgeDue(v, now));
  if (due.length) await purgeDueVideos(ownerId, due);
  // Whatever the purge managed, a due video is gone from the owner's point of view.
  const kept = due.length ? videos.filter((v) => !purgeDue(v, now)) : videos;
  const live = kept.filter((v) => !v.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const trashed = kept.filter((v) => !!v.deletedAt).sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!) || b.createdAt.localeCompare(a.createdAt));
  return { live, trashed };
}

/** Refreshes the newest in-flight renders of a library list from the provider; see `listVideos`. */
async function refreshPending(videos: Video[]): Promise<Video[]> {
  const now = Date.now();
  const pending = videos.filter((v) => isPending(v) && !isRefreshDeferred(v.id, now)).slice(0, REFRESH_PER_LIST);
  if (pending.length === 0) return videos;
  const refreshed = new Map((await Promise.all(pending.map((v) => refreshStatus(v)))).map((v) => [v.id, v]));
  return videos.map((v) => refreshed.get(v.id) ?? v);
}

/** The owner's library (or, with `trash`, the trash), newest first. See `loadVideos` for the purge. */
export async function listVideos(ownerId: string = LOCAL_OWNER, refresh = true, trash = false): Promise<Video[]> {
  const { live, trashed } = await loadVideos(ownerId);
  if (trash) return trashed;
  return refresh ? refreshPending(live) : live;
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
  // A trashed video past its retention is gone for the owner too, even before a listing purges it.
  if (purgeDue(video, Date.now())) throw new NotFoundError(`Video ${id} not found`);
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
  // Read and write under the video's lock, so an edit, review, or beacon landing as the render finishes is kept.
  const result = await withCounterLock(video.id, async () => {
    const current = await getStore().get<Video>("video", video.id);
    if (!current) return { next: video }; // deleted meanwhile; do not bring it back
    if (!isPending(current)) return { next: current }; // someone else already recorded the outcome
    const next: Video = { ...current, ...stripUndefined(update), updatedAt: nowIso() };
    if (next.status === current.status && next.videoUrl === current.videoUrl) return { next };
    await getStore().put("video", next);
    return { next, before: current };
  });
  if (result.before) await afterTransition(result.before, result.next);
  return result.next;
}

export const MAX_FOLDER_NAME = 40;

export const videoPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    /** Text under the share-page player (and the link preview's description); an empty string removes it. */
    description: z.string().trim().max(500).optional(),
    /** Folder name; an empty string moves the video back to "unfiled". */
    folder: z.string().trim().max(MAX_FOLDER_NAME).optional(),
    /** Whether the public share page offers a download link. */
    shareDownload: z.boolean().optional(),
    /** Whether the share page asks for the viewer's email before the player shows. */
    shareGate: z.boolean().optional(),
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
      p.description !== undefined ||
      p.folder !== undefined ||
      p.shareDownload !== undefined ||
      p.shareGate !== undefined ||
      p.shareDisabled !== undefined ||
      p.shareExpiresAt !== undefined ||
      p.sharePassword !== undefined ||
      p.shareCta !== undefined ||
      p.cover !== undefined,
    "Nothing to update",
  );

export async function updateVideo(id: string, patch: z.infer<typeof videoPatchSchema>, ownerId: string = LOCAL_OWNER): Promise<Video> {
  const existing = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  // A trashed video past its retention is gone (see getVideo); writing it would only feed the purge.
  if (purgeDue(existing, Date.now())) throw new NotFoundError(`Video ${id} not found`);
  const next: Video = { ...existing, updatedAt: nowIso() };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) {
    if (patch.description) next.description = patch.description;
    else delete next.description;
  }
  if (patch.folder !== undefined) {
    if (patch.folder) next.folder = patch.folder;
    else delete next.folder;
  }
  if (patch.shareDownload !== undefined) {
    if (patch.shareDownload) next.shareDownload = true;
    else delete next.shareDownload;
  }
  if (patch.shareGate !== undefined) {
    if (patch.shareGate) next.shareGate = true;
    else delete next.shareGate;
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
  // The title, description, cover, and call-to-action are what the share page shows; an approval does not outlive a change to them.
  const publicChange =
    (patch.title !== undefined && patch.title !== existing.title) ||
    (patch.description !== undefined && (patch.description || undefined) !== existing.description) ||
    patch.cover !== undefined ||
    (patch.shareCta !== undefined && JSON.stringify(patch.shareCta ?? null) !== JSON.stringify(existing.shareCta ?? null));
  return putKeepingCounters(next, { dropApproval: publicChange });
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
const COUNTER_FIELDS = ["views", "lastViewedAt", "viewsByDay", "watch", "ctaClicks", "lastCtaClickAt"] as const;
/**
 * Fields other writers own, which an edit built from an earlier read must take from the stored
 * record rather than from its own copy: the counters, the subtitle tracks, which a translation adds
 * under the lock, the corrected captions, which their own route saves under the lock, the trash mark, which a trash or restore sets under the lock, and the review, which
 * a request or decision sets under the lock, and the email preview's GIF link, which its renewal sets under the lock; an
 * owner edit changes none of them.
 */
const CONCURRENT_FIELDS = [...COUNTER_FIELDS, "subtitles", "captionCues", "deletedAt", "review", "gifUrl", "gifCheckedAt"] as const;

/**
 * Writes a video built from `base` while keeping whatever counters, subtitle tracks, and trash mark
 * the stored record holds by then: an edit that read the record before a scrypt or a network round
 * trip must not undo the views, watch marks, and clicks counted meanwhile, drop (or bring back) a
 * track a translation added or removed meanwhile, or undo a trash or restore. Runs under the
 * video's counter lock.
 */
function putKeepingCounters(base: Video, opts: { dropApproval?: boolean } = {}): Promise<Video> {
  return withCounterLock(base.id, async () => {
    const stored = await getStore().get<Video>("video", base.id);
    // Deleted (or purged) between the caller's read and this write: never bring it back without its side records.
    if (!stored) throw new NotFoundError(`Video ${base.id} not found`);
    const next: Video = { ...base };
    for (const field of CONCURRENT_FIELDS) delete next[field];
    const theirs: Partial<Video> = {};
    for (const field of CONCURRENT_FIELDS) if (stored[field] !== undefined) Object.assign(theirs, { [field]: stored[field] });
    // An approval covers what viewers of the share page see; changing that sends the video back to "not reviewed".
    if (opts.dropApproval && theirs.review?.status === "approved") delete theirs.review;
    return getStore().put("video", { ...next, ...theirs });
  });
}

/**
 * Writes a video derived from the record as stored at the moment of the write, under the counter
 * lock: `build` sees every edit, track, and counter that landed before it, so a decision that
 * depends on the current record (a key already present, a cap) is made on fresh data. A record
 * that is gone, trashed past retention, or someone else's is not found.
 */
function updateKeepingCounters(id: string, ownerId: string, build: (stored: Video) => Video): Promise<Video> {
  return withCounterLock(id, async () => {
    const stored = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
    if (purgeDue(stored, Date.now())) throw new NotFoundError(`Video ${id} not found`);
    const next = build(stored);
    // A builder that hands the stored record back has nothing to write (a live video "restored", a trashed one trashed again).
    if (next === stored) return stored;
    const counters: Partial<Video> = {};
    for (const field of COUNTER_FIELDS) if (stored[field] !== undefined) Object.assign(counters, { [field]: stored[field] });
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
    const now = Date.now();
    await getStore().put("video", { ...video, views, lastViewedAt: new Date(now).toISOString(), viewsByDay: bumpViewsByDay(video.viewsByDay, now) });
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
  /** Move to the trash (restorable for `TRASH_RETENTION_DAYS`). */
  z.object({ action: z.literal("delete"), ids: z.array(z.string().min(1)).min(1).max(200) }),
  /** Bring trashed videos back to the library. */
  z.object({ action: z.literal("restore"), ids: z.array(z.string().min(1)).min(1).max(200) }),
  /** Delete trashed videos for good; a video that is not in the trash is reported as missing. */
  z.object({ action: z.literal("purge"), ids: z.array(z.string().min(1)).min(1).max(200) }),
  z.object({ action: z.literal("move"), ids: z.array(z.string().min(1)).min(1).max(200), folder: z.string().trim().max(MAX_FOLDER_NAME) }),
  /** Switch the share links of many videos off (`shareDisabled: true`) or back on. */
  z.object({ action: z.literal("share"), ids: z.array(z.string().min(1)).min(1).max(200), shareDisabled: z.boolean() }),
]);

/**
 * Trash, restore, purge, move, or switch the share links of many videos at once. Ids that are
 * missing or belong to someone else are reported, not failed; so is a purge of a video that is
 * not in the trash, since deleting for good is only offered from there.
 */
export async function bulkVideos(input: z.infer<typeof bulkVideoSchema>, ownerId: string = LOCAL_OWNER): Promise<{ done: number; missing: string[] }> {
  const missing: string[] = [];
  let done = 0;
  for (const id of Array.from(new Set(input.ids))) {
    const existing = await getStore().get<Video>("video", id);
    // A trashed video past its retention is as good as gone, so it is reported rather than restored, moved, or written.
    if (!existing || (existing.ownerId ?? LOCAL_OWNER) !== ownerId || (input.action === "purge" && !existing.deletedAt) || (input.action !== "purge" && purgeDue(existing, Date.now()))) {
      missing.push(id);
      continue;
    }
    if (input.action === "delete") await deleteVideo(id, ownerId);
    else if (input.action === "restore") await restoreVideo(id, ownerId);
    else if (input.action === "purge") await purgeVideo(id, ownerId);
    else if (input.action === "move") await updateVideo(id, { folder: input.folder }, ownerId);
    else await updateVideo(id, { shareDisabled: input.shareDisabled }, ownerId);
    done += 1;
  }
  return { done, missing };
}

export const folderRenameSchema = z.object({
  /** The folder to rename or remove. */
  from: z.string().trim().min(1).max(MAX_FOLDER_NAME),
  /** The new name; empty removes the folder and leaves its videos unfiled. Renaming onto an existing folder merges them. */
  to: z.string().trim().max(MAX_FOLDER_NAME),
});

/**
 * Renames a folder by moving every video in it (trashed ones included, so a restore lands in the
 * renamed folder) to the new name, or unfiles them when the new name is empty. Returns how many moved.
 */
export async function renameFolder(input: z.infer<typeof folderRenameSchema>, ownerId: string = LOCAL_OWNER): Promise<{ moved: number }> {
  if (input.from === input.to) return { moved: 0 };
  const now = Date.now();
  const videos = (await getStore().list<Video>("video", ownerId)).filter((v) => v.folder === input.from && !purgeDue(v, now));
  let moved = 0;
  for (const v of videos) {
    try {
      await updateVideo(v.id, { folder: input.to }, ownerId);
      moved += 1;
    } catch (err) {
      // Deleted for good between the listing and its turn: nothing to rename, carry on with the rest.
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  return { moved };
}

/**
 * Submit a failed render again with the same request (scenes, presenter, look, quality) as a new
 * video, keeping its folder and batch row. Only failed videos can be retried; the original stays.
 */
export async function retryVideo(id: string, ownerId: string = LOCAL_OWNER): Promise<Video> {
  const failed = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  if (purgeDue(failed, Date.now())) throw new NotFoundError(`Video ${id} not found`);
  if (failed.status !== "failed") throw new ConflictError("Only failed renders can be retried");
  if (failed.deletedAt) throw new ConflictError("Restore the video from the trash before retrying it");
  const req = requestOf(failed);
  // One write: the provider's webhook can land as soon as the job exists, so nothing may overwrite the stored video afterwards.
  return createVideo(req, ownerId, undefined, false, { folder: failed.folder, description: failed.description, batchId: failed.batchId, rowLabel: failed.rowLabel, retryOf: failed.id, resizedFrom: failed.resizedFrom });
}

/** How long a keyed render's reserved row stands for a start still being sent (a function is cut off well before). */
const RESERVATION_MS = 2 * 60 * 1000;

/**
 * A render of a HeyGen Studio template: the template owns its scenes, presenter, and voice, so nothing is resolved or
 * prepared here; the renderer gets the template and its variables. Counted, stored, and followed like any render.
 */
async function createStudioTemplateVideo(req: VideoRequest & { studioTemplate: NonNullable<VideoRequest["studioTemplate"]> }, ownerId: string, skipLimit: boolean, { onStarted, ...extras }: VideoExtras): Promise<Video> {
  if (!skipLimit) await enforceRenderLimit(ownerId);
  const provider = getAvatarProvider();
  if (!provider.listStudioTemplates) throw new ValidationError(`HeyGen Studio templates are not available with the ${provider.name} renderer`);
  const base: Video = {
    ...req,
    ...stripUndefined(extras),
    id: extras.id ?? newId("vid"),
    ownerId,
    status: "queued",
    provider: provider.name,
    avatarName: req.studioTemplate.name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return startReserved(
    base,
    ownerId,
    !!extras.id,
    () => provider.createVideo({ ...req, ...(extras.id ? { idempotencyKey: extras.id } : {}) }, { id: req.avatarId, name: req.studioTemplate.name, provider: provider.name, source: "provider" } as Avatar, null),
    onStarted,
  );
}

/**
 * Starts a render whose row is already built (a template render, a cinematic shot) and stores it, counted unless it
 * failed to start. With a client key (`keyed`, the row's id derived from it), the row is reserved before the renderer
 * is asked, so a retry arriving while this one is still being sent is told so instead of starting a second render. One
 * reserved long ago whose start never came back (the function died) is started again; the renderer gets the same key,
 * so it is not rendered twice there.
 */
async function startReserved(base: Video, ownerId: string, keyed: boolean, send: () => Promise<{ providerJobId: string }>, onStarted?: () => void): Promise<Video> {
  if (keyed) {
    if (!(await getStore().insert("video", base))) {
      const held = await getStore().get<Video>("video", base.id);
      // The id is derived from the account and its key, so a row of another account's is a collision to refuse, not an answer.
      if (held && held.ownerId !== base.ownerId) throw new ConflictError("This Idempotency-Key cannot be used; send a new key");
      if (held && (held.status !== "queued" || held.providerJobId)) return held;
      if (held && Date.now() - Date.parse(held.createdAt) < RESERVATION_MS) throw new ConflictError("This render is still being sent; try again in a moment");
    }
  }
  try {
    const { providerJobId } = await send();
    base.providerJobId = providerJobId;
    base.status = "processing";
  } catch (err) {
    base.status = "failed";
    base.error = err instanceof Error ? err.message : String(err);
  }
  if (base.status !== "failed") await countRender(base, ownerId);
  const stored = await getStore().put("video", base);
  if (stored.status !== "failed") onStarted?.();
  return stored;
}

/**
 * A cinematic shot: the renderer directs the scene from the description with the shot's presenters, so only they are
 * resolved (as the account's own, like any render's) and prepared; there is no voice, script, or background to send.
 * Counted, stored, and followed like any render.
 */
async function createCinematicVideo(req: VideoRequest & { cinematic: NonNullable<VideoRequest["cinematic"]> }, ownerId: string, skipLimit: boolean, { onStarted, ...extras }: VideoExtras): Promise<Video> {
  if (!skipLimit) await enforceRenderLimit(ownerId);
  const provider = getAvatarProvider();
  if (!provider.cinematicShots) throw new ValidationError(`Cinematic shots are not available with the ${provider.name} renderer`);
  // Another account's presenter reads as not found, like any record the caller does not own; one deleted since is
  // named by its name then, not its id. Their names are taken now, so a retry after a rename shows the names it renders with.
  const avatars = await Promise.all(
    req.cinematic.avatarIds.map((id, i) =>
      getAvatar(id, ownerId).catch((err) => {
        if (!(err instanceof NotFoundError)) throw err;
        const name = req.cinematic.avatarNames[i];
        throw new NotFoundError(name ? `The presenter “${name}” is no longer in your library; make the shot with another` : "A presenter of the shot is no longer in your library; choose another");
      }),
    ),
  );
  req = { ...req, avatarId: avatars[0].id, cinematic: { ...req.cinematic, avatarNames: avatars.map((a) => a.name) } };
  const base: Video = {
    ...req,
    ...stripUndefined(extras),
    id: extras.id ?? newId("vid"),
    ownerId,
    status: "queued",
    provider: provider.name,
    avatarName: avatars.map((a) => a.name).join(", "),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return startReserved(base, ownerId, !!extras.id, async () => {
    const cast: RenderCast = { avatars: {}, voices: {} };
    // Side by side, so several presenters waiting on the renderer wait once.
    await Promise.all(
      avatars.map(async (a) => {
        cast.avatars[a.id] = a.source === "custom" && provider.prepareAvatar ? await prepareOnce(provider, a) : a;
      }),
    );
    return provider.createVideo({ ...req, ...(extras.id ? { idempotencyKey: extras.id } : {}) }, cast.avatars[avatars[0].id], null, cast);
  }, onStarted);
}

/** The request a stored video was rendered from, to render it again (a retry, another size). */
function requestOf(video: Video): VideoRequest {
  return {
    title: video.title,
    script: video.script,
    scenes: video.scenes,
    avatarId: video.avatarId,
    voiceId: video.voiceId,
    aspect: video.aspect,
    resolution: video.resolution,
    background: video.background,
    captions: video.captions,
    ...(video.captionStyle ? { captionStyle: video.captionStyle } : {}),
    speed: video.speed,
    ...(video.pitch ? { pitch: video.pitch } : {}),
    ...(video.emotion ? { emotion: video.emotion } : {}),
    ...(video.expressiveness ? { expressiveness: video.expressiveness } : {}),
    ...(video.motionPrompt ? { motionPrompt: video.motionPrompt } : {}),
    ...(video.accent ? { accent: video.accent } : {}),
    ...(video.avatarEngine ? { avatarEngine: video.avatarEngine } : {}),
    ...(video.transparent ? { transparent: true as const } : {}),
    ...(video.studioTemplate ? { studioTemplate: video.studioTemplate } : {}),
    ...(video.cinematic ? { cinematic: video.cinematic } : {}),
  };
}

export const resizeSchema = z.object({
  aspects: z
    .array(z.enum(["16:9", "9:16", "1:1"]))
    .min(1, "Choose at least one size")
    .max(3)
    .transform((a) => Array.from(new Set(a))),
});

/** The shapes a title of another size ends with, so a size made from a size is titled from the original. */
const SIZE_SUFFIX = / \((?:16:9|9:16|1:1)\)$/;

/** A video's family: the original and every size made from it, trashed ones included, the original first. */
async function sizeFamily(video: Video, ownerId: string): Promise<Video[]> {
  const rootId = video.resizedFrom ?? video.id;
  const now = Date.now();
  const all = await getStore().list<Video>("video", ownerId);
  const family = all.filter((v) => !purgeDue(v, now) && (v.id === rootId || v.resizedFrom === rootId));
  family.sort((a, b) => Number(b.id === rootId) - Number(a.id === rootId) || a.createdAt.localeCompare(b.createdAt));
  return family;
}

/** A video's sizes: the original and every live (not trashed) size made from it, the original first. */
export async function videoSizes(id: string, ownerId: string = LOCAL_OWNER): Promise<Array<Pick<Video, "id" | "title" | "aspect" | "status">>> {
  const video = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  // Sizes still rendering are asked about, as the library does, so a finished size does not read "rendering" for good.
  const live = await refreshPending((await sizeFamily(video, ownerId)).filter((v) => !v.deletedAt));
  return live.map(({ id: vid, title, aspect, status }) => ({ id: vid, title, aspect, status }));
}

/**
 * A title of at most `max` characters as the request schema counts them (UTF-16 units), cut at whole characters; a
 * single character longer than the room (a letter with a long run of combining marks) is cut by code point instead.
 */
function fitTitle(text: string, max: number): string {
  let out = "";
  for (const ch of graphemes(text)) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  if (!out.trim()) {
    for (const ch of Array.from(text)) {
      if (out.length + ch.length > max) break;
      out += ch;
    }
  }
  return out.trimEnd();
}

/**
 * "Make other sizes": renders the video again in each of `aspects` (the other frame shapes), with the same scenes,
 * presenter, voice, look, settings, corrected captions, and subtitle languages, each a new video titled with its shape,
 * in the same folder, recording the original it was made from (a size made from a size points at the same original).
 * The allowance is checked for all of them before any starts, as a batch's is; a size that cannot be started is
 * returned as failed rather than losing the sizes already started.
 */
export async function resizeVideo(id: string, input: z.infer<typeof resizeSchema>, ownerId: string = LOCAL_OWNER): Promise<{ videos: Video[]; failed: Array<{ aspect: string; error: string }> }> {
  const source = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  if (purgeDue(source, Date.now())) throw new NotFoundError(`Video ${id} not found`);
  if (source.deletedAt) throw new ConflictError("Restore the video from the trash before making other sizes");
  // A HeyGen Studio template has one shape, its own.
  if (source.studioTemplate) throw new ValidationError("A video made from a HeyGen template keeps the template's shape; make the other size in HeyGen Studio");
  // A shot is directed for its frame: another shape is another shot, made from the description again.
  if (source.cinematic) throw new ValidationError("A cinematic shot is directed for its own shape; make the shot again in another shape from the Cinematic page");
  // A shape the video already has is not made again: the original's (even in the trash, as it can be restored) and
  // each size made from it that is not in the trash. A size whose render could not be started used no render and holds
  // nothing to watch, so its shape can be made again.
  const rootId = source.resizedFrom ?? source.id;
  const existing = new Set(
    (await sizeFamily(source, ownerId)).filter((v) => v.id === rootId || (!v.deletedAt && v.status !== "failed")).map((v) => v.aspect),
  );
  existing.add(source.aspect);
  const aspects = input.aspects.filter((a) => !existing.has(a));
  if (!aspects.length) throw new ValidationError(input.aspects.length === 1 ? `The video already has a ${input.aspects[0]} size` : "The video already has those sizes");
  const limit = await renderLimitFor(ownerId);
  if (limit) {
    const used = await rendersThisMonth(ownerId);
    if (used + aspects.length > limit) {
      throw new LimitError(`Not enough renders left this month for ${aspects.length} ${aspects.length === 1 ? "size" : "sizes"} (${used} of ${limit} used). The allowance resets on the 1st.`);
    }
  }
  const req = requestOf(source);
  // Resolved once for every size, as a batch resolves its presenter once (an uploaded portrait is prepared once).
  const ctx = await resolveRenderContext(req, ownerId);
  const base = source.resizedFrom ? source.title.replace(SIZE_SUFFIX, "") : source.title;
  const extras: VideoExtras = {
    folder: source.folder,
    description: source.description,
    resizedFrom: source.resizedFrom ?? source.id,
    // The same scripts in the same voice: the corrections and translations hold for every shape.
    captionCues: source.captionCues,
    subtitles: source.subtitles,
  };
  const videos: Video[] = [];
  const failed: Array<{ aspect: string; error: string }> = [];
  for (const aspect of aspects) {
    // The shape names the copy; the title keeps within its 120 characters, cut at whole characters.
    const suffix = ` (${aspect})`;
    const title = `${fitTitle(base, 120 - suffix.length)}${suffix}`;
    try {
      videos.push(await createVideo({ ...req, title, aspect }, ownerId, ctx, true, extras));
    } catch (err) {
      failed.push({ aspect, error: err instanceof Error ? err.message : "The render could not be started" });
    }
  }
  return { videos, failed };
}

/**
 * Moves a video to the trash, where the public sees "not found" and the owner can restore it for
 * `TRASH_RETENTION_DAYS`; with `permanent` it is deleted for good straight away, side records included.
 * Trashing an already trashed video keeps its original deletion time.
 */
export async function deleteVideo(id: string, ownerId: string = LOCAL_OWNER, permanent = false): Promise<{ title: string; changed: boolean }> {
  const video = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  if (permanent) {
    if (!video.deletedAt) throw new ConflictError("Move the video to the trash first; deleting for good is offered from there");
    await purgeVideo(id, ownerId);
    return { title: video.title, changed: true };
  }
  if (video.deletedAt) return { title: video.title, changed: false };
  // Decided under the lock: a request that trashed the video between our read and our turn did the change, not us.
  let changed = false;
  const next = await updateKeepingCounters(id, ownerId, (stored) => {
    if (stored.deletedAt) return stored;
    changed = true;
    return { ...stored, deletedAt: nowIso(), updatedAt: nowIso() };
  });
  return { title: next.title, changed };
}

/** Brings a trashed video back to the library; a video that is not in the trash is returned as is. */
export function restoreVideo(id: string, ownerId: string = LOCAL_OWNER): Promise<Video> {
  // Past its retention it is as good as gone (the helper says not found), whether or not a listing has purged it yet.
  return updateKeepingCounters(id, ownerId, (stored) => {
    if (!stored.deletedAt) return stored;
    const { deletedAt: _gone, ...rest } = stored;
    void _gone;
    return { ...rest, updatedAt: nowIso() };
  });
}

export async function applyAvatarWebhook(providerName: string, body: unknown): Promise<Video | null> {
  const provider = getAvatarProviderByName(providerName);
  const parsed = provider.parseWebhook?.(body);
  if (!parsed) return null;
  const video = await getStore().findBy<Video>("video", "providerJobId", parsed.providerJobId);
  if (!video) return null;
  // A late or repeated terminal webhook must not overwrite a recorded outcome (and the counts
  // that landed on it since), nor announce the completion twice. The record is read again under the
  // video's lock, so an edit, review, or beacon that landed after the lookup is kept.
  const result = await withCounterLock(video.id, async () => {
    const current = await getStore().get<Video>("video", video.id);
    if (!current || !isPending(current)) return { next: current ?? video };
    const next: Video = { ...current, ...stripUndefined(parsed.update), updatedAt: nowIso() };
    await getStore().put("video", next);
    return { next, before: current };
  });
  if (result.before) await afterTransition(result.before, result.next);
  return result.next;
}

// ---------------------------------------------------------------------------
// Library queries: filtering, sorting, and paging for GET /api/videos.

export const videoQuerySchema = z.object({
  /** Case-insensitive match on title, description, script, avatar, and voice names. */
  q: z.string().trim().max(200).default(""),
  /** "processing" also covers queued renders. */
  status: z.enum(["all", "processing", "completed", "failed"]).default("all"),
  /** A folder name; an empty string means unfiled; absent means every folder. */
  folder: z.string().trim().max(MAX_FOLDER_NAME).optional(),
  batch: z.string().max(80).optional(),
  sort: z.enum(["newest", "oldest", "title", "views"]).default("newest"),
  /** Review state in a workspace: "pending" (awaiting an owner), "approved", "changes", or "none" (never asked). */
  review: z.enum(["all", "pending", "approved", "changes", "none"]).default("all"),
  /** Omit for every match (scripts); the library pages with it. */
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** `true` lists the trash (newest deletion first) instead of the library. */
  trash: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});
export type VideoQuery = z.infer<typeof videoQuerySchema>;

export interface VideoPage {
  videos: Video[];
  /** Matches for the query, before `limit`. */
  matched: number;
  /** Every video in the owner's library (the trash not counted), before filtering, whichever view this is. */
  total: number;
  hasMore: boolean;
  /** Folder names in use, for the filter control. */
  folders: string[];
  /** Renders still in flight, across the whole library. */
  rendering: number;
  /** Videos in the trash, so the library can offer the view. */
  trashed: number;
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
      if (query.review !== "all" && (v.review?.status ?? "none") !== query.review) return false;
      if (query.folder !== undefined && (v.folder ?? "") !== query.folder) return false;
      if (query.status === "processing" ? v.status !== "processing" && v.status !== "queued" : query.status !== "all" && v.status !== query.status) return false;
      return !needle || `${v.title} ${v.description ?? ""} ${stripPauses(v.script)} ${v.cinematic?.prompt ?? ""} ${v.avatarName ?? ""} ${v.voiceName ?? ""}`.toLowerCase().includes(needle);
    })
    .sort(SORTERS[query.sort]);
}

/**
 * One page of the owner's library (in-flight renders refreshed first; see listVideos), or of the
 * trash with `query.trash`, where `sort: "newest"` orders by deletion time.
 */
export async function queryVideos(ownerId: string = LOCAL_OWNER, query: VideoQuery): Promise<VideoPage> {
  const split = await loadVideos(ownerId);
  const live = query.trash ? split.live : await refreshPending(split.live);
  const all = query.trash ? split.trashed : live;
  const trashed = split.trashed.length;
  const filtered = filterVideos(all, query);
  // The trash reads newest deletion first; `filterVideos` sorted by creation, so put the deletion order back.
  const matched = query.trash && query.sort === "newest" ? filtered.sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!) || b.createdAt.localeCompare(a.createdAt)) : filtered;
  const videos = query.limit ? matched.slice(0, query.limit) : matched;
  return {
    // Subtitle text and corrected captions are for the video page and the share player, not for a card: they are left off the page.
    videos: videos.map(({ subtitles: _subtitles, captionCues: _captionCues, ...rest }) => rest),
    matched: matched.length,
    total: live.length,
    hasMore: videos.length < matched.length,
    folders: Array.from(new Set(all.map((v) => v.folder).filter((f): f is string => !!f))).sort(),
    // Renders in flight in the library, whichever view this is: the trash view must not poll for a trashed render.
    rendering: live.filter((v) => v.status === "processing" || v.status === "queued").length,
    trashed,
  };
}

// The picture an email shows for a shared video: the renderer's animated GIF of it, linked to the share page. The GIF's
// link is the renderer's, signed for a limited time, so it is asked for again once old, at most once per video every
// few minutes however many inboxes open the email.

const gifAttempted = new Map<string, number>();
const gifInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Where a shared video's email picture is, for the public: the animated GIF, or the cover (or the renderer's thumbnail)
 * when there is no GIF or the link asks for an email first, since moving footage would stand in for the form. Null for a
 * password-protected link, an unfinished video, or a video with no picture at all; not found like the share page.
 */
export async function emailPreview(id: string, now = Date.now()): Promise<{ url: string; animated: boolean } | null> {
  const video = await getVideo(id, PUBLIC_ACCESS, false);
  if (video.shareLocked || video.status !== "completed") return null;
  const poster = posterUrl(video, config.appUrl.replace(/\/$/, ""));
  const still = poster ? { url: poster, animated: false } : null;
  if (video.shareGate) return still;
  const gif = await freshGif(video, now);
  return gif ? { url: gif, animated: true } : still;
}

async function freshGif(video: Video, now: number): Promise<string | undefined> {
  // One that came with the finished render has no check time of its own (an edit moves `updatedAt`), so it is asked for once.
  if (video.gifUrl && video.gifCheckedAt && now - Date.parse(video.gifCheckedAt) <= RELINK_MS) return video.gifUrl;
  let provider: AvatarProvider;
  try {
    provider = getAvatarProviderByName(video.provider);
  } catch {
    return video.gifUrl;
  }
  if (!provider.gifPreviews || !video.providerJobId) return video.gifUrl;
  const running = gifInFlight.get(video.id);
  if (running) return running;
  // A renderer that could not answer (or had no GIF) is not asked again for a while, so a busy email cannot cost a call per open.
  if (now - (gifAttempted.get(video.id) ?? 0) < RETRY_FINISHED_MS) return video.gifUrl;
  gifAttempted.set(video.id, now);
  for (const [vid, at] of gifAttempted) if (now - at > RETRY_FINISHED_MS * 2) gifAttempted.delete(vid);
  const run = renewGif(provider, video).finally(() => gifInFlight.delete(video.id));
  gifInFlight.set(video.id, run);
  return run;
}

/** Asks the renderer for a fresh GIF link and stores it; never throws (the old link, if any, is the answer then). */
async function renewGif(provider: AvatarProvider, video: Video): Promise<string | undefined> {
  let gifUrl: string | undefined;
  try {
    const status = await provider.getStatus(video.providerJobId!);
    gifUrl = status.status === "completed" ? status.gifUrl : undefined;
  } catch (err) {
    console.error(`preview refresh failed for ${video.id}:`, err);
    return video.gifUrl;
  }
  if (!gifUrl) return video.gifUrl;
  await withCounterLock(video.id, async () => {
    const current = await getStore().get<Video>("video", video.id);
    // Deleted meanwhile: never brought back.
    if (current) await getStore().put("video", { ...current, gifUrl, gifCheckedAt: nowIso() });
  });
  return gifUrl;
}

/** Forgets when previews were last asked for (tests). */
export function forgetGifChecks(): void {
  gifAttempted.clear();
}
