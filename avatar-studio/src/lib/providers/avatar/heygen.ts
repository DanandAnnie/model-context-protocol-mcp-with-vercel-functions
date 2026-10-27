import { STUDIO_VARIABLE_TYPES, backdropIdOf, isPhotoAvatar, rendersOnAvatarV, type AudioClip, type Avatar, type Backdrop, type Background, type Scene, type StudioTemplate, type StudioTemplateDetail, type StudioVariable, type VideoRequest, type Voice } from "../../types";
import { silentSeconds, withBreakTags } from "../../pauses";
import { heygenBurnsCaptions } from "../../captions";
import { voiceTakesAccent } from "../../language";
import { webhookUrl } from "../../config";
import { loadImage } from "../image";
import { HeyGenClient } from "../heygen-client";
import { NotFoundError, ValidationError } from "../../errors";
import type { AvatarJobStatus, AvatarProvider, CleanupStatus, HighlightInput, HighlightStatus, RenderCast } from "../types";

/**
 * Where a custom portrait's v3 photo avatar look is kept (`providerAssetIds`). Portraits uploaded as v1 talking photos
 * kept theirs under "heygen"; those are made again once as v3 looks rather than trusted to work as look ids.
 */
const LOOK = "heygen:look";
/** Marks a photo avatar HeyGen was still preparing when last asked, so it is asked again. */
const PENDING = "heygen:pending";
/**
 * Where uploaded clips and background images keep their v3 asset ids. Ids from the v1 upload endpoint, kept under
 * "heygen", are uploaded again once rather than trusted as v3 asset ids.
 */
const ASSET = "heygen:asset";
/** How often, and how long, a new photo avatar is waited for before its first render: about ten seconds. */
const PHOTO_CHECKS = 4;
const PHOTO_CHECK_MS = 3000;

export class HeyGenAvatarProvider implements AvatarProvider {
  readonly name = "heygen";
  readonly assetKey = ASSET;
  private client: HeyGenClient;
  constructor(apiKey: string) {
    this.client = new HeyGenClient(apiKey);
  }

  async listAvatars(): Promise<Avatar[]> {
    const looks = await this.client.listAvatarLooks();
    return looks
      // A photo avatar HeyGen is still preparing, or could not prepare, cannot render yet.
      .filter((l) => (!l.status || l.status === "completed") && l.preview_image_url)
      .map((l) => ({
        id: l.id,
        name: l.name,
        imageUrl: l.preview_image_url ?? "",
        ...(l.preview_video_url ? { previewVideoUrl: l.preview_video_url } : {}),
        source: "provider" as const,
        provider: this.name,
        gender: (l.gender?.toLowerCase() as Avatar["gender"]) ?? undefined,
        ...(l.avatar_type === "photo_avatar" ? { tags: ["photo avatar"] } : l.tags?.length ? { tags: l.tags.slice(0, 4) } : {}),
        ...(l.supported_api_engines?.includes("avatar_v") ? { avatarV: true as const } : {}),
      }));
  }

  /**
   * A custom portrait becomes a HeyGen photo avatar once (v3): the image is uploaded as an asset and a photo avatar look
   * made from it. HeyGen prepares the look before it can render, so a new one is waited for briefly; one still being
   * prepared is kept, marked pending, and the next render asks about it once, without waiting again, so a batch or a
   * video with several presenters stays well inside a request's time. A look HeyGen lost or could not prepare is made
   * again from the portrait.
   */
  async prepareAvatar(avatar: Avatar): Promise<Avatar> {
    if (avatar.source !== "custom") return avatar;
    const known = avatar.providerAssetIds?.[LOOK];
    if (known && !avatar.providerAssetIds?.[PENDING]) return avatar;
    if (known) {
      const look = await this.lookState(known);
      if (look.state === "completed") return this.withLook(avatar, known, false);
      if (look.state === "processing") return avatar;
    }
    const { bytes, mimeType } = await loadImage(avatar.imageUrl);
    const assetId = await this.client.uploadAsset(bytes, mimeType, `portrait.${mimeType.split("/")[1] ?? "jpg"}`);
    const id = (await this.client.createPhotoAvatar(avatar.name.slice(0, 80), assetId)).id;
    for (let i = 0; i < PHOTO_CHECKS; i++) {
      const look = await this.lookState(id);
      if (look.state === "completed") return this.withLook(avatar, id, false);
      if (look.state !== "processing") throw new ValidationError(`HeyGen could not prepare the photo avatar "${avatar.name}"${look.message ? `: ${look.message}` : ""}. Try another photo.`);
      if (i < PHOTO_CHECKS - 1) await this.sleep(PHOTO_CHECK_MS);
    }
    return this.withLook(avatar, id, true);
  }

  private withLook(avatar: Avatar, id: string, pending: boolean): Avatar {
    return { ...avatar, providerAssetIds: { ...avatar.providerAssetIds, [LOOK]: id, [PENDING]: pending ? "1" : "" } };
  }

  /** Where a photo avatar look stands; a look HeyGen no longer knows is gone. Other errors (a key, a limit) are thrown. */
  private async lookState(id: string): Promise<{ state: "completed" | "processing" | "failed" | "gone"; message?: string }> {
    try {
      const look = await this.client.getLook(id);
      if (look.status === "completed") return { state: "completed" };
      if (look.status === "failed") return { state: "failed", message: look.error?.message ?? undefined };
      return { state: "processing" };
    } catch (err) {
      if (/ failed: (404|410)\b/.test(err instanceof Error ? err.message : "")) return { state: "gone" };
      throw err;
    }
  }

  /** A clip is uploaded once as a HeyGen audio asset; scenes then name it by asset id. */
  async prepareAudio(clip: AudioClip, audio: { bytes: Uint8Array; mimeType: string }): Promise<AudioClip> {
    if (clip.providerAssetIds?.[ASSET]) return clip;
    const id = await this.client.uploadAsset(audio.bytes, audio.mimeType, `clip.${audio.mimeType.includes("wav") ? "wav" : "mp3"}`);
    return { ...clip, providerAssetIds: { ...clip.providerAssetIds, [ASSET]: id } };
  }

  /** An uploaded background image is sent once as a HeyGen image asset; scenes then name it by asset id. */
  async prepareBackdrop(backdrop: Backdrop, image: { bytes: Uint8Array; mimeType: string }): Promise<Backdrop> {
    if (backdrop.providerAssetIds?.[ASSET]) return backdrop;
    const id = await this.client.uploadAsset(image.bytes, image.mimeType, `background.${image.mimeType.split("/")[1] ?? "png"}`);
    return { ...backdrop, providerAssetIds: { ...backdrop.providerAssetIds, [ASSET]: id } };
  }

  /**
   * One studio video (v3 `POST /v3/videos`, `type: "studio"`): a scene per scene of the request, each with its own
   * presenter, voice or clip, speed, and background, composed by HeyGen on one canvas of the video's shape and quality.
   * HeyGen's v3 API places every presenter itself and has no on-screen text element, framing, background fit, or
   * emotion, so those settings are kept with the video but not sent. A scene without the presenter is a whole-frame
   * `image` or `video` scene of its background, narrated by its voice or clip, or silent.
   */
  async createVideo(req: VideoRequest, avatar: Avatar, voice: Voice | null, cast?: RenderCast) {
    // A Studio template owns its scenes, presenter, and voice: only its variables, the title, and captions are sent.
    if (req.studioTemplate) {
      const { video_id } = await this.client.generateFromTemplate(req.studioTemplate.id, {
        variables: req.studioTemplate.variables,
        title: req.title,
        caption: req.captions,
        ...(webhookUrl("heygen") ? { callback_url: webhookUrl("heygen") } : {}),
      });
      return { providerJobId: video_id };
    }
    const scenes: Scene[] = req.scenes?.length ? req.scenes : [{ script: req.script, background: req.background }];
    // Every scene's presenter, clip, voice, and background is checked before anything is uploaded for the render.
    const sceneAvatarOf = (scene: Scene) => (scene.avatarId && cast?.avatars[scene.avatarId]) || avatar;
    const parts = scenes.map((scene) => {
      const sceneAvatar = sceneAvatarOf(scene);
      const sceneVoice = (scene.voiceId && cast?.voices[scene.voiceId]) || voice;
      const hidden = !!scene.hidePresenter && scene.background.type !== "color";
      return {
        scene,
        hidden,
        avatarId: hidden ? undefined : this.lookId(sceneAvatar),
        clip: scene.audioId ? this.audioAssetId(scene.audioId, cast) : undefined,
        silent: scene.audioId ? 0 : silentSeconds(scene.script),
        voiceId: scene.audioId ? undefined : this.voiceId(sceneVoice, req.voiceId),
        accent: voiceTakesAccent(sceneVoice, req.accent) ? req.accent : undefined,
        // A transparent video sends no background (HeyGen refuses one with WebM), so none is resolved.
        background: req.transparent && !hidden ? undefined : this.background(scene.background, cast),
      };
    });
    // HeyGen's v3 studio has no silence input: a scene of only pauses lip-syncs to an uploaded clip of silence that long.
    const silences = new Map<number, string>();
    // (A silent picture is simply held for that long.)
    const needSilence = parts.filter((p) => p.silent && !(p.hidden && p.scene.background.type === "image"));
    for (const sec of new Set(needSilence.map((p) => p.silent))) {
      silences.set(sec, await this.client.uploadAsset(silentWav(sec), "audio/wav", `silence-${sec}s.wav`));
    }
    const body = {
      type: "studio",
      title: req.title,
      aspect_ratio: req.aspect,
      resolution: req.resolution,
      // HeyGen burns captions in at its own position and size; a video with a caption style of its
      // own is captioned by the share page's subtitle track instead, so the chosen look is the only one.
      ...(heygenBurnsCaptions(req) ? { caption: { file_format: "srt", style: "default" } } : {}),
      ...(webhookUrl("heygen") ? { callback_url: webhookUrl("heygen") } : {}),
      scenes: parts.map(({ scene, hidden, avatarId, clip, silent, voiceId, accent, background }) => {
        const audio = clip ?? (silent ? silences.get(silent) : undefined);
        // An audio scene lip-syncs to its clip, a silent one to its silence; speed, pitch, and accent apply to speech only.
        const sound = audio
          ? { audio_asset_id: audio }
          : { script: withBreakTags(scene.script), voice_id: voiceId, voice_settings: { speed: scene.speed ?? req.speed ?? 1, ...(req.pitch ? { pitch: req.pitch } : {}), ...(accent ? { locale: accent } : {}) } };
        if (hidden) {
          const { source } = background as { source: unknown };
          // A picture is narrated, or held as long as the silence; a video loops muted under the narration, as it
          // does behind a presenter, for as long as the scene's audio runs.
          return scene.background.type === "image"
            ? { type: "image", source, ...(silent && !clip ? { duration: silent } : sound) }
            : { type: "video", source, playback: { mode: "loop", mute: true }, ...sound };
        }
        // Avatar V where the look supports it (a photo avatar given motion settings stays on Avatar IV; see rendersOnAvatarV).
        const onV = req.avatarEngine === "avatar_v" && rendersOnAvatarV(sceneAvatarOf(scene), req);
        const engine = onV ? { engine: { type: "avatar_v" } } : {};
        // A photo avatar moves as asked (on Avatar IV). A video avatar takes gestures on Avatar V only, as HeyGen refuses a
        // motion prompt for one on Avatar IV; expressiveness is for photo avatars alone.
        const photo = isPhotoAvatar(sceneAvatarOf(scene));
        const motion = photo
          ? { ...(req.expressiveness ? { expressiveness: req.expressiveness } : {}), ...(req.motionPrompt ? { motion_prompt: req.motionPrompt } : {}) }
          : onV && req.motionPrompt
            ? { motion_prompt: req.motionPrompt }
            : {};
        return { type: "avatar_video", input: { type: "avatar", avatar_id: avatarId, ...sound, ...motion, ...engine, background } };
      }),
    };
    // A transparent video is HeyGen's single-avatar video as a WebM: the presenter alone, its background removed
    // (HeyGen refuses a background with WebM) and no captions burned over the alpha (heygenBurnsCaptions); the share page subtitles it.
    const sent = req.transparent ? this.transparentBody(body) : body;
    try {
      const data = await this.client.generateVideo(sent);
      return { providerJobId: data.video_id };
    } catch (err) {
      // Avatar V can be refused where Avatar IV is not (a look's reference whose consent is missing), and a retry
      // asks again, so the error says how to get past it.
      if (err instanceof Error && body.scenes.some((sc) => "input" in sc && sc.input && "engine" in sc.input)) {
        throw new Error(`${err.message} (this video asked for Avatar V; if HeyGen refused it, make a copy with Avatar engine set to Avatar IV)`);
      }
      throw err;
    }
  }

  /** A one-scene studio body as v3's `type: "avatar"` body with a WebM output (the schema refuses a background). */
  private transparentBody(studio: { title: string; aspect_ratio: string; resolution?: string; callback_url?: string; scenes: Array<Record<string, unknown>> }) {
    const scene = studio.scenes[0] as { type: string; input?: Record<string, unknown> };
    if (studio.scenes.length !== 1 || scene.type !== "avatar_video" || !scene.input) {
      throw new ValidationError("A transparent background is for a one-scene video that shows the presenter");
    }
    const { background: _background, type: _type, ...input } = scene.input;
    return {
      type: "avatar",
      title: studio.title,
      aspect_ratio: studio.aspect_ratio,
      resolution: studio.resolution,
      ...(studio.callback_url ? { callback_url: studio.callback_url } : {}),
      output_format: "webm",
      ...input,
    };
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** The look a presenter renders as: a provider avatar's own id, or the photo avatar made from a custom portrait. */
  private lookId(avatar: Avatar): string {
    if (avatar.source !== "custom") return avatar.id;
    const id = avatar.providerAssetIds?.[LOOK];
    if (!id) throw new Error(`Custom avatar "${avatar.name}" has not been uploaded to HeyGen yet.`);
    if (avatar.providerAssetIds?.[PENDING]) throw new ValidationError(`HeyGen is still preparing the photo avatar "${avatar.name}". Generate again in a minute.`);
    return id;
  }

  /** A scene's background as HeyGen composes it behind the presenter; pictures and videos always fill the frame. */
  private background(background: Background, cast?: RenderCast) {
    if (background.type === "color") return { type: "color", color: hexColor(background.value) };
    if (background.type === "video") return { type: "video", source: { type: "url", url: background.value } };
    const backdropId = backdropIdOf(background);
    if (!backdropId) return { type: "image", source: { type: "url", url: background.value } };
    const id = cast?.backdrops?.[backdropId]?.providerAssetIds?.[ASSET];
    if (!id) throw new Error(`Background image ${backdropId} has not been uploaded to HeyGen yet.`);
    return { type: "image", source: { type: "asset_id", asset_id: id } };
  }

  private audioAssetId(audioId: string, cast?: RenderCast): string {
    const id = cast?.clips?.[audioId]?.providerAssetIds?.[ASSET];
    if (!id) throw new Error(`Audio clip ${audioId} has not been uploaded to HeyGen yet.`);
    return id;
  }

  private voiceId(voice: Voice | null, fallback: string): string {
    if (voice && voice.provider !== this.name) {
      throw new Error(`HeyGen renders need a HeyGen voice; "${voice.name}" comes from ${voice.provider}.`);
    }
    return voice?.id ?? fallback;
  }

  /**
   * A presenter drawn from a description (v3 prompt to avatar), 4:5 like an uploaded portrait. The look stays in the
   * HeyGen account; the studio keeps its picture as a custom portrait, made into a photo avatar like any upload.
   */
  async generatePortrait({ name, prompt }: { name: string; prompt: string }) {
    try {
      const { look_id } = await this.client.createPromptAvatar(name, prompt);
      return { jobId: look_id };
    } catch (err) {
      // A description HeyGen will not draw (refused by moderation, or not usable) is the account's to change.
      const message = err instanceof Error ? err.message : "";
      if (/ failed: (400|402|403|422) /.test(message) || message.startsWith("HeyGen error:")) throw new ValidationError(`HeyGen could not draw that presenter: ${heygenReason(message)}`);
      throw err;
    }
  }

  async portraitStatus(jobId: string): Promise<{ status: "processing" | "completed" | "failed"; imageUrl?: string; error?: string }> {
    let look;
    try {
      look = await this.client.getLook(jobId);
    } catch (err) {
      // A failed look answers with its error (moderation, or a training failure): that is the job's outcome.
      const message = err instanceof Error ? err.message : "";
      if (message.startsWith("HeyGen error:")) return { status: "failed", error: message.slice("HeyGen error:".length).trim() || "HeyGen could not draw that presenter" };
      throw err;
    }
    if (look.status === "completed") return look.preview_image_url ? { status: "completed", imageUrl: look.preview_image_url } : { status: "failed", error: "HeyGen finished the presenter without a picture" };
    if (look.status === "failed") return { status: "failed", error: look.error?.message ?? "HeyGen could not draw that presenter" };
    return { status: "processing" };
  }

  /**
   * Short highlight clips cut from a finished video (v3 AI Clipping): one per length, framed as asked, with captions
   * burned in or not. HeyGen picks the moments, guided by the prompt when there is one.
   */
  async startHighlights(input: HighlightInput) {
    try {
      const jobId = await this.client.createClipping({
        video: { type: "url", url: input.videoUrl },
        title: input.title,
        output_settings: {
          duration_types: input.lengths,
          aspect_ratio: CLIP_FRAMES[input.frame],
          captions: input.captions,
          ...(input.prompt ? { prompt: input.prompt } : {}),
        },
        // No callback: the studio follows the job when its clips are looked at, as it does a portrait.
      });
      return { jobId };
    } catch (err) {
      // A video HeyGen will not clip (too short, unreadable, or past the plan) is the account's to change; a refused key is not.
      const message = err instanceof Error ? err.message : "";
      if (/ failed: (400|402|422) /.test(message) || message.startsWith("HeyGen error:")) throw new ValidationError(`HeyGen could not clip that video: ${heygenReason(message, "check that the video is longer than the clips and has speech")}`);
      throw err;
    }
  }

  async highlightsStatus(jobId: string): Promise<HighlightStatus> {
    let job;
    try {
      job = await this.client.clipping(jobId);
    } catch (err) {
      // A job HeyGen no longer has (expired, or made with another key) will not come back: its links are dead too.
      if (err instanceof Error && / failed: 404 /.test(err.message)) return { status: "failed", clips: [], error: "These clips are no longer available from HeyGen; cut them again" };
      throw err;
    }
    const clips = (job.clips ?? []).map((c) =>
      stripEmpty({
        id: c.id,
        status: c.status === "completed" ? ("completed" as const) : c.status === "failed" ? ("failed" as const) : ("pending" as const),
        title: c.title ?? undefined,
        durationSec: c.duration_seconds ?? undefined,
        viralityScore: c.virality_score ?? undefined,
        // Only https links are kept, as the page plays and links them.
        thumbnailUrl: httpsOnly(c.thumbnail_url),
        videoUrl: httpsOnly(c.video_url),
      }),
    );
    if (job.status === "completed") return { status: "completed", progress: 100, clips };
    if (job.status === "failed" || job.status === "cancelled") return { status: "failed", clips, error: job.failure_message || (job.status === "cancelled" ? "The clipping job was cancelled" : "HeyGen could not clip that video") };
    return { status: "processing", progress: typeof job.progress === "number" ? job.progress : undefined, clips };
  }

  /** A recording with its filler words ("um", "uh") and overlong silences cut out (v3 filler word removal), one cleaned cut back. */
  async startCleanup({ videoUrl, title, key }: { videoUrl: string; title: string; key: string }) {
    try {
      return { jobId: await this.client.createFillerRemoval({ video: { type: "url", url: videoUrl }, title }, key) };
    } catch (err) {
      // A recording HeyGen will not clean (no speech, unreadable, too long, or past the plan) is the account's to change.
      const message = err instanceof Error ? err.message : "";
      if (/ failed: (400|402|422) /.test(message) || message.startsWith("HeyGen error:")) throw new ValidationError(`HeyGen could not clean that recording: ${heygenReason(message, "check that the recording has speech and is at most two hours long")}`);
      throw err;
    }
  }

  async cleanupStatus(jobId: string): Promise<CleanupStatus> {
    let job;
    try {
      job = await this.client.fillerRemoval(jobId);
    } catch (err) {
      if (err instanceof Error && / failed: 404 /.test(err.message)) return { status: "failed", error: "This cleaned recording is no longer available from HeyGen; clean it again" };
      throw err;
    }
    if (job.status === "failed") return { status: "failed", error: job.failure_message || "HeyGen could not clean that recording" };
    if (job.status !== "completed") return { status: "processing", ...(typeof job.progress === "number" ? { progress: job.progress } : {}) };
    const videoUrl = httpsOnly(job.video_url);
    if (!videoUrl) return { status: "failed", error: "HeyGen finished without a cleaned video" };
    return stripEmpty({
      status: "completed" as const,
      progress: 100,
      videoUrl,
      thumbnailUrl: httpsOnly(job.thumbnail_url),
      originalSec: job.original_duration ?? undefined,
      outputSec: job.output_duration ?? undefined,
      cuts: job.num_cuts ?? undefined,
      reductionPct: job.reduction_pct ?? undefined,
    });
  }

  /** The account's API-ready HeyGen Studio templates (made in HeyGen Studio and marked for the API). */
  async listStudioTemplates(): Promise<StudioTemplate[]> {
    return (await this.client.listTemplates()).map((t) => stripEmpty({ id: t.id, name: t.name || "Untitled template", thumbnailUrl: httpsOnly(t.thumbnail_url), aspect: t.aspect_ratio ?? undefined }));
  }

  /** A template's variables in HeyGen's own shape (types this studio does not know are left out) and its scenes. */
  async getStudioTemplate(id: string): Promise<StudioTemplateDetail> {
    let t;
    try {
      t = await this.client.template(id);
    } catch (err) {
      if (err instanceof Error && / failed: (400|404) /.test(err.message)) throw new NotFoundError("Template not found");
      throw err;
    }
    const variables: Record<string, StudioVariable> = {};
    for (const [name, v] of Object.entries(t.variables ?? {})) {
      if (!v || !(STUDIO_VARIABLE_TYPES as readonly string[]).includes(String(v.type))) continue;
      const own = studioVariableOf(v);
      if (own) variables[name] = own;
    }
    return stripEmpty({
      id: t.id,
      name: t.name || "Untitled template",
      thumbnailUrl: httpsOnly(t.thumbnail_url),
      aspect: t.aspect_ratio ?? undefined,
      variables,
      scenes: (t.scenes ?? []).map((sc, i) => ({ id: sc.scene_id ?? `scene_${i + 1}`, script: sc.script ?? "", variables: (sc.variables ?? []).map((v) => v.name ?? "").filter(Boolean) })),
    });
  }

  async getStatus(providerJobId: string): Promise<AvatarJobStatus> {
    const s = await this.client.videoStatus(providerJobId);
    if (s.status === "completed") {
      return { status: "completed", videoUrl: s.video_url, thumbnailUrl: s.thumbnail_url, durationSec: s.duration };
    }
    if (s.status === "failed") return { status: "failed", error: s.failure_message ?? "Render failed" };
    return { status: s.status === "pending" || s.status === "waiting" ? "queued" : "processing" };
  }

  parseWebhook(body: unknown) {
    const b = body as { event_type?: string; event_data?: { video_id?: string; url?: string; msg?: string } };
    const id = b?.event_data?.video_id;
    if (!id) return null;
    if (b.event_type === "avatar_video.success") return { providerJobId: id, update: { status: "completed" as const, videoUrl: b.event_data?.url } };
    if (b.event_type === "avatar_video.fail") return { providerJobId: id, update: { status: "failed" as const, error: b.event_data?.msg ?? "Render failed" } };
    return null;
  }
}

/**
 * A template variable as HeyGen answers it, kept to the fields this studio shows and sends: text `content` (empty when
 * the template leaves it unfilled), a media `asset` given by link or asset id (another form is left out) with its fit and
 * playback, a voice's id and locale, a presenter's look (`avatar_id`, or its former names on older templates).
 */
function studioVariableOf(v: Record<string, unknown>): StudioVariable | null {
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const asset = (a: unknown) => {
    const o = (a ?? {}) as Record<string, unknown>;
    if (o.type === "url" && str(o.url)) return { asset: { type: "url" as const, url: str(o.url) } };
    if (o.type === "asset_id" && str(o.asset_id)) return { asset: { type: "asset_id" as const, asset_id: str(o.asset_id) } };
    return {};
  };
  const fit = ["cover", "contain", "crop", "none"].includes(str(v.fit)) ? { fit: v.fit as "cover" } : {};
  switch (v.type) {
    case "text":
      return { type: "text", content: str(v.content) };
    case "image":
      return { type: "image", ...asset(v.asset), ...fit };
    case "video":
      return { type: "video", ...asset(v.asset), ...fit, ...(str(v.play_style) ? { play_style: str(v.play_style) } : {}), ...(typeof v.volume === "number" ? { volume: v.volume } : {}) };
    case "audio":
      return { type: "audio", ...asset(v.asset) };
    case "voice":
      return { type: "voice", voice_id: str(v.voice_id), ...(str(v.locale) ? { locale: str(v.locale) } : {}) };
    case "character":
      return { type: "character", avatar_id: str(v.avatar_id) || str(v.avatar_look_id) || str(v.character_id) };
    default:
      return null;
  }
}

/** HeyGen's names for the clip framings. */
const CLIP_FRAMES = { "9:16": "portrait", "16:9": "landscape", "1:1": "square" } as const;

function httpsOnly(url: string | null | undefined): string | undefined {
  return url && /^https:\/\//i.test(url) ? url : undefined;
}

/** The object without its undefined fields, so a clip stores only what HeyGen said. */
function stripEmpty<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** The reason in a HeyGen error ("…failed: 400 {"error":{"message":"…"}}" or "HeyGen error: …"), kept short. */
function heygenReason(message: string, fallback = "try describing them differently"): string {
  const body = message.match(/ failed: \d+ (.*)$/s)?.[1];
  if (body) {
    try {
      const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      const reason = typeof json.error === "string" ? json.error : json.error?.message ?? json.message;
      if (reason) return reason.slice(0, 300);
    } catch {
      // Not JSON: fall through to the generic reason.
    }
  }
  if (message.startsWith("HeyGen error:")) return message.slice("HeyGen error:".length).trim().slice(0, 300);
  return fallback;
}

/** A WAV clip of silence (8 kHz, 8-bit mono, about 8 KB a second), for a scene that holds the presenter quiet. */
export function silentWav(seconds: number): Uint8Array {
  const samples = Math.round(seconds * 8000);
  const wav = new Uint8Array(44 + samples);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true); // bytes a second
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  wav.fill(128, 44); // 8-bit PCM is unsigned: 128 is silence
  return wav;
}

/** A colour as HeyGen's v3 takes it, `#rrggbb`: a short `#rgb` is spelled out, anything else is refused plainly. */
function hexColor(value: string): string {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`;
  throw new ValidationError(`HeyGen takes a background colour as #rrggbb; "${value}" is not one.`);
}
