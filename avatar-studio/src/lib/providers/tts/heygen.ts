import type { Voice } from "../../types";
import { HeyGenClient } from "../heygen-client";
import type { TtsProvider } from "../types";
import { LimitError, ValidationError } from "../../errors";
import { heygenReason } from "../avatar/heygen";
import { randomBytes } from "node:crypto";
import { withSuffix } from "../../text";

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
   * removed, under the account's name with the studio's mark (see `STUDIO_VOICE_MARK`). `onCreated` hears of the clone
   * as soon as HeyGen names it, before anything else is asked. The clone is then waited for briefly, so one HeyGen could
   * not make is refused with its reason (and deleted); one still being made is kept, as HeyGen finishes it within
   * seconds. When HeyGen's answer is lost, the clone it may have made is found by its mark, noted, and deleted.
   */
  async cloneVoice({ name, samples, language, onCreated }: { name: string; samples: Array<{ bytes: Uint8Array; mimeType: string; filename: string }>; language?: string; onCreated?: (voiceId: string) => Promise<void> }) {
    if (samples.length !== 1 || !/^audio\/(wav|x-wav|wave|mpeg|mp3)$/.test(samples[0].mimeType)) throw new ValidationError("HeyGen clones a voice from one WAV or MP3 recording");
    const [sample] = samples;
    const mark = ` ·st_${randomBytes(6).toString("hex")}`;
    const assetId = await this.client
      .uploadAsset(sample.bytes, sample.mimeType.includes("mp") ? "audio/mpeg" : "audio/wav", sample.mimeType.includes("mp") ? "voice.mp3" : "voice.wav")
      .catch((err: unknown) => {
        throw cloneError(err);
      });
    let voiceId: string;
    try {
      voiceId = await this.client.cloneVoice(withSuffix(name, mark, 64), assetId, language ? language.split("-")[0].toLowerCase() : undefined);
    } catch (err) {
      const mapped = cloneError(err);
      // No answer, or a failure on HeyGen's side: the clone may exist all the same, so it is looked for by its mark.
      if (!(mapped instanceof ValidationError) && !(mapped instanceof LimitError)) await this.dropLost(mark, onCreated);
      throw mapped;
    }
    await onCreated?.(voiceId);
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

  /** A clone whose answer was lost: found by its mark, noted, and deleted (it was never the account's). Never throws. */
  private async dropLost(mark: string, onCreated?: (voiceId: string) => Promise<void>) {
    try {
      for (const v of (await this.client.studioClones()).filter((c) => c.name.endsWith(mark))) {
        await onCreated?.(v.voice_id);
        await this.deleteVoice(v.voice_id);
      }
    } catch (err) {
      // Its mark still keeps it out of every account's list.
      console.error("a lost voice clone was not cleaned up:", err);
    }
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

/**
 * What a failed clone call means for the account: a recording HeyGen will not take is the account's to change (HeyGen's
 * reason); the shared key's clone limit or plan is the studio operator's, not the account's; a rate limit is a 429.
 */
function cloneError(err: unknown): Error {
  const message = err instanceof Error ? err.message : "";
  if (/ failed: 429 /.test(message)) return new LimitError("HeyGen is cloning too many voices right now; try again in a minute");
  if (/"code":\s*"(resource_limit_reached|plan_upgrade_required)"/.test(message) || / failed: 402 /.test(message)) return new ValidationError("Voice cloning is not available with this studio's HeyGen account right now; ask the studio's operator");
  if (/ failed: (400|403|413|422) /.test(message) || message.startsWith("HeyGen error:")) return new ValidationError(`HeyGen could not clone that voice: ${heygenReason(message, "record about a minute of clear speech")}`);
  return err instanceof Error ? err : new Error(message);
}
