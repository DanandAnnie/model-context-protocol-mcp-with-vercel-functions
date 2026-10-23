// Voices: provider voices and cloned voices. Used by API routes only.
import { z } from "zod";
import { nowIso } from "../ids";
import { getTtsProvider } from "../providers";
import { decodeDataUrl } from "../providers/image";
import { getStore } from "../store";
import type { Voice } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { memo } from "../cache";
import { ValidationError } from "../errors";
import { LIST_TTL_MS, owned } from "./shared";

/** Provider voices (memoised) plus the owner's cloned voices, which are listed first. */
export async function listVoices(ownerId?: string): Promise<Voice[]> {
  const p = getTtsProvider();
  const provider = await memo(`voices:${p.name}`, LIST_TTL_MS, () => p.listVoices());
  if (!ownerId) return provider;
  const custom = (await getStore().list<Voice>("voice", ownerId)).filter((v) => v.provider === p.name);
  custom.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return [...custom, ...provider];
}

export const MAX_VOICE_SAMPLE_BYTES = 10 * 1024 * 1024;
export const MAX_CLONED_VOICES = 5;

export const cloneVoiceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Audio samples as data URLs (audio/*), one to five, 10 MB in total. */
  samples: z.array(z.string().min(1).max(14_000_000)).min(1).max(5),
  language: z.string().trim().max(40).optional(),
});

export function voiceCloningAvailable(): boolean {
  return typeof getTtsProvider().cloneVoice === "function";
}

/** Clones a voice with the TTS provider and keeps it as a custom voice of the owner. */
export async function cloneVoice(input: z.infer<typeof cloneVoiceSchema>, ownerId: string = LOCAL_OWNER): Promise<Voice> {
  const provider = getTtsProvider();
  if (!provider.cloneVoice) throw new ValidationError(`Voice cloning is not available with the ${provider.name} voice provider`);
  const mine = (await getStore().list<Voice>("voice", ownerId)).filter((v) => v.provider === provider.name);
  if (mine.length >= MAX_CLONED_VOICES) throw new ValidationError(`At most ${MAX_CLONED_VOICES} cloned voices per account`);
  let total = 0;
  const samples = input.samples.map((dataUrl, i) => {
    if (!dataUrl.startsWith("data:audio/")) throw new ValidationError("Samples must be audio recordings or files");
    const { bytes, mimeType } = decodeDataUrl(dataUrl);
    total += bytes.byteLength;
    if (total > MAX_VOICE_SAMPLE_BYTES) throw new ValidationError("Samples must be under 10 MB in total");
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("wav") ? "wav" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : "mp3";
    return { bytes, mimeType, filename: `sample-${i + 1}.${ext}` };
  });
  const { voiceId } = await provider.cloneVoice({ name: input.name, samples });
  const voice: Voice = { id: voiceId, name: input.name, provider: provider.name, language: input.language, source: "custom", ownerId, tags: ["your voice"], createdAt: nowIso() };
  return getStore().put("voice", voice);
}

export async function deleteClonedVoice(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const voice = owned(await getStore().get<Voice>("voice", id), ownerId, `Voice ${id}`);
  const provider = getTtsProvider();
  if (provider.name === voice.provider) await provider.deleteVoice?.(id);
  await getStore().remove("voice", id);
}

export async function previewVoice(voiceId: string, text: string, speed: number) {
  return getTtsProvider().synthesize(voiceId, text, speed);
}
