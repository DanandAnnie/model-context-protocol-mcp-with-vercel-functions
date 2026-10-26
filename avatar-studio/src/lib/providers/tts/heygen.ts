import type { Voice } from "../../types";
import { HeyGenClient } from "../heygen-client";
import type { TtsProvider } from "../types";

/** HeyGen voices are rendered inside the video job; previews use the provider's sample clip. */
export class HeyGenTtsProvider implements TtsProvider {
  readonly name = "heygen";
  private client: HeyGenClient;
  constructor(apiKey: string) {
    this.client = new HeyGenClient(apiKey);
  }

  async listVoices(): Promise<Voice[]> {
    const data = await this.client.listVoices();
    return data.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      provider: this.name,
      language: v.language,
      gender: (v.gender?.toLowerCase() as Voice["gender"]) ?? undefined,
      previewUrl: v.preview_audio,
      ...(typeof v.emotion_support === "boolean" ? { emotionSupport: v.emotion_support } : {}),
    }));
  }

  async synthesize() {
    return null; // HeyGen does not expose standalone TTS; the browser plays previewUrl instead.
  }
}
