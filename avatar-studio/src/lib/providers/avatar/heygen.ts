import { SCENE_TEXT_SCALE, SCENE_TEXT_Y, backdropIdOf, dimensionsFor, type AudioClip, type Avatar, type Backdrop, type Background, framingFor, type PresenterFraming, type Scene, type SceneText, type VideoRequest, type Voice } from "../../types";
import { silentSeconds, withBreakTags } from "../../pauses";
import { heygenBurnsCaptions } from "../../captions";
import { webhookUrl } from "../../config";
import { loadImage } from "../image";
import { HeyGenClient } from "../heygen-client";
import type { AvatarJobStatus, AvatarProvider, RenderCast } from "../types";

export class HeyGenAvatarProvider implements AvatarProvider {
  readonly name = "heygen";
  private client: HeyGenClient;
  constructor(apiKey: string) {
    this.client = new HeyGenClient(apiKey);
  }

  async listAvatars(): Promise<Avatar[]> {
    const data = await this.client.listAvatars();
    const avatars: Avatar[] = data.avatars.map((a) => ({
      id: a.avatar_id,
      name: a.avatar_name,
      imageUrl: a.preview_image_url ?? "",
      previewVideoUrl: a.preview_video_url,
      source: "provider",
      provider: this.name,
      gender: (a.gender?.toLowerCase() as Avatar["gender"]) ?? undefined,
    }));
    for (const p of data.talking_photos ?? []) {
      avatars.push({
        id: p.talking_photo_id,
        name: p.talking_photo_name,
        imageUrl: p.preview_image_url ?? "",
        source: "provider",
        provider: this.name,
        tags: ["photo avatar"],
      });
    }
    return avatars.filter((a) => a.imageUrl);
  }

  /** Custom portraits must be uploaded once as a HeyGen talking photo. */
  async prepareAvatar(avatar: Avatar): Promise<Avatar> {
    if (avatar.source !== "custom" || avatar.providerAssetIds?.[this.name]) return avatar;
    const { bytes, mimeType } = await loadImage(avatar.imageUrl);
    const id = await this.client.uploadTalkingPhoto(bytes, mimeType);
    return { ...avatar, providerAssetIds: { ...avatar.providerAssetIds, [this.name]: id } };
  }

  /** A clip is uploaded once as a HeyGen audio asset; scenes then name it by asset id. */
  async prepareAudio(clip: AudioClip, audio: { bytes: Uint8Array; mimeType: string }): Promise<AudioClip> {
    if (clip.providerAssetIds?.[this.name]) return clip;
    const id = await this.client.uploadAsset(audio.bytes, audio.mimeType);
    return { ...clip, providerAssetIds: { ...clip.providerAssetIds, [this.name]: id } };
  }

  /** An uploaded background image is sent once as a HeyGen image asset; scenes then name it by asset id. */
  async prepareBackdrop(backdrop: Backdrop, image: { bytes: Uint8Array; mimeType: string }): Promise<Backdrop> {
    if (backdrop.providerAssetIds?.[this.name]) return backdrop;
    const id = await this.client.uploadAsset(image.bytes, image.mimeType);
    return { ...backdrop, providerAssetIds: { ...backdrop.providerAssetIds, [this.name]: id } };
  }

  async createVideo(req: VideoRequest, avatar: Avatar, voice: Voice | null, cast?: RenderCast) {
    const scenes: Scene[] = req.scenes?.length ? req.scenes : [{ script: req.script, background: req.background }];
    const body = {
      title: req.title,
      // HeyGen burns captions in at its own position and size; a video with a caption style of its
      // own is captioned by the share page's subtitle track instead, so the chosen look is the only one.
      caption: heygenBurnsCaptions(req),
      ...(webhookUrl("heygen") ? { callback_url: webhookUrl("heygen") } : {}),
      dimension: dimensionsFor(req.aspect, req.resolution),
      // One input per scene, each with its own presenter and voice when the scene names them.
      video_inputs: scenes.map((scene) => {
        const sceneAvatar = (scene.avatarId && cast?.avatars[scene.avatarId]) || avatar;
        const sceneVoice = (scene.voiceId && cast?.voices[scene.voiceId]) || voice;
        return {
          // HeyGen places the presenter with a scale (1 = default) and an x/y offset of the frame.
          character: { ...this.character(sceneAvatar, scene.layout?.framing), ...(scene.layout ? { scale: scene.layout.scale, offset: { x: scene.layout.x, y: scene.layout.y } } : {}) },
          // An audio scene lip-syncs to its clip; speed, pitch, and emotion apply to synthesised speech only.
          // An emotion goes to voices that can take one: HeyGen says per voice, and one it says nothing about is sent it.
          // A scene of only pauses holds the presenter silent for that long.
          voice: scene.audioId
            ? { type: "audio", audio_asset_id: this.audioAssetId(scene.audioId, cast) }
            : silentSeconds(scene.script)
              ? { type: "silence", duration: Math.max(1, silentSeconds(scene.script)) }
              : { type: "text", input_text: withBreakTags(scene.script), voice_id: this.voiceId(sceneVoice, req.voiceId), speed: scene.speed ?? req.speed, ...(req.pitch ? { pitch: req.pitch } : {}), ...(req.emotion && sceneVoice?.emotionSupport !== false ? { emotion: req.emotion } : {}) },
          // A video background loops for the length of the scene, filling the frame unless the scene shows all of it.
          // On-screen text sits over the scene for its whole length.
          ...(scene.overlay ? { text: sceneText(scene.overlay, dimensionsFor(req.aspect, req.resolution)) } : {}),
          background:
            scene.background.type === "video"
              ? { type: "video", url: scene.background.value, play_style: "loop", fit: scene.background.fit ?? "cover" }
              : scene.background.type === "image"
                ? this.imageBackground(scene.background, cast)
                : { type: "color", value: scene.background.value },
        };
      }),
    };
    const data = await this.client.generateVideo(body);
    return { providerJobId: data.video_id };
  }

  /** HeyGen's character for a presenter, in the scene's framing; a talking photo has a square or a circle only, so a close-up keeps its square. */
  private character(avatar: Avatar, framing?: PresenterFraming) {
    const photoId = avatar.source === "custom" ? avatar.providerAssetIds?.[this.name] : avatar.tags?.includes("photo avatar") ? avatar.id : undefined;
    if (avatar.source === "custom" && !photoId) throw new Error(`Custom avatar "${avatar.name}" has not been uploaded to HeyGen yet.`);
    return photoId
      ? { type: "talking_photo", talking_photo_id: photoId, talking_photo_style: framingFor(framing, avatar) === "circle" ? "circle" : "square" }
      : { type: "avatar", avatar_id: avatar.id, avatar_style: framing === "closeUp" ? "closeUp" : framing === "circle" ? "circle" : "normal" };
  }

  /** An image background by URL, or an uploaded one by its HeyGen asset id. */
  private imageBackground(background: Background, cast?: RenderCast) {
    const backdropId = backdropIdOf(background);
    // Sent either way, so the render matches the stage preview whatever HeyGen's own default is.
    const fit = { fit: background.fit ?? "cover" };
    if (!backdropId) return { type: "image", url: background.value, ...fit };
    const id = cast?.backdrops?.[backdropId]?.providerAssetIds?.[this.name];
    if (!id) throw new Error(`Background image ${backdropId} has not been uploaded to HeyGen yet.`);
    return { type: "image", image_asset_id: id, ...fit };
  }

  private audioAssetId(audioId: string, cast?: RenderCast): string {
    const id = cast?.clips?.[audioId]?.providerAssetIds?.[this.name];
    if (!id) throw new Error(`Audio clip ${audioId} has not been uploaded to HeyGen yet.`);
    return id;
  }

  private voiceId(voice: Voice | null, fallback: string): string {
    if (voice && voice.provider !== this.name) {
      throw new Error(`HeyGen renders need a HeyGen voice; "${voice.name}" comes from ${voice.provider}.`);
    }
    return voice?.id ?? fallback;
  }

  async getStatus(providerJobId: string): Promise<AvatarJobStatus> {
    const s = await this.client.videoStatus(providerJobId);
    if (s.status === "completed") {
      return { status: "completed", videoUrl: s.video_url, thumbnailUrl: s.thumbnail_url, durationSec: s.duration };
    }
    if (s.status === "failed") {
      const msg = typeof s.error === "string" ? s.error : s.error?.message;
      return { status: "failed", error: msg ?? "Render failed" };
    }
    return { status: s.status === "waiting" || s.status === "pending" ? "queued" : "processing" };
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

/** HeyGen's text element for a scene's on-screen text: bold, centred across the frame, in pixels of the output. */
export function sceneText(overlay: SceneText, frame: { width: number; height: number }) {
  return {
    type: "text",
    text: overlay.text,
    font_family: "Arial",
    font_size: Math.round(Math.min(frame.width, frame.height) * SCENE_TEXT_SCALE[overlay.size ?? "medium"]),
    font_weight: "bold",
    color: overlay.color ?? "#ffffff",
    position: { x: Math.round(frame.width / 2), y: Math.round(frame.height * SCENE_TEXT_Y[overlay.position ?? "top"]) },
    text_align: "center",
    line_height: 1.2,
  };
}
