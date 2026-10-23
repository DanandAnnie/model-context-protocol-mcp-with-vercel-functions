import { dimensionsFor, type Avatar, type VideoRequest, type Voice } from "../../types";
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

  async createVideo(req: VideoRequest, avatar: Avatar, voice: Voice | null, cast?: RenderCast) {
    const scenes = req.scenes?.length ? req.scenes : [{ script: req.script, background: req.background }];
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
          character: { ...this.character(sceneAvatar), ...(scene.layout ? { scale: scene.layout.scale, offset: { x: scene.layout.x, y: scene.layout.y } } : {}) },
          voice: { type: "text", input_text: scene.script, voice_id: this.voiceId(sceneVoice, req.voiceId), speed: req.speed },
          // A video background loops for the length of the scene and fills the frame.
          background:
            scene.background.type === "video"
              ? { type: "video", url: scene.background.value, play_style: "loop", fit: "cover" }
              : scene.background.type === "image"
                ? { type: "image", url: scene.background.value }
                : { type: "color", value: scene.background.value },
        };
      }),
    };
    const data = await this.client.generateVideo(body);
    return { providerJobId: data.video_id };
  }

  private character(avatar: Avatar) {
    const photoId = avatar.source === "custom" ? avatar.providerAssetIds?.[this.name] : avatar.tags?.includes("photo avatar") ? avatar.id : undefined;
    if (avatar.source === "custom" && !photoId) throw new Error(`Custom avatar "${avatar.name}" has not been uploaded to HeyGen yet.`);
    return photoId
      ? { type: "talking_photo", talking_photo_id: photoId, talking_photo_style: "square" }
      : { type: "avatar", avatar_id: avatar.id, avatar_style: "normal" };
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
