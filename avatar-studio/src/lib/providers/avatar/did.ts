import type { Avatar, VideoRequest, Voice } from "../../types";
import { webhookUrl } from "../../config";
import type { AvatarJobStatus, AvatarProvider } from "../types";

const BASE = "https://api.d-id.com";

/**
 * D-ID "talks" provider: animates a still portrait (any custom photo avatar)
 * or a D-ID presenter. Voices are passed through to D-ID's TTS partners.
 */
export class DidAvatarProvider implements AvatarProvider {
  readonly name = "did";
  constructor(private apiKey: string, private ttsProviderName: string) {}

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
    const data = await this.request<{ presenters: Array<{ presenter_id: string; name?: string; thumbnail_url?: string; image_url?: string; gender?: string }> }>(
      "/clips/presenters?limit=50",
    );
    return (data.presenters ?? []).map((p): Avatar => ({
      id: p.presenter_id,
      name: p.name ?? p.presenter_id,
      imageUrl: p.thumbnail_url ?? p.image_url ?? "",
      source: "provider",
      provider: this.name,
      gender: (p.gender?.toLowerCase() as Avatar["gender"]) ?? undefined,
    })).filter((a) => a.imageUrl);
  }

  /** D-ID needs a fetchable image URL; upload data URLs first. */
  private async resolveSourceUrl(avatar: Avatar): Promise<string> {
    if (!avatar.imageUrl.startsWith("data:")) return avatar.imageUrl;
    const [meta, b64] = avatar.imageUrl.split(",");
    const mime = /data:([^;]+)/.exec(meta)?.[1] ?? "image/png";
    const form = new FormData();
    form.append("image", new Blob([Buffer.from(b64, "base64")], { type: mime }), `avatar.${mime.split("/")[1] ?? "png"}`);
    const res = await fetch(`${BASE}/images`, { method: "POST", headers: this.headers(), body: form });
    if (!res.ok) throw new Error(`D-ID image upload failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { url: string };
    return json.url;
  }

  async createVideo(req: VideoRequest, avatar: Avatar, voice: Voice | null) {
    const providerType = this.ttsProviderName === "elevenlabs" ? "elevenlabs" : "microsoft";
    const voiceId = voice?.id ?? (providerType === "microsoft" ? "en-US-JennyNeural" : req.voiceId);
    const body = {
      source_url: await this.resolveSourceUrl(avatar),
      script: { type: "text", input: req.script, provider: { type: providerType, voice_id: voiceId } },
      config: { stitch: true, result_format: "mp4" },
      webhook: webhookUrl("did"),
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
