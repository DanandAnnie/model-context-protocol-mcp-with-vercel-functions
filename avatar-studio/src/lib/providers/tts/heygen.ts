import type { Voice } from "../../types";
import { HeyGenClient } from "../heygen-client";
import type { TtsProvider } from "../types";
import { ValidationError } from "../../errors";
import { heygenReason } from "../avatar/heygen";

/** How often, and how long, a new clone is waited for before it is kept: about ten seconds (it is usually ready in seconds). */
const CLONE_CHECKS = 4;
const CLONE_CHECK_MS = 2500;

/** HeyGen voices are rendered inside the video job; previews use the provider's sample clip. */
export class HeyGenTtsProvider implements TtsProvider {
  readonly name = "heygen";
  readonly oneRecording = true as const;
  private client: HeyGenClient;
  /** Waits between checks on a new clone (tests make it instant). */
  static sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

  /**
   * Clones a voice from one recording (v3): the WAV or MP3 is uploaded as an asset and cloned with background noise
   * removed. The clone is waited for briefly, so one HeyGen could not make is refused with its reason (and deleted);
   * one still being made is kept, as HeyGen finishes it within seconds.
   */
  async cloneVoice({ name, samples }: { name: string; samples: Array<{ bytes: Uint8Array; mimeType: string; filename: string }> }) {
    if (samples.length !== 1 || !/^audio\/(wav|x-wav|wave|mpeg|mp3)$/.test(samples[0].mimeType)) throw new ValidationError("HeyGen clones a voice from one WAV or MP3 recording");
    const [sample] = samples;
    let voiceId: string;
    try {
      const assetId = await this.client.uploadAsset(sample.bytes, sample.mimeType.includes("mp") ? "audio/mpeg" : "audio/wav", sample.mimeType.includes("mp") ? "voice.mp3" : "voice.wav");
      voiceId = await this.client.cloneVoice(name.slice(0, 64), assetId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // A plan without cloning, the account's clone limit, or a recording HeyGen will not take is the account's to change.
      if (/ failed: (400|402|403|413|422) /.test(message) || message.startsWith("HeyGen error:")) throw new ValidationError(`HeyGen could not clone that voice: ${heygenReason(message, "record about a minute of clear speech")}`);
      throw err;
    }
    for (let i = 0; i < CLONE_CHECKS; i++) {
      const v = await this.client.getVoice(voiceId).catch(() => null);
      if (v?.status === "failed") {
        await this.deleteVoice(voiceId).catch(() => undefined);
        throw new ValidationError(`HeyGen could not clone that voice${v.failure_message ? `: ${v.failure_message}` : ""}; record about a minute of clear speech and try again`);
      }
      if (v?.status === "complete" || (v && !v.status)) return { voiceId, ...(v.preview_audio_url ? { previewUrl: v.preview_audio_url } : {}) };
      if (i < CLONE_CHECKS - 1) await HeyGenTtsProvider.sleep(CLONE_CHECK_MS);
    }
    return { voiceId };
  }

  async describeVoice(voiceId: string) {
    const v = await this.client.getVoice(voiceId);
    return {
      ...(v.language ? { language: v.language } : {}),
      ...(v.gender ? { gender: v.gender.toLowerCase() as Voice["gender"] } : {}),
      ...(v.preview_audio_url ? { previewUrl: v.preview_audio_url } : {}),
    };
  }

  /** A voice of an account here (a digital twin's clone); one HeyGen no longer has counts as deleted. */
  async deleteVoice(voiceId: string) {
    try {
      await this.client.deleteVoice(voiceId);
    } catch (err) {
      if (!/ failed: 404\b/.test(err instanceof Error ? err.message : "")) throw err;
    }
  }

  async synthesize() {
    return null; // HeyGen does not expose standalone TTS; the browser plays previewUrl instead.
  }
}
