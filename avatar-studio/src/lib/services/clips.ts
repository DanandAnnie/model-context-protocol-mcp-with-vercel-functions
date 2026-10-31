// Recorded or uploaded audio a scene can use instead of a typed script spoken by a voice: the
// presenter lip-syncs to the clip. Used by API routes only.
//
// The metadata row (`clip`) is what lists and scenes read; the bytes live in their own row
// (`clipaudio`), like cover images, so listing clips or loading a video never pulls audio.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { decodeDataUrl } from "../providers/image";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { LOCAL_OWNER } from "../owner-id";
import { MAX_CLIPS, MAX_CLIP_SECONDS, type AudioClip, type AudioClipType } from "../types";
import { owned } from "./shared";

/** Fits one request body on Vercel (4.5 MB) once base64-encoded: 3 MB is 4 MB as base64. */
export const MAX_CLIP_BYTES = 3 * 1024 * 1024;
export { MAX_CLIPS, MAX_CLIP_SECONDS };
const CLIP_TYPES = new Set<AudioClipType>(["audio/wav", "audio/mpeg"]);

export const clipUploadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** A data URL: WAV (the editor converts recordings and uploads to it) or MP3. */
  audio: z.string().min(1).max(4_300_000),
  /** Required for MP3, whose length cannot be read cheaply; a WAV's length is read from its header. */
  durationSec: z.number().positive().max(MAX_CLIP_SECONDS).optional(),
});

type ClipAudio = { id: string; clipId: string; ownerId?: string; mimeType: AudioClipType; data: string };

/** Prefixed like every other side record: the Supabase table keys every kind by id alone. */
const audioRowId = (clipId: string) => `clipaudio_${clipId}`;

/**
 * Seconds of audio in a PCM WAV file, from the `fmt ` chunk's byte rate and the `data` chunk's
 * size; null when the bytes are not a well-formed RIFF/WAVE file.
 */
export function wavSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate = 0;
  let dataSize = -1;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 24 <= bytes.byteLength) {
      // PCM only, and the rate is computed from its parts rather than trusted from the header.
      const format = view.getUint16(at + 8, true);
      const channels = view.getUint16(at + 10, true);
      const sampleRate = view.getUint32(at + 12, true);
      const bits = view.getUint16(at + 22, true);
      if (format !== 1 || !channels || channels > 2 || sampleRate < 8000 || sampleRate > 96_000 || (bits !== 8 && bits !== 16 && bits !== 24)) return null;
      byteRate = (sampleRate * channels * bits) / 8;
    }
    if (id === "data") {
      // A recorder that never patched the size leaves 0 or 0xFFFFFFFF; the rest of the file is the audio then.
      dataSize = size === 0 || size === 0xffffffff ? bytes.byteLength - at - 8 : Math.min(size, bytes.byteLength - at - 8);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!byteRate || dataSize < 0) return null;
  return dataSize / byteRate;
}

/** An MP3 starts with an ID3 tag or an MPEG audio frame sync. */
export function looksMp3(b: Uint8Array): boolean {
  return (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
}

function view(clip: AudioClip): AudioClip {
  const { providerAssetIds: _ids, ...rest } = clip;
  void _ids;
  return rest;
}

export async function listClips(ownerId: string = LOCAL_OWNER): Promise<AudioClip[]> {
  const clips = await getStore().list<AudioClip>("clip", ownerId);
  return clips.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view);
}

export async function createClip(input: z.infer<typeof clipUploadSchema>, ownerId: string = LOCAL_OWNER): Promise<AudioClip> {
  if (!input.audio.startsWith("data:audio/")) throw new ValidationError("The clip must be an audio recording or file");
  let decoded: ReturnType<typeof decodeDataUrl>;
  try {
    decoded = decodeDataUrl(input.audio);
  } catch {
    throw new ValidationError("The audio data is malformed");
  }
  const mimeType = (decoded.mimeType === "audio/x-wav" || decoded.mimeType === "audio/wave" ? "audio/wav" : decoded.mimeType) as AudioClipType;
  if (!CLIP_TYPES.has(mimeType)) throw new ValidationError("The clip must be WAV or MP3 audio");
  if (decoded.bytes.byteLength > MAX_CLIP_BYTES) throw new ValidationError("The clip is too large (3 MB max)");
  let seconds: number;
  if (mimeType === "audio/wav") {
    const read = wavSeconds(decoded.bytes);
    if (read === null) throw new ValidationError("The WAV file is malformed");
    seconds = read;
  } else {
    if (!looksMp3(decoded.bytes)) throw new ValidationError("The MP3 file is malformed");
    if (!input.durationSec) throw new ValidationError("Give the length of an MP3 clip in durationSec");
    seconds = input.durationSec;
  }
  return keepClip({ name: input.name, mimeType, bytes: decoded.bytes, seconds }, ownerId);
}

/** Stores checked audio as a new clip, within the length and the account's number of clips. */
export async function keepClip(input: { name: string; mimeType: AudioClipType; bytes: Uint8Array; seconds: number; transcript?: string }, ownerId: string = LOCAL_OWNER): Promise<AudioClip> {
  const { name, mimeType, bytes, seconds, transcript } = input;
  if (seconds < 0.5) throw new ValidationError("The clip is too short to speak (half a second at least)");
  if (seconds > MAX_CLIP_SECONDS) throw new ValidationError(`Clips can be at most ${MAX_CLIP_SECONDS} seconds long`);
  if ((await getStore().list<AudioClip>("clip", ownerId)).length >= MAX_CLIPS) {
    throw new ConflictError(`At most ${MAX_CLIPS} audio clips per account; delete one you no longer use`);
  }
  const clip: AudioClip = { id: newId("clip"), ownerId, name, mimeType, bytes: bytes.byteLength, durationSec: Math.round(seconds * 10) / 10, ...(transcript?.trim() ? { transcript: transcript.trim() } : {}), createdAt: nowIso() };
  // Bytes first: a clip row that is listed always has its audio.
  await getStore().put<ClipAudio>("clipaudio", { id: audioRowId(clip.id), clipId: clip.id, ownerId, mimeType, data: Buffer.from(bytes).toString("base64") });
  return view(await getStore().put("clip", clip));
}

/** What can change on a clip once made: its name, and the words it says (`null` or blank forgets them). */
export const clipEditSchema = z
  .object({
    name: z.string().trim().min(1, "Name the clip").max(80).optional(),
    transcript: z.union([z.string().trim().max(5000, "What a clip says is at most 5000 characters, as a scene's script is"), z.null()]).optional(),
  })
  .refine((v) => v.name !== undefined || v.transcript !== undefined, { message: "Give the clip a new name or the words it says" });

/** Renames a clip or sets the words it says; videos already made keep what they were made with. */
export async function editClip(id: string, input: z.infer<typeof clipEditSchema>, ownerId: string = LOCAL_OWNER): Promise<AudioClip> {
  const clip = await getClip(id, ownerId);
  const { transcript: _old, ...rest } = clip;
  void _old;
  const words = input.transcript === undefined ? clip.transcript : input.transcript || undefined;
  const next: AudioClip = { ...rest, ...(input.name !== undefined ? { name: input.name } : {}), ...(words ? { transcript: words } : {}) };
  // Written only over the row read: a clip deleted meanwhile stays deleted rather than coming back without its audio.
  if (!(await getStore().putIf("clip", next, "createdAt", clip.createdAt))) throw new NotFoundError(`Audio clip ${id} not found`);
  return view(next);
}

/** Gives a clip without words the words it says (a clip kept before transcripts were); one that has words keeps them. */
export async function addClipTranscript(clip: AudioClip, transcript: string): Promise<AudioClip> {
  const current = await getStore().get<AudioClip>("clip", clip.id);
  if (!current || current.transcript || !transcript.trim()) return clip;
  const next = { ...current, transcript: transcript.trim() };
  return (await getStore().putIf("clip", next, "createdAt", current.createdAt)) ? view(next) : clip;
}

/** The account's clip as the API shows it, or null when there is none by that id. */
export async function findClip(id: string, ownerId: string = LOCAL_OWNER): Promise<AudioClip | null> {
  const clip = await getStore().get<AudioClip>("clip", id);
  return clip && clip.ownerId === ownerId ? view(clip) : null;
}

/** The stored clip with provider asset ids, for rendering. */
export async function getClip(id: string, ownerId: string = LOCAL_OWNER): Promise<AudioClip> {
  return owned(await getStore().get<AudioClip>("clip", id), ownerId, `Audio clip ${id}`);
}

export async function getClipAudio(id: string, ownerId: string = LOCAL_OWNER): Promise<{ name: string; mimeType: AudioClipType; bytes: Uint8Array }> {
  const clip = await getClip(id, ownerId);
  const row = await getStore().get<ClipAudio>("clipaudio", audioRowId(id));
  if (!row) throw new NotFoundError(`Audio clip ${id} has no audio`);
  return { name: clip.name, mimeType: row.mimeType, bytes: new Uint8Array(Buffer.from(row.data, "base64")) };
}

/** Records the provider's asset id for a clip so later renders (retries, copies) skip the upload. Keeps a clip deleted meanwhile deleted. */
export async function saveClipAssetIds(clip: AudioClip, ids: Record<string, string>): Promise<AudioClip> {
  const current = await getStore().get<AudioClip>("clip", clip.id);
  if (!current) return { ...clip, providerAssetIds: { ...clip.providerAssetIds, ...ids } };
  const next = { ...current, providerAssetIds: { ...current.providerAssetIds, ...ids } };
  // Like the edits above, only over a row that is still there: a clip deleted during a render stays deleted.
  await getStore().putIf("clip", next, "createdAt", current.createdAt);
  return next;
}

/** Deletes a clip and its audio. Videos already rendered keep their footage; a retry or copy that names it is refused. */
export async function deleteClip(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  await getClip(id, ownerId);
  await getStore().remove("clip", id);
  await getStore().remove("clipaudio", audioRowId(id));
}
