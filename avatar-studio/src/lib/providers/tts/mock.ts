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
}
