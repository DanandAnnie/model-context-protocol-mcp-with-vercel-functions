// Thin HTTP client for the HeyGen public API (https://docs.heygen.com).
const V1 = "https://api.heygen.com/v1";
const V2 = "https://api.heygen.com/v2";
const V3 = "https://api.heygen.com/v3";

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
      voices: Array<{ voice_id: string; name: string; language?: string; gender?: string; preview_audio?: string; emotion_support?: boolean }>;
    }>(`${V2}/voices`);
  }

  /** Upload a portrait as a talking photo; returns HeyGen's talking_photo_id. */
  async uploadTalkingPhoto(bytes: Uint8Array, mimeType: string): Promise<string> {
    const res = await fetch("https://upload.heygen.com/v1/talking_photo", {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": mimeType },
      body: bytes as BodyInit,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HeyGen talking photo upload failed: ${res.status} ${text}`);
    const json = JSON.parse(text) as { data?: { talking_photo_id?: string }; error?: unknown };
    const id = json.data?.talking_photo_id;
    if (!id) throw new Error(`HeyGen talking photo upload returned no id: ${text}`);
    return id;
  }

  /** Upload an audio file as an asset; returns HeyGen's asset id for `voice.audio_asset_id`. */
  async uploadAsset(bytes: Uint8Array, mimeType: string): Promise<string> {
    const res = await fetch("https://upload.heygen.com/v1/asset", {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": mimeType },
      body: bytes as BodyInit,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HeyGen asset upload failed: ${res.status} ${text}`);
    const json = JSON.parse(text) as { data?: { id?: string }; error?: unknown };
    const id = json.data?.id;
    if (!id) throw new Error(`HeyGen asset upload returned no id: ${text}`);
    return id;
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

  /** Video Translate (v3): one id per output language. */
  createTranslation(body: Record<string, unknown>) {
    return this.request<{ video_translation_ids: string[] }>(`${V3}/video-translations`, { method: "POST", body: JSON.stringify(body) });
  }

  translationStatus(id: string) {
    return this.request<{ status: string; video_url?: string; failure_message?: string; srt_caption_url?: string; vtt_caption_url?: string }>(
      `${V3}/video-translations/${encodeURIComponent(id)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
  }

  /** Proofread (v3): the lines are translated first and dubbed once they are approved; one id per output language. */
  createProofread(body: Record<string, unknown>) {
    return this.request<{ proofread_ids: string[] }>(`${V3}/video-translations/proofreads`, { method: "POST", body: JSON.stringify(body) });
  }

  proofreadStatus(id: string) {
    return this.request<{ status: string; failure_message?: string }>(`${V3}/video-translations/proofreads/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }

  /** A presigned link to the proofread's translated subtitles. */
  proofreadSrt(id: string) {
    return this.request<{ srt_url: string }>(`${V3}/video-translations/proofreads/${encodeURIComponent(id)}/srt`, { signal: AbortSignal.timeout(10_000) });
  }

  /** Replaces the proofread's subtitles with the SRT file at `url`. */
  updateProofreadSrt(id: string, url: string) {
    return this.request<unknown>(`${V3}/video-translations/proofreads/${encodeURIComponent(id)}/srt`, { method: "PUT", body: JSON.stringify({ srt: { type: "url", url } }) });
  }

  /** Dubs the proofread lines; the returned translation is polled like any other. */
  generateProofread(id: string) {
    return this.request<{ video_translation_id: string }>(`${V3}/video-translations/proofreads/${encodeURIComponent(id)}/generate`, { method: "POST", body: JSON.stringify({}) });
  }

  /** Jobs started through the v2 API before the move to v3. */
  translationStatusV2(id: string) {
    return this.request<{ status: string; url?: string; message?: string }>(`${V2}/video_translate/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }

  // ---- Streaming (Interactive Avatar) ----
  // Shapes follow the v1 streaming API (streaming.new / start / task / stop); not exercised in tests.

  /** Opens a LiveKit-backed streaming session for an avatar; returns the room URL and the visitor token. */
  streamingNew(avatarId: string, voiceId?: string, quality: "low" | "medium" | "high" = "medium") {
    return this.request<{ session_id: string; url: string; access_token: string }>(`${V1}/streaming.new`, {
      method: "POST",
      body: JSON.stringify({ version: "v2", quality, avatar_id: avatarId, ...(voiceId ? { voice: { voice_id: voiceId } } : {}) }),
    });
  }

  streamingStart(sessionId: string) {
    return this.request<unknown>(`${V1}/streaming.start`, { method: "POST", body: JSON.stringify({ session_id: sessionId }) });
  }

  /** Makes the avatar say the text verbatim (task_type "repeat"). */
  streamingSpeak(sessionId: string, text: string) {
    return this.request<{ task_id?: string; duration_ms?: number }>(`${V1}/streaming.task`, {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, text, task_type: "repeat" }),
    });
  }

  streamingStop(sessionId: string) {
    return this.request<unknown>(`${V1}/streaming.stop`, { method: "POST", body: JSON.stringify({ session_id: sessionId }) });
  }
}
