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
    return (await this.client.listVoices()).map((v) => ({
      id: v.voice_id,
      name: v.name,
      provider: this.name,
      language: v.language,
      gender: (v.gender?.toLowerCase() as Voice["gender"]) ?? undefined,
      previewUrl: v.preview_audio_url,
      ...(v.support_locale ? { accents: true as const } : {}),
    }));
  }

  async synthesize() {
    return null; // HeyGen does not expose standalone TTS; the browser plays previewUrl instead.
  }
}
