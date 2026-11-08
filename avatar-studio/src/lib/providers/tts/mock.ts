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

  /** Demo design: three previews of the sample, read by the browser; nothing leaves the app. */
  async designVoice({ text }: { description: string; text?: string }) {
    const sample = text ?? "Hello, and thanks for listening. This is a preview of the voice you described, reading a few sentences so you can hear its tone and pace.";
    const previews = [1, 2, 3].map(() => ({ previewId: `design_${Math.random().toString(36).slice(2, 12)}` }));
    return { text: sample, previews };
  }
  async saveDesignedVoice() {
    return { voiceId: `designed_${Math.random().toString(36).slice(2, 12)}` };
  }
}
