import type { AudioClip, Avatar, VideoRequest, Voice } from "../../types";
import { hasPauses, toSsml, withBreakTags } from "../../pauses";
import { webhookUrl } from "../../config";
import { loadImage } from "../image";
import type { AvatarJobStatus, AvatarProvider, RenderCast } from "../types";

const BASE = "https://api.d-id.com";

/**
 * D-ID "talks" provider: animates a still portrait (any custom photo avatar)
 * or a D-ID presenter. Voices are passed through to D-ID's TTS partners.
 */
export class DidAvatarProvider implements AvatarProvider {
  readonly name = "did";
  constructor(private apiKey: string) {}

  private headers(extra: Record<string, string> = {}) {
    // D-ID API keys are used as HTTP Basic credentials ("email:key" or a bare key).
    const token = Buffer.from(this.apiKey.includes(":") ? this.apiKey : `${this.apiKey}:`).toString("base64");
    return { Authorization: `Basic ${token}`, Accept: "application/json", ...extra };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: this.headers((init.headers as Record<string, string>) ?? {}), cache: "no-store" });
    const text = await res.text();
    if (!res.ok) throw new Error(`D-ID ${init.method ?? "GET"} ${path} failed: ${res.status} ${text}`);
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  async listAvatars(): Promise<Avatar[]> {
    const data = await this.request<{ presenters: Array<{ presenter_id: string; name?: string; thumbnail_url?: string; image_url?: string; preview_url?: string; gender?: string }> }>(
      "/clips/presenters?limit=50",
    );
    return (data.presenters ?? []).map((p): Avatar => ({
      id: p.presenter_id,
      name: p.name ?? p.presenter_id,
      imageUrl: p.thumbnail_url ?? p.image_url ?? "",
      ...(p.preview_url ? { previewVideoUrl: p.preview_url } : {}),
      source: "provider",
      provider: this.name,
      gender: (p.gender?.toLowerCase() as Avatar["gender"]) ?? undefined,
    })).filter((a) => a.imageUrl);
  }

  /** D-ID needs a fetchable image URL; upload custom portraits once and remember the hosted URL. */
  async prepareAvatar(avatar: Avatar): Promise<Avatar> {
    if (avatar.source !== "custom" || avatar.providerAssetIds?.[this.name]) return avatar;
    const { bytes, mimeType } = await loadImage(avatar.imageUrl);
    const form = new FormData();
    form.append("image", new Blob([bytes as BlobPart], { type: mimeType }), `avatar.${mimeType.split("/")[1] ?? "png"}`);
    const res = await fetch(`${BASE}/images`, { method: "POST", headers: this.headers(), body: form });
    if (!res.ok) throw new Error(`D-ID image upload failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { url: string };
    return { ...avatar, providerAssetIds: { ...avatar.providerAssetIds, [this.name]: json.url } };
  }

  /**
   * A text script for a talk. Pauses go to Microsoft voices as SSML breaks (the rest of the text escaped)
   * and to ElevenLabs voices as break tags in the text, which both engines honour.
   */
  private textScript(script: string, voice: Voice | null) {
    const provider = this.resolveVoice(voice);
    if (!hasPauses(script)) return { type: "text", input: script, provider };
    if (provider.type === "microsoft") return { type: "text", input: toSsml(script), ssml: true, provider };
    return { type: "text", input: withBreakTags(script), provider };
  }

  /** Demo voices are not D-ID voices; map them to Microsoft neural voices by gender. */
  private resolveVoice(voice: Voice | null): { type: string; voice_id: string } {
    if (voice?.provider === "elevenlabs") return { type: "elevenlabs", voice_id: voice.id };
    const female = (voice?.gender ?? "female") !== "male";
    return { type: "microsoft", voice_id: female ? "en-US-JennyNeural" : "en-US-GuyNeural" };
  }

  /** D-ID speaks audio from a URL it hosts; upload the clip once and remember that URL. */
  async prepareAudio(clip: AudioClip, audio: { bytes: Uint8Array; mimeType: string }): Promise<AudioClip> {
    if (clip.providerAssetIds?.[this.name]) return clip;
    const form = new FormData();
    form.append("audio", new Blob([audio.bytes as BlobPart], { type: audio.mimeType }), audio.mimeType === "audio/mpeg" ? "clip.mp3" : "clip.wav");
    const res = await fetch(`${BASE}/audios`, { method: "POST", headers: this.headers(), body: form });
    if (!res.ok) throw new Error(`D-ID audio upload failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { url: string };
    return { ...clip, providerAssetIds: { ...clip.providerAssetIds, [this.name]: json.url } };
  }

  async createVideo(req: VideoRequest, avatar: Avatar, voice: Voice | null, cast?: RenderCast) {
    // A D-ID talk has one presenter and one voice; a scene asking for another cannot be honoured.
    const other = req.scenes?.find((sc) => (sc.avatarId && sc.avatarId !== req.avatarId) || (sc.voiceId && sc.voiceId !== req.voiceId));
    if (other) throw new Error("D-ID renders one presenter and one voice per video; remove the per-scene presenter or switch to HeyGen.");
    // One talk speaks either text or one audio file, so recorded audio needs a video of a single scene.
    const audioScene = req.scenes?.find((sc) => sc.audioId);
    if (audioScene && (req.scenes?.length ?? 0) > 1) throw new Error("D-ID renders one clip per video; use recorded audio in a single-scene video or switch to HeyGen.");
    const audioUrl = audioScene?.audioId ? cast?.clips?.[audioScene.audioId]?.providerAssetIds?.[this.name] : undefined;
    if (audioScene && !audioUrl) throw new Error("The audio clip has not been uploaded to D-ID yet.");
    const sourceUrl = avatar.source === "custom" ? avatar.providerAssetIds?.[this.name] : avatar.imageUrl;
    if (!sourceUrl) throw new Error("Custom avatar has not been uploaded to D-ID yet.");
    const body = {
      source_url: sourceUrl,
      script: audioUrl ? { type: "audio", audio_url: audioUrl } : this.textScript(req.script, voice),
      config: { stitch: true, result_format: "mp4" },
      ...(webhookUrl("did") ? { webhook: webhookUrl("did") } : {}),
      name: req.title,
    };
    const data = await this.request<{ id: string }>("/talks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { providerJobId: data.id };
  }

  async getStatus(providerJobId: string): Promise<AvatarJobStatus> {
    const t = await this.request<{ status: string; result_url?: string; duration?: number; error?: { description?: string } }>(
      `/talks/${encodeURIComponent(providerJobId)}`,
    );
    if (t.status === "done") return { status: "completed", videoUrl: t.result_url, durationSec: t.duration };
    if (t.status === "error" || t.status === "rejected") return { status: "failed", error: t.error?.description ?? `D-ID status ${t.status}` };
    return { status: t.status === "created" ? "queued" : "processing" };
  }

  parseWebhook(body: unknown) {
    const b = body as { id?: string; status?: string; result_url?: string; error?: { description?: string } };
    if (!b?.id) return null;
    if (b.status === "done") return { providerJobId: b.id, update: { status: "completed" as const, videoUrl: b.result_url } };
    if (b.status === "error") return { providerJobId: b.id, update: { status: "failed" as const, error: b.error?.description ?? "Render failed" } };
    return null;
  }
}
