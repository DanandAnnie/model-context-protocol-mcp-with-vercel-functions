import { withBreakTags } from "../pauses";
// Voices: provider voices and cloned voices. Used by API routes only.
import { z } from "zod";
import { nowIso } from "../ids";
import { getTtsProvider } from "../providers";
import { decodeDataUrl } from "../providers/image";
import { getStore } from "../store";
import type { Avatar, Voice } from "../types";
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
  if (mine.length >= MAX_CLONED_VOICES) throw new ValidationError(`At most ${MAX_CLONED_VOICES} voices of your own (cloned or designed) per account`);
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

export const designVoiceSchema = z.object({
  description: z.string().trim().min(20, "Describe the voice in at least 20 characters").max(1000),
  /** What the previews read: 100 to 1000 characters, or none for a sample written for the description. */
  text: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((t) => t || undefined)
    .refine((t) => !t || t.length >= 100, "The sample text needs at least 100 characters, or leave it empty for one written for you"),
});

export const saveDesignedVoiceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(20).max(1000),
  previewId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "Choose one of the previews"),
  language: z.string().trim().max(40).optional(),
});

/** The voices an account keeps of its own (cloned or designed) with the provider in use. */
async function ownVoices(ownerId: string): Promise<Voice[]> {
  const provider = getTtsProvider();
  return (await getStore().list<Voice>("voice", ownerId)).filter((v) => v.provider === provider.name);
}

/**
 * Designs voices from a description with the TTS provider: previews of a sample to choose from, none kept yet. Refused
 * up front when the account already keeps as many voices as it may, so no previews are paid for that cannot be saved.
 */
export async function designVoice(input: z.infer<typeof designVoiceSchema>, ownerId: string = LOCAL_OWNER): Promise<{ text: string; previews: Array<{ previewId: string; audioUrl?: string; durationSec?: number }> }> {
  const provider = getTtsProvider();
  if (!provider.designVoice) throw new ValidationError(`Voice design is not available with the ${provider.name} voice provider`);
  if ((await ownVoices(ownerId)).length >= MAX_CLONED_VOICES) throw new ValidationError(`At most ${MAX_CLONED_VOICES} voices of your own per account; delete one to design another`);
  const { text, previews } = await provider.designVoice({ description: input.description, text: input.text });
  if (!previews.length) throw new Error("The voice provider made no previews for that description; try describing it differently");
  return {
    text,
    previews: previews.map(({ previewId, audio, durationSec }) => ({
      previewId,
      ...(audio ? { audioUrl: `data:${audio.mimeType};base64,${audio.base64}` } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
    })),
  };
}

/** Keeps the chosen preview as a custom voice of the owner, listed with the cloned ones. */
export async function saveDesignedVoice(input: z.infer<typeof saveDesignedVoiceSchema>, ownerId: string = LOCAL_OWNER): Promise<Voice> {
  const provider = getTtsProvider();
  if (!provider.saveDesignedVoice) throw new ValidationError(`Voice design is not available with the ${provider.name} voice provider`);
  if ((await ownVoices(ownerId)).length >= MAX_CLONED_VOICES) throw new ValidationError(`At most ${MAX_CLONED_VOICES} voices of your own per account; delete one to save another`);
  const { voiceId } = await provider.saveDesignedVoice({ name: input.name, description: input.description, previewId: input.previewId });
  const voice: Voice = { id: voiceId, name: input.name, provider: provider.name, language: input.language, source: "custom", ownerId, tags: ["designed voice"], createdAt: nowIso() };
  return getStore().put("voice", voice);
}

export const updateVoiceSchema = z.object({ name: z.string().trim().min(1).max(60) });

/**
 * Renames a cloned voice. Provider voices cannot be edited (404, like any voice that is not the
 * owner's). Videos keep the name they were rendered with; the provider's copy keeps its name too.
 */
export async function updateClonedVoice(id: string, patch: z.infer<typeof updateVoiceSchema>, ownerId: string = LOCAL_OWNER): Promise<Voice> {
  const existing = owned(await getStore().get<Voice>("voice", id), ownerId, `Voice ${id}`);
  return getStore().put("voice", { ...existing, name: patch.name });
}

export async function deleteClonedVoice(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const voice = owned(await getStore().get<Voice>("voice", id), ownerId, `Voice ${id}`);
  const provider = getTtsProvider();
  if (provider.name === voice.provider) await provider.deleteVoice?.(id);
  await getStore().remove("voice", id);
  // Photo avatars that opened the editor with this voice fall back to the video's voice from now on.
  const defaults = (await getStore().list<Avatar>("avatar", ownerId)).filter((a) => a.defaultVoiceId === id);
  await Promise.all(defaults.map(({ defaultVoiceId: _gone, ...rest }) => getStore().put("avatar", rest)));
}

export async function previewVoice(voiceId: string, text: string, speed: number) {
  // ElevenLabs reads break tags in the text; the other engines have none to read.
  return getTtsProvider().synthesize(voiceId, withBreakTags(text), speed);
}
