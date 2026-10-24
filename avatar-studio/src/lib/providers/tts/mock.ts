import { STOCK_VOICES } from "../../stock";
import type { TtsProvider } from "../types";

/** Demo TTS: lists stock voices; audio is produced in the browser via Web Speech. */
export class MockTtsProvider implements TtsProvider {
  readonly name = "mock";
  async listVoices() {
    return STOCK_VOICES;
  }
  async synthesize() {
    return null;
  }

  /** Demo clone: accepts the samples and returns a new id; previews fall back to the browser voice. */
  async cloneVoice({ samples }: { name: string; samples: Array<{ bytes: Uint8Array; mimeType: string; filename: string }> }) {
    if (samples.length === 0) throw new Error("At least one sample is required");
    return { voiceId: `clone_${Math.random().toString(36).slice(2, 12)}` };
  }
  async deleteVoice() {}
}
