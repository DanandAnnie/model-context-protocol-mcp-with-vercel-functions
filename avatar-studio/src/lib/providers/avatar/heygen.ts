import { ASPECT_DIMENSIONS, type Avatar, type VideoRequest, type Voice } from "../../types";
import { webhookUrl } from "../../config";
import { HeyGenClient } from "../heygen-client";
import type { AvatarJobStatus, AvatarProvider } from "../types";

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

  async createVideo(req: VideoRequest, avatar: Avatar, voice: Voice | null) {
    const isPhoto = avatar.tags?.includes("photo avatar") || avatar.source === "custom";
    const character = isPhoto
      ? { type: "talking_photo", talking_photo_id: avatar.id, talking_photo_style: "square" }
      : { type: "avatar", avatar_id: avatar.id, avatar_style: "normal" };
    const body = {
      title: req.title,
      caption: req.captions,
      callback_url: webhookUrl("heygen"),
      dimension: ASPECT_DIMENSIONS[req.aspect],
      video_inputs: [
        {
          character,
          voice: { type: "text", input_text: req.script, voice_id: voice?.id ?? req.voiceId, speed: req.speed },
          background:
            req.background.type === "image"
              ? { type: "image", url: req.background.value }
              : { type: "color", value: req.background.value },
        },
      ],
    };
    const data = await this.client.generateVideo(body);
    return { providerJobId: data.video_id };
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
