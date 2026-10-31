// Thin HTTP client for the HeyGen public API (https://docs.heygen.com).
/**
 * The mark the studio puts at the end of the name of every voice it clones in HeyGen's account (` ·st_` and a nonce):
 * HeyGen lists the key's clones to every account, so marked ones are never listed (the account that made one keeps its
 * own record of it), even one whose clone answer was lost before the studio could note its id.
 */
export const STUDIO_VOICE_MARK = / ·st_[0-9a-f]{8,}$/;
type VoiceDetail = { language?: string | null; gender?: string | null; preview_audio_url?: string | null; status?: "processing" | "complete" | "failed" | null; failure_message?: string | null };
const V2 = "https://api.heygen.com/v2";
const V3 = "https://api.heygen.com/v3";

/** A file sent inline to a v3 call: HeyGen's base64 asset (`AssetBase64`) names its type and takes no other field. */
export function inlineAsset(file: { data: string; mimeType: string }) {
  return { type: "base64" as const, media_type: file.mimeType, data: file.data };
}

/** Which languages a glossary rule applies in (all when left out). */
export type GlossaryLanguage = { scope: "all" } | { scope: "specific"; code: string };
/** A glossary's rule lists as HeyGen reads and writes them. */
export interface GlossaryLists {
  terms?: Array<{ term: string; pronunciation: string; pronunciation_language?: GlossaryLanguage }> | null;
  do_not_translate_terms?: Array<{ term: string }> | null;
  forced_translations?: Array<{ term: string; translation: string; target_language?: GlossaryLanguage }> | null;
}

export class HeyGenClient {
  constructor(private apiKey: string) {}

  private async request<T>(url: string, init: RequestInit = {}, onHeaders?: (headers: Headers) => void): Promise<T> {
    return (await this.envelope<T>(url, init, onHeaders)).data as T;
  }

  /** The whole answer, for the few calls whose paging cursor sits next to `data`; `onHeaders` sees a success's headers. */
  private async envelope<T>(url: string, init: RequestInit = {}, onHeaders?: (headers: Headers) => void): Promise<{ data?: T } & Record<string, unknown>> {
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
    const json = JSON.parse(text) as { error?: { message?: string } | string | null; data?: T } & Record<string, unknown>;
    if (json.error) {
      const msg = typeof json.error === "string" ? json.error : json.error.message ?? "unknown error";
      throw new Error(`HeyGen error: ${msg}`);
    }
    onHeaders?.(res.headers);
    return json;
  }

  /**
   * Every page of a v3 list (`{ data: [...], has_more, next_token }`, cursor `token`), up to `maxPages` pages so a huge
   * account cannot hold a request open.
   */
  private async listAll<T>(path: string, limit: number, maxPages = 20, pageTimeoutMs?: number): Promise<T[]> {
    const items: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const json = await this.envelope<T[]>(`${V3}${path}${sep}limit=${limit}${token ? `&token=${encodeURIComponent(token)}` : ""}`, pageTimeoutMs ? { signal: AbortSignal.timeout(pageTimeoutMs) } : {});
      items.push(...(Array.isArray(json.data) ? json.data : []));
      token = typeof json.next_token === "string" && json.next_token ? json.next_token : undefined;
      if (!json.has_more || !token) break;
    }
    return items;
  }

  /**
   * Avatar looks (v3): stock and studio avatars, digital twins, and photo avatars alike, each usable as `avatar_id`. The
   * account's own come first and in full; HeyGen's preset library after them, up to the page limit.
   */
  async listAvatarLooks() {
    type Look = {
      id: string;
      name: string;
      avatar_type?: "studio_avatar" | "digital_twin" | "photo_avatar" | string;
      supported_api_engines?: string[];
      preview_image_url?: string;
      preview_video_url?: string;
      gender?: string;
      tags?: string[];
      status?: string;
    };
    const [own, preset] = await Promise.all([this.listAll<Look>("/avatars/looks?ownership=private", 50, 100), this.listAll<Look>("/avatars/looks?ownership=public", 50)]);
    // `own` marks the account's own looks, made with this key, apart from HeyGen's preset library.
    return unique([...own.map((l) => ({ ...l, own: true as const })), ...preset.map((l) => ({ ...l, own: undefined }))], (l) => l.id);
  }

  /**
   * Voices (v3): the account's own (cloned in HeyGen) first, then the shared library; v3 lists only one kind per call.
   * The voices of the account's own digital twins are left out: each is a real person's voice, cloned from their
   * footage for one account here (that account keeps it as its own voice).
   */
  async listVoices() {
    type V = { voice_id: string; name: string; language?: string; gender?: string; preview_audio_url?: string; support_locale?: boolean };
    const [own, shared, twins] = await Promise.all([
      this.listAll<V>("/voices?type=private", 100, 100),
      this.listAll<V>("/voices?type=public", 100),
      this.listAll<{ default_voice_id?: string | null }>("/avatars/looks?ownership=private&avatar_type=digital_twin", 50, 100),
    ]);
    const twinVoices = new Set(twins.map((t) => t.default_voice_id).filter(Boolean));
    return unique([...own.filter((v) => !twinVoices.has(v.voice_id) && !STUDIO_VOICE_MARK.test(v.name)), ...shared], (v) => v.voice_id);
  }

  /** The key's own voices with the studio's mark (the clones it made), to find one whose clone answer was lost. */
  async studioClones(): Promise<Array<{ voice_id: string; name: string }>> {
    return (await this.listAll<{ voice_id: string; name: string }>("/voices?type=private", 100, 100)).filter((v) => STUDIO_VOICE_MARK.test(v.name));
  }

  /**
   * Prompt to avatar (v3): a synthetic presenter drawn from a description, as a look to follow with `getLook`. With
   * `avatarId` (a look of the account's), the description restyles that person instead: their outfit and setting
   * change, the face stays, and the look joins their character. Up to three `references` (base64 pictures, sent with
   * the request so a retry sends the same body) guide the wardrobe or setting; `key` makes a retried start replay the
   * first answer. Read from `data` when the answer is
   * wrapped as the other v3 calls are, else from the answer itself.
   */
  async createPromptAvatar(
    name: string,
    prompt: string,
    opts: { avatarId?: string; aspect?: "4:5" | "16:9" | "9:16"; references?: Array<{ data: string; mimeType: string }>; key?: string } = {},
  ): Promise<{ look_id: string; status?: string }> {
    const out = await this.envelope<{ look_id: string; status?: string }>(`${V3}/avatars`, {
      method: "POST",
      body: JSON.stringify({
        type: "prompt",
        name,
        prompt,
        aspect_ratio: opts.aspect ?? "4:5",
        ...(opts.avatarId ? { avatar_id: opts.avatarId } : {}),
        ...(opts.references?.length ? { reference_images: opts.references.map(inlineAsset) } : {}),
      }),
      ...(opts.key ? { headers: { "Idempotency-Key": opts.key }, signal: AbortSignal.timeout(20_000) } : {}),
    });
    // The look's id is `avatar_item.id` in the v3 schema; `look_id` is read too, as some answers carry it.
    const data = (out.data ?? out) as { look_id?: string; status?: string; avatar_item?: { id?: string; status?: string } };
    const id = data.avatar_item?.id ?? data.look_id;
    if (!id) throw new Error("HeyGen returned no look id for the drawn presenter");
    return { look_id: id, status: data.avatar_item?.status ?? data.status };
  }

  async getLook(lookId: string): Promise<{ status?: string; preview_image_url?: string; error?: { code?: string; message?: string } | null }> {
    const out = await this.envelope<{ status?: string; preview_image_url?: string; error?: { code?: string; message?: string } | null }>(`${V3}/avatars/looks/${encodeURIComponent(lookId)}`);
    return (out.data ?? out) as { status?: string; preview_image_url?: string; error?: { code?: string; message?: string } | null };
  }

  /**
   * Upload a file as an asset (v3, multipart with a `file` field); returns its `asset_id`, used for photo avatars,
   * scene backgrounds, and audio. Asset ids do not expire.
   */
  async uploadAsset(bytes: Uint8Array, mimeType: string, filename = "upload"): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: mimeType }), filename);
    // Bounded, so a stuck upload cannot hold a request open past the platform's limit.
    const res = await fetch(`${V3}/assets`, { method: "POST", headers: { "X-Api-Key": this.apiKey }, body: form, cache: "no-store", signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HeyGen asset upload failed: ${res.status} ${text}`);
    const json = JSON.parse(text) as { data?: { asset_id?: string } };
    const id = json.data?.asset_id;
    if (!id) throw new Error(`HeyGen asset upload returned no id: ${text}`);
    return id;
  }

  /**
   * A digital twin trained from footage (`POST /v3/avatars`, `type: "digital_twin"`): its look, the new character it
   * belongs to, and the voice cloned from the footage. `key` makes a retried start replay the first answer.
   */
  async createDigitalTwin(name: string, footageUrl: string, key: string): Promise<{ lookId: string; groupId: string; voiceId?: string }> {
    const out = await this.request<{ avatar_item?: { id?: string; default_voice_id?: string | null }; avatar_group?: { id?: string } }>(`${V3}/avatars`, {
      method: "POST",
      body: JSON.stringify({ type: "digital_twin", name, file: { type: "url", url: footageUrl } }),
      headers: { "Idempotency-Key": key },
      signal: AbortSignal.timeout(25_000),
    });
    const lookId = out?.avatar_item?.id;
    const groupId = out?.avatar_group?.id;
    if (!lookId || !groupId) throw new Error("HeyGen returned no look or character for the digital twin");
    return { lookId, groupId, ...(out.avatar_item?.default_voice_id ? { voiceId: out.avatar_item.default_voice_id } : {}) };
  }

  /** Starts the consent flow for a character (`POST /v3/avatars/{group_id}/consent`): a page for the person, for a day. */
  async createConsent(groupId: string, key: string): Promise<{ url?: string; consentStatus?: string | null }> {
    const out = await this.request<{ url?: string; avatar_group?: { consent_status?: string | null } }>(`${V3}/avatars/${encodeURIComponent(groupId)}/consent`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Idempotency-Key": key },
    });
    return { url: out?.url, consentStatus: out?.avatar_group?.consent_status };
  }

  /**
   * One voice (`GET /v3/voices/{voice_id}`): its language, gender, and preview once HeyGen has finished it, and for a
   * clone where it stands (`processing`, `complete`, or `failed` with `failure_message`).
   */
  async getVoice(voiceId: string): Promise<VoiceDetail> {
    const out = await this.envelope<VoiceDetail>(`${V3}/voices/${encodeURIComponent(voiceId)}`);
    return (out.data ?? out) as VoiceDetail;
  }

  /**
   * Clones a voice from one recording already uploaded as an asset (`POST /v3/voices/clone`), background noise removed;
   * returns its id, usable as a video's `voice_id` once `getVoice` says it is complete.
   */
  async cloneVoice(name: string, assetId: string, language?: string): Promise<string> {
    const out = await this.request<{ voice_clone_id?: string }>(`${V3}/voices/clone`, {
      method: "POST",
      body: JSON.stringify({ voice_name: name, audio: { type: "asset_id", asset_id: assetId }, ...(language ? { language } : {}), remove_background_noise: true }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!out?.voice_clone_id) throw new Error("HeyGen returned no id for the cloned voice");
    return out.voice_clone_id;
  }

  /** Deletes a cloned voice (`DELETE /v3/voices/{voice_id}`); HeyGen answers 404 for one it no longer has. */
  async deleteVoice(voiceId: string): Promise<void> {
    await this.request(`${V3}/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
  }

  /** A character (`GET /v3/avatars/{group_id}`): its consent status, and why it failed when it did. */
  avatarGroup(groupId: string) {
    return this.request<{ consent_status?: string | null; status?: string | null; error?: { code?: string; message?: string } | null }>(`${V3}/avatars/${encodeURIComponent(groupId)}`);
  }

  /** A photo avatar (v3) from an uploaded image asset; returns its look id. HeyGen prepares it before it can render. */
  async createPhotoAvatar(name: string, assetId: string): Promise<{ id: string; status?: string }> {
    const out = await this.request<{ avatar_item?: { id?: string; status?: string } }>(`${V3}/avatars`, {
      method: "POST",
      body: JSON.stringify({ type: "photo", name, file: { type: "asset_id", asset_id: assetId } }),
    });
    const id = out?.avatar_item?.id;
    if (!id) throw new Error("HeyGen returned no look id for the photo avatar");
    return { id, status: out.avatar_item?.status };
  }

  /** Starts cutting a video into short highlight clips (v3 AI Clipping, `POST /v3/ai-clipping`). */
  async createClipping(body: Record<string, unknown>): Promise<string> {
    const out = await this.request<{ ai_clipping_id?: string }>(`${V3}/ai-clipping`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!out?.ai_clipping_id) throw new Error("HeyGen returned no clipping job id");
    return out.ai_clipping_id;
  }

  /** A clipping job and the clips made so far (`GET /v3/ai-clipping/{id}`). */
  clipping(id: string) {
    return this.request<{
      status: "pending" | "running" | "completed" | "failed" | "cancelled" | string;
      progress?: number;
      failure_message?: string | null;
      clips?: Array<{ id: string; status?: string; title?: string | null; duration_seconds?: number | null; virality_score?: number | null; thumbnail_url?: string | null; video_url?: string | null }>;
    }>(`${V3}/ai-clipping/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }

  /** Starts cleaning filler words and long silences out of a video (v3, `POST /v3/filler-word-removals`); `key` makes a retry return the same job. */
  async createFillerRemoval(body: Record<string, unknown>, key: string): Promise<string> {
    const out = await this.request<{ filler_word_removal_id?: string }>(`${V3}/filler-word-removals`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(20_000) });
    if (!out?.filler_word_removal_id) throw new Error("HeyGen returned no filler removal job id");
    return out.filler_word_removal_id;
  }

  /** A filler removal job and, once done, the cleaned video (`GET /v3/filler-word-removals/{id}`). */
  fillerRemoval(id: string) {
    return this.request<{
      status: "pending" | "running" | "completed" | "failed" | string;
      progress?: number;
      video_url?: string | null;
      thumbnail_url?: string | null;
      original_duration?: number | null;
      output_duration?: number | null;
      num_cuts?: number | null;
      reduction_pct?: number | null;
      failure_message?: string | null;
    }>(`${V3}/filler-word-removals/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }

  /**
   * New looks for a look the account owns (`POST /v3/avatars/looks`), from a Look Pack or a single look template; `key`
   * makes a retried start replay the first answer. Returns one id per look being generated.
   */
  async createLooks(body: Record<string, unknown>, key: string): Promise<string[]> {
    const out = await this.request<{ group_id?: string; looks?: Array<{ id?: string }> }>(`${V3}/avatars/looks`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(20_000) });
    const ids = (out?.looks ?? []).map((l) => l.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (!ids.length) throw new Error("HeyGen returned no looks for the look pack");
    return ids;
  }

  /**
   * Starts generating a clip with HeyGen Video (`POST /v3/models/videos`, model `heygen-video-1`); `key` makes a retried
   * start return the first answer for a day.
   */
  async createModelVideo(body: Record<string, unknown>, key: string): Promise<string> {
    const out = await this.request<{ video_id?: string }>(`${V3}/models/videos`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(30_000) });
    if (!out?.video_id) throw new Error("HeyGen returned no video id for the clip");
    return out.video_id;
  }

  /** Where a HeyGen Video clip stands (`GET /v3/models/videos/:id`), with a freshly signed link once it is done. */
  async modelVideo(id: string) {
    return this.request<{
      status?: "pending" | "processing" | "completed" | "failed" | "cancelled";
      video_url?: string | null;
      duration?: number | null;
      width?: number | null;
      height?: number | null;
      seed?: number | null;
      failure_code?: string | null;
      failure_message?: string | null;
    }>(`${V3}/models/videos/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }

  /**
   * Starts a photo shoot with HeyGen Image (`POST /v3/models/images`, model `heygen-image-1`); `key` makes a retried
   * start resume or return the first job.
   */
  async createModelImage(body: Record<string, unknown>, key: string): Promise<string> {
    const out = await this.request<{ generation_id?: string }>(`${V3}/models/images`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(30_000) });
    if (!out?.generation_id) throw new Error("HeyGen returned no generation id for the photo shoot");
    return out.generation_id;
  }

  /** Where a HeyGen Image shoot stands (`GET /v3/models/images/:id`), with freshly signed links once every photo is ready. */
  async modelImage(id: string) {
    return this.request<{
      status?: "pending" | "completed" | "failed" | "cancelled";
      images?: Array<{ image_id?: string; image_url?: string | null; width?: number | null; height?: number | null; seed?: number | null }> | null;
      failure_code?: string | null;
      failure_message?: string | null;
    }>(`${V3}/models/images/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }

  /** Starts a lip sync (`POST /v3/lipsyncs`); `key` makes a retried start return the same job. */
  async createLipsync(body: Record<string, unknown>, key: string): Promise<string> {
    const out = await this.request<{ lipsync_id?: string }>(`${V3}/lipsyncs`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(20_000) });
    if (!out?.lipsync_id) throw new Error("HeyGen returned no lip sync job id");
    return out.lipsync_id;
  }

  /**
   * Background music or sound effects matching a description (`GET /v3/audio/sounds`, `type=music` or
   * `type=sound_effects`), best first; each track's `audio_url` is signed for a short time.
   */
  async searchMusic(query: string, limit = 12, type: "music" | "sound_effects" = "music"): Promise<Array<{ id: string; name: string; description?: string | null; audio_url?: string | null; duration?: number | null }>> {
    const json = await this.envelope<Array<{ id: string; name: string; description?: string | null; audio_url?: string | null; duration?: number | null }>>(
      `${V3}/audio/sounds?query=${encodeURIComponent(query)}&limit=${limit}&type=${type}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    return Array.isArray(json.data) ? json.data : [];
  }

  /** Starts a HyperFrames render (`POST /v3/hyperframes/renders`) of a project zip; `key` replays a retried start. */
  async createHyperframesRender(body: Record<string, unknown>, key: string): Promise<string> {
    const out = await this.request<{ render_id?: string }>(`${V3}/hyperframes/renders`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(20_000) });
    if (!out?.render_id) throw new Error("HeyGen returned no render id");
    return out.render_id;
  }

  /** A HyperFrames render and, once done, its video (`GET /v3/hyperframes/renders/{id}`). */
  hyperframesRender(id: string) {
    return this.request<{ status: "queued" | "rendering" | "completed" | "failed" | string; video_url?: string | null; duration?: number | null; failure_message?: string | null }>(`${V3}/hyperframes/renders/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** Starts an instant voice from one recording (`POST /v3/models/audio/voices`, `mode: "instant"`); `key` replays a retried start. */
  async createInstantVoice(body: Record<string, unknown>, key: string): Promise<string> {
    const out = await this.request<{ voice_id?: string }>(`${V3}/models/audio/voices`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(20_000) });
    if (!out?.voice_id) throw new Error("HeyGen returned no voice id");
    return out.voice_id;
  }

  /** An instant voice and where it stands (`GET /v3/models/audio/voices/{id}`). */
  instantVoice(id: string) {
    return this.request<{ status?: "PENDING" | "ACTIVE" | "FAILED" | string; failure_reason?: string | null; language?: string | null; preview_audio_url?: string | null }>(`${V3}/models/audio/voices/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** HeyGen Voice's public voices (`GET /v3/models/audio/voices?type=public`), every page up to `maxPages` of 100. */
  publicModelVoices(maxPages = 5) {
    return this.listAll<{ voice_id?: string; name?: string; mode?: string; status?: string; language?: string | null; preview_audio_url?: string | null }>("/models/audio/voices?type=public", 100, maxPages, 8_000);
  }

  /** Deletes an instant voice (`DELETE /v3/models/audio/voices/{id}`). */
  async deleteInstantVoice(id: string): Promise<void> {
    await this.request(`${V3}/models/audio/voices/${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
  }

  /**
   * Speaks a recording again in an instant voice (`POST /v3/models/audio/sts`), waiting at most `waitMs` for the answer.
   * With the same key and body, HeyGen returns a conversion already made without charging again.
   */
  speechToSpeech(body: Record<string, unknown>, key: string, waitMs: number) {
    return this.request<{ audio_url?: string | null; duration?: number | null }>(`${V3}/models/audio/sts`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(waitMs) });
  }

  /**
   * Text spoken in a HeyGen Voice (`POST /v3/models/audio/tts`): one file (a WAV, or the `output_format` asked for), waited for; with `with_timestamps`, the time
   * of each word and character of the text as sent.
   */
  textToSpeech(body: Record<string, unknown>, key: string, waitMs: number) {
    type Timed = Array<{ text?: unknown; start_time?: unknown; end_time?: unknown }> | null;
    type Spoken = { audio_url?: string | null; duration?: number | null; original_words?: Timed; original_characters?: Timed };
    // The language HeyGen spoke the text in (the one asked for, or the one it detected) comes as `Content-Language`.
    let language: string | null = null;
    return this.request<Spoken>(`${V3}/models/audio/tts`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(waitMs) }, (h) => (language = h.get("content-language"))).then((data) => ({ ...data, content_language: language }));
  }


  /** Deletes a HyperFrames render and its video (`DELETE /v3/hyperframes/renders/{id}`). */
  async deleteHyperframesRender(id: string): Promise<void> {
    await this.request(`${V3}/hyperframes/renders/${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
  }

  /** A lip sync and, once done, its video (`GET /v3/lipsyncs/{id}`). */
  lipsync(id: string) {
    return this.request<{
      status: "pending" | "running" | "completed" | "failed" | string;
      duration?: number | null;
      video_url?: string | null;
      failure_message?: string | null;
    }>(`${V3}/lipsyncs/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }

  /** The account's API-ready Studio templates (`GET /v3/templates`; its page sits inside `data`), up to five pages. */
  async listTemplates() {
    type Row = { id: string; name?: string; thumbnail_url?: string | null; aspect_ratio?: string | null };
    const out: Row[] = [];
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const data = await this.request<{ templates?: Row[]; has_more?: boolean; next_token?: string | null }>(`${V3}/templates?limit=100${token ? `&token=${encodeURIComponent(token)}` : ""}`, { signal: AbortSignal.timeout(10_000) });
      out.push(...(data?.templates ?? []));
      token = data?.has_more && data.next_token ? data.next_token : undefined;
      if (!token) break;
    }
    return out;
  }

  /** A template's variables (with their current defaults) and scenes (`GET /v3/templates/{id}`). */
  template(id: string) {
    return this.request<{
      id: string;
      name?: string;
      aspect_ratio?: string | null;
      thumbnail_url?: string | null;
      variables?: Record<string, Record<string, unknown> & { type?: string }>;
      scenes?: Array<{ scene_id?: string; script?: string | null; variables?: Array<{ name?: string }> }>;
    }>(`${V3}/templates/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }

  /** Renders a video from a template with its variables replaced (`POST /v3/templates/{id}`). */
  generateFromTemplate(id: string, body: Record<string, unknown>, key?: string) {
    return this.request<{ video_id: string }>(`${V3}/templates/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body), ...(key ? { headers: { "Idempotency-Key": key } } : {}) });
  }

  /** A video (v3, `POST /v3/videos`); a studio request composes its scenes into one render. */
  generateVideo(body: Record<string, unknown>, key?: string) {
    return this.request<{ video_id: string; status?: string }>(`${V3}/videos`, { method: "POST", body: JSON.stringify(body), ...(key ? { headers: { "Idempotency-Key": key } } : {}) });
  }

  /** HeyGen's Video Agent, one-shot (v3 `POST /v3/video-agents`, `mode: "generate"`): it writes, casts, and renders. */
  createVideoAgent(body: Record<string, unknown>) {
    return this.request<{ session_id?: string; status?: string; video_id?: string | null }>(`${V3}/video-agents`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  }

  /** The curated styles the Video Agent composes in (`GET /v3/video-agents/styles`), every page up to a few. */
  listAgentStyles() {
    type Style = { style_id?: string; name?: string; thumbnail_url?: string | null; preview_video_url?: string | null; tags?: string[] | null; aspect_ratio?: string | null };
    return this.listAll<Style>("/video-agents/styles", 100, 5);
  }

  /** A video's scenes as its editor document holds them (`GET /v3/videos/{id}/scenes`), with the document's edit version. */
  videoScenes(videoId: string) {
    type ScriptItem = { type?: string; text?: string | null };
    return this.request<{ video_id?: string; edit_version?: string; scenes?: Array<{ id?: string; script?: ScriptItem[] | null }> }>(`${V3}/videos/${encodeURIComponent(videoId)}/scenes`, { signal: AbortSignal.timeout(15_000) });
  }

  /** A turn of a Video Agent session (`POST /v3/video-agents/{session_id}`): here, a scene `edit_plan`; it answers with the new draft. */
  sendVideoAgent(sessionId: string, body: Record<string, unknown>) {
    return this.request<{ session_id?: string; video_id?: string | null }>(`${V3}/video-agents/${encodeURIComponent(sessionId)}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  }

  /** A Video Agent session: its status, its latest messages (newest first), and the video it renders once it has one. */
  videoAgentStatus(sessionId: string) {
    type Message = { role?: string; content?: string | null; type?: string; created_at?: number | null; resource_ids?: string[] | null };
    return this.request<{ session_id?: string; status?: string; progress?: number; video_id?: string | null; failure_message?: string | null; error?: string | null; messages?: Message[] | null }>(`${V3}/video-agents/${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(10_000) });
  }

  /** A resource a Video Agent message refers to: a storyboard image, a draft, a chosen avatar or voice. */
  videoAgentResource(sessionId: string, resourceId: string) {
    return this.request<{ resource_id?: string; resource_type?: string; url?: string | null; thumbnail_url?: string | null; preview_url?: string | null }>(`${V3}/video-agents/${encodeURIComponent(sessionId)}/resources/${encodeURIComponent(resourceId)}`, { signal: AbortSignal.timeout(10_000) });
  }

  videoStatus(videoId: string) {
    return this.request<{
      status: "pending" | "processing" | "completed" | "failed" | string;
      video_url?: string;
      thumbnail_url?: string;
      gif_url?: string | null;
      duration?: number;
      failure_code?: string;
      failure_message?: string;
      // Bounded: a webhook's answer waits on it too (a directed video's render, checked as its agent names it).
    }>(`${V3}/videos/${encodeURIComponent(videoId)}`, { signal: AbortSignal.timeout(10_000) });
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

  /**
   * The workspace's brand glossary (v3; one per workspace since October 2026, so a second create is a 409): rules
   * every video and translation that names it follows. `key` makes a retried create return the same glossary.
   */
  createGlossary(body: { name: string } & GlossaryLists, key: string) {
    return this.request<{ id?: string; brand_glossary_id?: string }>(`${V3}/brand-glossaries`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(10_000) });
  }

  /** A glossary with its full rule lists (`GET /v3/brand-glossaries/{id}`). */
  getGlossary(id: string) {
    return this.request<GlossaryLists & { id?: string; brand_glossary_id?: string; name?: string }>(`${V3}/brand-glossaries/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }

  /** Replaces the lists sent, each in full (`PATCH /v3/brand-glossaries/{id}`); a concurrent edit is a 409. */
  updateGlossary(id: string, body: GlossaryLists & { name?: string }) {
    return this.request<unknown>(`${V3}/brand-glossaries/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  }

  /** One page of the workspace's glossaries (names and ids), and the cursor of the next page when there is one. */
  async listGlossaries(token?: string): Promise<{ glossaries: Array<{ id?: string; brand_glossary_id?: string; name?: string }>; next?: string }> {
    type Item = { id?: string; brand_glossary_id?: string; name?: string };
    const json = await this.envelope<Item[] | { items?: Item[]; next_token?: string; token?: string }>(`${V3}/brand-glossaries?limit=100${token ? `&token=${encodeURIComponent(token)}` : ""}`, { signal: AbortSignal.timeout(10_000) });
    const data = json.data;
    const glossaries = Array.isArray(data) ? data : data?.items ?? [];
    // The cursor's place is not documented; it is read from the envelope or from inside `data`.
    const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const inner = Array.isArray(data) ? undefined : data;
    const pagination = json.pagination as { next_token?: string; token?: string } | undefined;
    const next = pick(json.next_token) ?? pick(json.token) ?? pick(pagination?.next_token) ?? pick(pagination?.token) ?? pick(inner?.next_token) ?? pick(inner?.token);
    return { glossaries, next };
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
    return this.request<unknown>(`${V3}/video-translations/proofreads/${encodeURIComponent(id)}/srt`, { method: "PUT", body: JSON.stringify({ srt: { type: "url", url } }), signal: AbortSignal.timeout(20_000) });
  }

  /** Dubs the proofread lines; the returned translation is polled like any other. */
  generateProofread(id: string) {
    return this.request<{ video_translation_id: string }>(`${V3}/video-translations/proofreads/${encodeURIComponent(id)}/generate`, { method: "POST", body: JSON.stringify({}), signal: AbortSignal.timeout(20_000) });
  }

  /** Jobs started through the v2 API before the move to v3. */
  translationStatusV2(id: string) {
    return this.request<{ status: string; url?: string; message?: string }>(`${V2}/video_translate/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  }
}

/** The items in order, each id once (the first kept). */
function unique<T>(items: T[], id: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(id(item)) && !!seen.add(id(item)));
}
