import type { Voice } from "../../types";
import type { TtsProvider } from "../types";

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

  async deleteVoice(voiceId: string) {
    const res = await fetch(`${BASE}/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE", headers: this.headers() });
    if (!res.ok && res.status !== 404) throw new Error(`ElevenLabs voice delete failed: ${res.status} ${await res.text()}`);
  }
}
