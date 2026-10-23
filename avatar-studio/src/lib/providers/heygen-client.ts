// Thin HTTP client for the HeyGen public API (https://docs.heygen.com).
const V1 = "https://api.heygen.com/v1";
const V2 = "https://api.heygen.com/v2";

export class HeyGenClient {
  constructor(private apiKey: string) {}

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        "X-Api-Key": this.apiKey,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HeyGen ${init.method ?? "GET"} ${url} failed: ${res.status} ${text}`);
    const json = JSON.parse(text) as { error?: { message?: string } | string | null; data?: T };
    if (json.error) {
      const msg = typeof json.error === "string" ? json.error : json.error.message ?? "unknown error";
      throw new Error(`HeyGen error: ${msg}`);
    }
    return json.data as T;
  }

  listAvatars() {
    return this.request<{
      avatars: Array<{ avatar_id: string; avatar_name: string; gender?: string; preview_image_url?: string; preview_video_url?: string }>;
      talking_photos?: Array<{ talking_photo_id: string; talking_photo_name: string; preview_image_url?: string }>;
    }>(`${V2}/avatars`);
  }

  listVoices() {
    return this.request<{
      voices: Array<{ voice_id: string; name: string; language?: string; gender?: string; preview_audio?: string }>;
    }>(`${V2}/voices`);
  }

  generateVideo(body: Record<string, unknown>) {
    return this.request<{ video_id: string }>(`${V2}/video/generate`, { method: "POST", body: JSON.stringify(body) });
  }

  videoStatus(videoId: string) {
    return this.request<{
      status: "pending" | "processing" | "completed" | "failed" | "waiting";
      video_url?: string;
      thumbnail_url?: string;
      duration?: number;
      error?: { message?: string } | string | null;
    }>(`${V1}/video_status.get?video_id=${encodeURIComponent(videoId)}`);
  }

  createTranslation(body: Record<string, unknown>) {
    return this.request<{ video_translate_id: string }>(`${V2}/video_translate`, { method: "POST", body: JSON.stringify(body) });
  }

  translationStatus(id: string) {
    return this.request<{ status: string; url?: string; message?: string }>(`${V2}/video_translate/${encodeURIComponent(id)}`);
  }
}
