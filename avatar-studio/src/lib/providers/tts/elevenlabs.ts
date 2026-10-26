import type { Voice } from "../../types";
import type { DesignedPreview, TtsProvider } from "../types";

const BASE = "https://api.elevenlabs.io/v1";

interface ElVoice {
  voice_id: string;
  name: string;
  preview_url?: string;
  labels?: Record<string, string>;
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";
  constructor(private apiKey: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { "xi-api-key": this.apiKey, ...extra };
  }

  async listVoices(): Promise<Voice[]> {
    const res = await fetch(`${BASE}/voices`, { headers: this.headers(), cache: "no-store" });
    if (!res.ok) throw new Error(`ElevenLabs voices failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { voices: ElVoice[] };
    return json.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      provider: this.name,
      previewUrl: v.preview_url,
      gender: (v.labels?.gender as Voice["gender"]) ?? undefined,
      language: v.labels?.language,
      tags: Object.values(v.labels ?? {}).filter(Boolean),
    }));
  }

  async synthesize(voiceId: string, text: string, speed: number) {
    const res = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Accept: "audio/mpeg" }),
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed },
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
    return { audio: new Uint8Array(await res.arrayBuffer()), mimeType: "audio/mpeg" };
  }

  /** Instant voice clone from one to five samples (ElevenLabs /v1/voices/add). */
  async cloneVoice({ name, samples }: { name: string; samples: Array<{ bytes: Uint8Array; mimeType: string; filename: string }> }) {
    const form = new FormData();
    form.append("name", name);
    form.append("remove_background_noise", "true");
    for (const s of samples) form.append("files", new Blob([s.bytes as BlobPart], { type: s.mimeType }), s.filename);
    const res = await fetch(`${BASE}/voices/add`, { method: "POST", headers: this.headers(), body: form });
    if (!res.ok) throw new Error(`ElevenLabs voice clone failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { voice_id: string };
    return { voiceId: json.voice_id };
  }

  /** Voice design from a description (ElevenLabs /v1/text-to-voice/design): previews with their MP3 samples. */
  async designVoice({ description, text }: { description: string; text?: string }): Promise<{ text: string; previews: DesignedPreview[] }> {
    const res = await fetch(`${BASE}/text-to-voice/design?output_format=mp3_44100_64`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ voice_description: description, model_id: "eleven_multilingual_ttv_v2", ...(text ? { text } : { auto_generate_text: true }) }),
    });
    if (!res.ok) throw new Error(`ElevenLabs voice design failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { text?: string; previews?: Array<{ generated_voice_id: string; audio_base_64?: string; media_type?: string; duration_secs?: number }> };
    return {
      text: json.text ?? text ?? "",
      previews: (json.previews ?? []).map((p) => ({
        previewId: p.generated_voice_id,
        ...(p.audio_base_64 ? { audio: { base64: p.audio_base_64, mimeType: p.media_type || "audio/mpeg" } } : {}),
        ...(typeof p.duration_secs === "number" ? { durationSec: p.duration_secs } : {}),
      })),
    };
  }

  /** Keeps a designed preview as a voice (ElevenLabs /v1/text-to-voice). */
  async saveDesignedVoice({ name, description, previewId }: { name: string; description: string; previewId: string }) {
    const res = await fetch(`${BASE}/text-to-voice`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ voice_name: name, voice_description: description, generated_voice_id: previewId }),
    });
    if (!res.ok) throw new Error(`ElevenLabs could not save the designed voice: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { voice_id: string };
    return { voiceId: json.voice_id };
  }

  async deleteVoice(voiceId: string) {
    const res = await fetch(`${BASE}/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE", headers: this.headers() });
    if (res.ok || res.status === 404) return;
    const body = await res.text();
    // Some ElevenLabs endpoints answer a voice they no longer have with 400 and a "voice_not_found" status.
    if (res.status === 400 && voiceMissing(body)) return;
    throw Object.assign(new Error(`ElevenLabs voice delete failed: ${res.status} ${body}`), { status: res.status });
  }
}

/** Whether an ElevenLabs error body's `detail.status` says the voice does not exist (not merely mentions it). */
function voiceMissing(body: string): boolean {
  try {
    const status = (JSON.parse(body) as { detail?: { status?: unknown } }).detail?.status;
    return status === "voice_not_found" || status === "voice_does_not_exist";
  } catch {
    return false;
  }
}
