// The voice changer: instant voices made at the renderer from one recording of a person (HeyGen Voice's instant clone),
// and recordings spoken again in one of them, the words and timing kept (HeyGen's speech to speech). Each voice is the
// account's own: the renderer's shared account holds it under the studio's mark, and no other account is offered it.
// Used by API routes only.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { MAX_CLIP_SECONDS, VOICE_RESULT_LINK_MS, type AudioClip, type AudioClipType, type InstantVoice, type PublicVoice, type SpokenWord, type VoiceChange, type VoiceChangeWords } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, LimitError, NotFoundError, UpstreamError, ValidationError } from "../errors";
import { nextUpdatedAt, owned, renameJob, stripUndefined, writeRefresh } from "./shared";
import { MAX_CLIP_BYTES, addClipTranscript, findClip, getClip, keepClip, looksMp3, wavSeconds } from "./clips";
import { ResponseTooLargeError, safeFetch, type FetchLike } from "../safe-fetch";
import { UnsafeUrlError } from "../safe-url";
import { getBackdrop, getBackdropImage } from "./backdrops";
import { prepareClipOnce } from "./videos";
import { rememberMadeVoices } from "./voices";
import { jobChecker } from "./job-checks";
import { graphemes, withSuffix } from "../text";
import { wordCues, type Cue } from "../captions";
import { pronunciationLanguage } from "../pronounce";
import { isSpecialLanguageCode } from "../language";

/** Instant voices an account keeps; another needs one deleted first. */
export const MAX_INSTANT_VOICES = 10;
/** Recordings spoken again that an account keeps. */
export const MAX_VOICE_CHANGES = 50;
/**
 * How long after a start's request arrived it stops waiting for the renderer (the function is cut off at 60 seconds,
 * and the clip's upload comes out of the same time); one not done by then is asked for again while the list is open.
 */
const START_DEADLINE_MS = 50_000;
const MIN_WAIT_MS = 5_000;
const CHECK_WAIT_MS = 8_000;
/** A conversion the renderer still says is running this long after it started is given up. */
const GIVE_UP_MS = 30 * 60 * 1000;
/**
 * The renderer keeps a key's answer (a finished conversion, without charging again) for a day; past this it is never
 * asked again, as that would speak, and charge for, the recording again.
 */
const KEY_KEPT_MS = 23 * 60 * 60 * 1000;

const keySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");
export const voiceChangerKeySchema = keySchema;

export const instantVoiceSchema = z.object({
  name: z.string({ error: "Name the voice" }).trim().min(1, "Name the voice").max(60, "Keep the name to 60 characters"),
  /** The recording it is made from: one of the account's audio clips. */
  clipId: z.string({ error: "Choose a recording of the voice" }).trim().min(1, "Choose a recording of the voice"),
  /** The person whose voice it is agreed to it being cloned. */
  agreed: z.literal(true, { error: "Confirm that the speaker agreed to have their voice cloned" }),
  /** One of the account's uploaded pictures, of the speaker's setting, whose ambience the voice takes on. */
  settingPictureId: z.string().regex(/^bd_[A-Za-z0-9_-]{1,64}$/, "Choose one of your pictures for the setting").optional(),
});

/** A new name for an instant voice, held to the same rule as the name it was made with. */
export const instantVoiceRenameSchema = instantVoiceSchema.pick({ name: true });

export const voiceChangeSchema = z.object({
  voiceId: z.string({ error: "Choose one of your instant voices" }).regex(/^iv_[A-Za-z0-9_-]{1,64}$/, "Choose one of your instant voices"),
  clipId: z.string({ error: "Choose the recording to speak again" }).trim().min(1, "Choose the recording to speak again"),
  removeNoise: z.boolean().default(false),
  title: z.string().trim().max(120, "Keep the title to 120 characters").optional(),
});

/**
 * A text still marked as being spoken this long after it started was cut off with its request (which waits at most a
 * minute); it is given up. Text is never asked for again: the renderer documents no replay of a finished answer for
 * text to speech, so asking again could speak, and charge for, it twice.
 */
const SPEECH_GIVE_UP_MS = 90_000;
/** Text an account may have spoken at once: well under the renderer's 5,000 characters, so it is ready within a minute. */
export const MAX_SPEECH_CHARS = 2000;

export const voiceSpeechSchema = z.object({
  /** One of the account's instant voices (`iv_…`) or one of HeyGen's public voices (`pv_…`). */
  voiceId: z.string({ error: "Choose a voice" }).regex(/^(iv|pv)_[A-Za-z0-9_-]{1,64}$/, "Choose one of your instant voices or one of HeyGen's"),
  text: z.string({ error: "Write the text to speak" }).trim().min(1, "Write the text to speak").max(MAX_SPEECH_CHARS, `Keep the text to ${MAX_SPEECH_CHARS.toLocaleString("en-US")} characters`),
  title: z.string().trim().max(120, "Keep the title to 120 characters").optional(),
  /** The renderer's faster, cheaper model; false (or absent) is its standard one, stored as absent. */
  turbo: z.boolean({ error: "turbo is true or false" }).optional(),
  /**
   * Turbo at no charge (HeyGen Voice 1 Turbo Free), within HeyGen's own limits and shared capacity; it implies Turbo,
   * so `turbo: false` with it is refused. False (or absent) is stored as absent.
   */
  free: z.boolean({ error: "free is true or false" }).optional(),
  /** The file HeyGen hands back: its WAV (the default, stored as absent) or an MP3 (smaller, at 44.1 kHz and 128 kbps). */
  format: z.enum(["wav", "mp3"], { error: "format is wav or mp3" }).optional(),
  /** The text's language, by name ("French") or code ("fr", "fr-CA"); absent (or blank) lets HeyGen detect it. */
  language: z.preprocess(
    (v) => (v === null || (typeof v === "string" && !v.trim()) ? undefined : v),
    z.string({ error: "language is a language name or code" }).trim().max(40, "language is a language name or code").refine((l) => !!pronunciationLanguage(l) && !isSpecialLanguageCode(pronunciationLanguage(l)), "Name the text's language, for example French, or leave it out").optional(),
  ),
  /**
   * HeyGen's expressiveness boost, 0 to 1 in steps of 0.1. HeyGen applies 1 (its full boost) when none is sent, so 1
   * is stored as absent and anything lower, 0 included, is stored and sent.
   */
  expressivenessBoost: z
    .number({ error: "expressivenessBoost is a number from 0 to 1" })
    .min(0, "expressivenessBoost is a number from 0 to 1")
    .max(1, "expressivenessBoost is a number from 0 to 1")
    // Tenths, as offered: a finer value is refused rather than quietly rounded to another delivery.
    .refine((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, "expressivenessBoost goes in steps of 0.1")
    .transform((v) => {
      const tenths = Math.round(v * 10) / 10;
      return tenths === 1 ? undefined : tenths;
    })
    .optional(),
})
  // Free is Turbo's free tier: asked for alone it turns Turbo on; asked for with Turbo off it is a contradiction.
  .refine((v) => !(v.free && v.turbo === false), { message: "free is Turbo at no charge; leave turbo out or send it as true", path: ["free"] })
  .transform(({ turbo, free, format, ...rest }) => ({ ...rest, turbo: turbo || free ? (true as const) : undefined, free: free ? (true as const) : undefined, format: format === "mp3" ? ("mp3" as const) : undefined }));

export const instantVoiceIdSchema = z.string().regex(/^iv_[A-Za-z0-9_-]{1,64}$/, "Unknown instant voice");
export const voiceChangeIdSchema = z.string().regex(/^vc_[A-Za-z0-9_-]{1,64}$/, "Unknown recording");

export function voiceChangerAvailable(): boolean {
  return typeof getAvatarProvider().changeVoice === "function";
}

/** Whether the renderer can speak text in an instant voice. */
export function voiceSpeechAvailable(): boolean {
  return typeof getAvatarProvider().speakText === "function";
}

/** What the account sees: never the renderer, its ids, or the upload sent to it. */
export type PublicInstantVoice = Omit<InstantVoice, "ownerId" | "provider" | "providerVoiceId" | "askedName">;
export type PublicVoiceChange = Omit<VoiceChange, "ownerId" | "provider" | "providerVoiceId" | "providerAudio" | "askedTitle">;
export function publicInstantVoice(v: InstantVoice): PublicInstantVoice {
  const { ownerId: _o, provider: _p, providerVoiceId: _v, askedName: _n, ...rest } = v;
  void _o;
  void _p;
  void _v;
  void _n;
  return rest;
}
export function publicVoiceChange(c: VoiceChange): PublicVoiceChange {
  const { ownerId: _o, provider: _p, providerVoiceId: _v, providerAudio: _a, askedTitle: _t, ...rest } = c;
  void _o;
  void _p;
  void _v;
  void _a;
  void _t;
  return rest;
}

/**
 * Renames one of the account's instant voices, here only (the renderer's copy keeps the name it was made with). Two
 * voices of one name cannot be told apart in the pickers, so a name another voice has is refused. The name it was made
 * with is kept (server only) for a retried start with the same key.
 */
export async function renameInstantVoice(id: string, name: string, ownerId: string = LOCAL_OWNER): Promise<PublicInstantVoice> {
  if (!instantVoiceIdSchema.safeParse(id).success) throw new NotFoundError("Instant voice not found");
  let current = owned(await getStore().get<InstantVoice>("instantvoice", id), ownerId, "Instant voice");
  for (let attempt = 0; attempt < 5; attempt++) {
    if (current.name === name) return publicInstantVoice(current);
    const lower = name.toLowerCase();
    const mine = await getStore().list<InstantVoice>("instantvoice", ownerId);
    if (mine.some((v) => v.id !== id && v.status !== "failed" && v.name.trim().toLowerCase() === lower)) throw new ConflictError(`You already have a voice named "${name}"; pick another name`);
    const next: InstantVoice = { ...current, name, askedName: current.askedName ?? current.name, updatedAt: nextUpdatedAt(current.updatedAt) };
    if (await getStore().putIf("instantvoice", next, "updatedAt", current.updatedAt)) return publicInstantVoice(next);
    current = owned(await getStore().get<InstantVoice>("instantvoice", id), ownerId, "Instant voice");
  }
  throw new ConflictError("The voice kept changing while it was being renamed; try again");
}

/** Renames one of the account's recordings spoken in a voice: `{ title }` → it as the account sees it. */
export async function renameVoiceChange(id: string, title: string, ownerId: string = LOCAL_OWNER): Promise<PublicVoiceChange> {
  if (!voiceChangeIdSchema.safeParse(id).success) throw new NotFoundError("Recording not found");
  return publicVoiceChange(await renameJob<VoiceChange>("voicechange", id, title, ownerId, "Recording"));
}

/** The row holding when each word of a spoken text was said. */
export const wordsRowId = (changeId: string) => `voicewords_${changeId}`;

/** Keeps a spoken text's word times beside it; false when the store would not take them. */
async function keepWords(change: VoiceChange, words: SpokenWord[]): Promise<boolean> {
  try {
    await getStore().put<VoiceChangeWords>("voicewords", { id: wordsRowId(change.id), changeId: change.id, ownerId: change.ownerId, words });
    return true;
  } catch (err) {
    console.error(`voice speech ${change.id}: word timings not kept:`, err);
    return false;
  }
}

/** Caption lines for text spoken in a voice, timed by when its words were said; a 404 when it has no timings. */
export async function voiceChangeCaptions(id: string, ownerId: string = LOCAL_OWNER): Promise<{ title: string; cues: Cue[] }> {
  const change = owned(await getStore().get<VoiceChange>("voicechange", voiceChangeIdSchema.parse(id)), ownerId, "Recording");
  const row = change.status === "completed" && change.timed ? await getStore().get<VoiceChangeWords>("voicewords", wordsRowId(change.id)) : null;
  if (!row?.words.length || row.ownerId !== ownerId) throw new NotFoundError("This recording has no word timings to make captions from");
  return { title: change.title, cues: wordCues(row.words) };
}

/** Keeps of a recording still being made, by recording, so a second click waits for the first rather than making two clips. */
const keeping = new Map<string, Promise<{ clip: AudioClip; existing: boolean }>>();

/**
 * Keeps a finished recording as one of the account's audio clips, so a scene can lip-sync to it and a lip sync can use it
 * after the renderer's link has expired. The renderer's file is read once, through the public-address guard, within the
 * clip limits. Keeping it again returns the clip already made while that clip exists.
 */
export async function keepVoiceChangeAsClip(id: string, ownerId: string = LOCAL_OWNER, fetchImpl?: FetchLike): Promise<{ clip: AudioClip; existing: boolean }> {
  const change = owned(await getStore().get<VoiceChange>("voicechange", voiceChangeIdSchema.parse(id)), ownerId, "Recording");
  const running = keeping.get(change.id);
  if (running) return running;
  const work = keepAsClip(change, ownerId, fetchImpl).finally(() => keeping.delete(change.id));
  keeping.set(change.id, work);
  return work;
}

async function keepAsClip(change: VoiceChange, ownerId: string, fetchImpl?: FetchLike): Promise<{ clip: AudioClip; existing: boolean }> {
  const kept = change.savedClipId ? await findClip(change.savedClipId, ownerId) : null;
  // A clip kept from spoken text before clips carried their words gets them now.
  if (kept) return { clip: !kept.transcript && change.text ? await addClipTranscript(kept, change.text) : kept, existing: true };
  if (change.status !== "completed" || !change.audioUrl) throw new ValidationError(`“${change.title}” is ${change.status === "failed" ? "a recording that could not be made" : "still being made"}; keep it once it is ready`);
  if (Date.now() - Date.parse(change.checkedAt ?? change.updatedAt) > VOICE_RESULT_LINK_MS) {
    throw new ValidationError(`“${change.title}” was made over an hour ago, and its link from the renderer has expired; make it again in the voice changer`);
  }
  // The demo's file is made here; a real renderer's is read from its link, which needs no key of the studio's.
  const demo = change.provider === "mock" ? getAvatarProviderByName("mock").demoSpeech : undefined;
  const smaller = change.text !== undefined && change.format !== "mp3" ? "; speak it again as an MP3, which is smaller, or in shorter parts" : "; make it from a shorter recording";
  const tooLarge = `“${change.title}” is too large to keep as an audio clip (${MAX_CLIP_BYTES / 1024 / 1024} MB at most)${smaller}`;
  let bytes: Uint8Array;
  if (demo) {
    bytes = demo(change.durationSec || 3);
  } else {
    let res: Response;
    try {
      res = await safeFetch(change.audioUrl, { redirect: "error", signal: AbortSignal.timeout(20_000) }, "Recording link", fetchImpl, { maxBytes: MAX_CLIP_BYTES });
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw new ValidationError(tooLarge);
      // A link the address guard refuses will not pass on a second try.
      if (err instanceof UnsafeUrlError) throw new ValidationError(`The renderer's link to “${change.title}” cannot be read from here; download it and upload it as a clip instead`);
      console.error(`voice change ${change.id}: recording not downloaded:`, err);
      throw new UpstreamError(`“${change.title}” could not be downloaded from the renderer just now; try again in a few minutes`);
    }
    // A signed link the renderer no longer honours answers 403 or 404; that one will not come back.
    if (res.status === 403 || res.status === 404 || res.status === 410) throw new ValidationError(`The renderer's link to “${change.title}” has expired; make it again in the voice changer`);
    if (!res.ok) throw new UpstreamError(`“${change.title}” could not be downloaded from the renderer just now (${res.status}); try again in a few minutes`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes.byteLength > MAX_CLIP_BYTES) throw new ValidationError(tooLarge);
  // The file's own bytes decide its kind; the renderer's content type is not trusted.
  const riff = bytes.byteLength >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
  const mimeType: AudioClipType | null = riff ? "audio/wav" : looksMp3(bytes) ? "audio/mpeg" : null;
  if (!mimeType) throw new ValidationError(`The renderer's file for “${change.title}” is not WAV or MP3 audio, so it cannot be kept as a clip`);
  // A WAV is kept only when its own header gives its length, as an uploaded one is; an MP3 takes the renderer's.
  const seconds = mimeType === "audio/wav" ? wavSeconds(bytes) : change.durationSec || null;
  if (mimeType === "audio/wav" && seconds === null) throw new ValidationError(`The renderer's WAV file for “${change.title}” is not one a clip can hold (PCM, 8 to 24 bits); speak it again as an MP3`);
  if (seconds === null) throw new ValidationError(`The length of “${change.title}” is not known, so it cannot be kept as a clip`);
  if (seconds > MAX_CLIP_SECONDS) throw new ValidationError(`“${change.title}” is longer than ${MAX_CLIP_SECONDS} seconds, the most a clip holds`);
  // Spoken text keeps its words, so a scene lip-syncing to the clip starts with them as its script (and its captions).
  const clip = await keepClip({ name: change.title.slice(0, 80), mimeType, bytes, seconds, transcript: change.text }, ownerId);
  // Remembered on the latest row (read again when a rename lands meanwhile), moving its time on so a rename that read
  // the row before this write misses and reads it again rather than dropping the clip (a finished recording's link is
  // dated by `checkedAt`); a recording deleted meanwhile stays deleted.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getStore().get<VoiceChange>("voicechange", change.id);
    if (!current || (await getStore().putIf("voicechange", { ...current, savedClipId: clip.id, updatedAt: nextUpdatedAt(current.updatedAt) }, "updatedAt", current.updatedAt))) break;
    if (attempt === 2) console.error(`voice change ${change.id}: kept changing while kept as clip ${clip.id}; the clip is not remembered on it`);
  }
  return { clip, existing: false };
}

const keyedId = (prefix: string, ownerId: string, key: string) => `${prefix}_${createHash("sha256").update(`${ownerId}\0${prefix}\0${key}`).digest("base64url").slice(0, 32)}`;

/** One of the account's clips, as the form names it when it is gone. */
async function clipOf(clipId: string, ownerId: string): Promise<AudioClip> {
  try {
    return await getClip(clipId, ownerId);
  } catch (err) {
    if (err instanceof NotFoundError) throw new ValidationError("That audio clip is no longer available; choose another or upload it again");
    throw err;
  }
}

/** The clip's upload at the renderer (made once, as for an audio scene). */
async function assetOf(clip: AudioClip, ownerId: string): Promise<string> {
  const provider = getAvatarProvider();
  if (!provider.prepareAudio) throw new ValidationError(`Audio clips cannot be sent to the ${provider.name} renderer`);
  const prepared = await prepareClipOnce(provider, clip, ownerId);
  const assetId = prepared.providerAssetIds?.[provider.assetKey ?? provider.name];
  if (!assetId) throw new Error(`The ${provider.name} renderer kept no upload of audio clip ${clip.id}`);
  return assetId;
}

const voiceChecks = jobChecker<InstantVoice>((v) => refreshInstantVoice(v));
const changeChecks = jobChecker<VoiceChange>((c) => refreshVoiceChange(c));

/** Forgets when voices and conversions were last asked about (tests). */
export function forgetVoiceChangerChecks(): void {
  voiceChecks.forget();
  changeChecks.forget();
  publicVoiceCache = null;
  publicVoiceLoad = null;
}

/** How long the renderer's public voices are kept before they are asked for again (their samples' links can expire). */
const PUBLIC_VOICES_MS = 10 * 60_000;
let publicVoiceCache: { provider: string; at: number; voices: PublicVoice[] } | null = null;
// One listing at a time: requests that arrive while it runs share it.
let publicVoiceLoad: { provider: string; voices: Promise<PublicVoice[]> } | null = null;

export function publicVoicesAvailable(): boolean {
  return typeof getAvatarProvider().publicVoices === "function";
}

/** The renderer's public voices to speak text in, by name; the same for every account, and kept for a few minutes. */
export async function listPublicVoices(): Promise<PublicVoice[]> {
  const provider = getAvatarProvider();
  if (!provider.publicVoices) return [];
  if (publicVoiceCache && publicVoiceCache.provider === provider.name && Date.now() - publicVoiceCache.at < PUBLIC_VOICES_MS) return publicVoiceCache.voices;
  if (publicVoiceLoad?.provider === provider.name) return publicVoiceLoad.voices;
  const list = provider.publicVoices.bind(provider);
  const entry = { provider: provider.name } as { provider: string; voices: Promise<PublicVoice[]> };
  entry.voices = (async () => {
    try {
      const voices = (await list())
        .map((v): PublicVoice => stripUndefined({ id: `pv_${v.voiceId}`, name: v.name, language: v.language, mode: v.mode, previewUrl: v.previewUrl }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // A failure is not kept, so the next request asks again.
      publicVoiceCache = { provider: provider.name, at: Date.now(), voices };
      return voices;
    } finally {
      if (publicVoiceLoad === entry) publicVoiceLoad = null;
    }
  })();
  publicVoiceLoad = entry;
  return entry.voices;
}

/** The account's instant voices, newest first; one still being made is asked about first. */
export async function listInstantVoices(ownerId: string = LOCAL_OWNER): Promise<InstantVoice[]> {
  const voices = await getStore().list<InstantVoice>("instantvoice", ownerId);
  // A made voice is asked about only while it is being made: it has no link to renew.
  const due = voices.filter((v) => v.status === "processing");
  const checked = new Map((await voiceChecks.follow(due)).map((v) => [v.id, v]));
  return voices.map((v) => checked.get(v.id) ?? v).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Makes an instant voice from one of the account's audio clips. With a client `key`, the voice's id is derived from the
 * account and the key, so a start retried after a lost answer returns the voice already made, and the renderer gets the
 * same idempotency key. `admit` runs once everything is checked, before the renderer is asked (the hourly limit).
 */
export async function createInstantVoice(input: z.infer<typeof instantVoiceSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<InstantVoice> {
  const id = opts.key ? keyedId("iv", ownerId, opts.key) : newId("iv");
  const existing = opts.key ? await getStore().get<InstantVoice>("instantvoice", id) : null;
  if (existing && existing.ownerId === ownerId) {
    if (existing.clipId !== input.clipId || (existing.askedName ?? existing.name) !== input.name || existing.settingPictureId !== input.settingPictureId) throw new ConflictError("This Idempotency-Key was already used for another voice; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (!provider.createInstantVoice) throw new ValidationError(`Instant voices are not available with the ${provider.name} renderer`);
  // Read then written: two starts at the same moment can between them pass the cap.
  const mine = await getStore().list<InstantVoice>("instantvoice", ownerId);
  if (mine.length >= MAX_INSTANT_VOICES) throw new ConflictError(`An account keeps at most ${MAX_INSTANT_VOICES} instant voices; delete one to make another`);
  // Two voices of one name cannot be told apart in the picker (which never offers one that failed).
  const name = input.name.trim().toLowerCase();
  if (mine.some((v) => v.status !== "failed" && v.name.trim().toLowerCase() === name)) throw new ConflictError(`You already have a voice named "${input.name}"; pick another name`);
  const clip = await clipOf(input.clipId, ownerId);
  const setting = input.settingPictureId ? await settingPicture(input.settingPictureId, ownerId) : undefined;
  opts.admit?.();
  const assetId = await assetOf(clip, ownerId);
  const { voiceId } = await provider.createInstantVoice({ name: input.name, assetId, ...(setting ? { image: setting.image } : {}), key: id });
  // Noted at once, whatever becomes of this record, so the renderer's voice listings never offer it to another account.
  await rememberMadeVoices([voiceId]);
  const now = nowIso();
  const voice: InstantVoice = { id, ownerId, name: input.name, clipId: clip.id, ...(setting ? { settingPictureId: setting.id, settingPictureName: setting.name } : {}), provider: provider.name, providerVoiceId: voiceId, status: "processing", createdAt: now, updatedAt: now };
  await getStore().put("instantvoice", voice);
  return voice;
}

/** One of the account's uploaded pictures, read for a voice's setting; one gone since is refused by name. */
async function settingPicture(id: string, ownerId: string): Promise<{ id: string; name: string; image: { mimeType: string; data: Uint8Array } }> {
  try {
    const picture = await getBackdrop(id, ownerId);
    const { mimeType, bytes } = await getBackdropImage(id, ownerId);
    return { id: picture.id, name: picture.name, image: { mimeType, data: bytes } };
  } catch (err) {
    if (err instanceof NotFoundError) throw new ValidationError("That picture is no longer available; choose another, or make the voice without one");
    throw err;
  }
}

/** Deletes an instant voice at the renderer and here; a voice the renderer would not delete is kept, to try again. */
export async function deleteInstantVoice(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const voice = owned(await getStore().get<InstantVoice>("instantvoice", instantVoiceIdSchema.parse(id)), ownerId, "Instant voice");
  await dropInstantVoice(voice);
  await getStore().remove("instantvoice", voice.id);
}

/**
 * A link to one of the account's voices reading a short preview script in its language. The renderer signs it for a
 * limited time, so it is asked for each time and never stored.
 */
export async function instantVoicePreview(id: string, ownerId: string = LOCAL_OWNER): Promise<string> {
  const voice = owned(await getStore().get<InstantVoice>("instantvoice", instantVoiceIdSchema.parse(id)), ownerId, "Instant voice");
  if (voice.status !== "completed") throw new ValidationError(voice.status === "failed" ? `The voice "${voice.name}" could not be made, so it has no preview` : `The voice "${voice.name}" is still being made; listen once it is ready`);
  const provider = getAvatarProviderByName(voice.provider);
  if (!provider.instantVoicePreview) throw new ValidationError(`Voice previews are not available with the ${provider.name} renderer`);
  const out = await provider.instantVoicePreview(voice.providerVoiceId);
  if (out.gone) {
    // It will not come back: marked failed, with why, so it is no longer offered for a recording or text.
    // Written over the latest row, so a rename landing meanwhile neither stops it nor is undone by it.
    const checkedAt = nowIso();
    await writeRefresh<InstantVoice>("instantvoice", voice, (current) => ({ ...current, status: "failed", error: out.gone, checkedAt }));
    throw new ValidationError(`The voice "${voice.name}" can no longer be used: ${out.gone}`);
  }
  if (!out.url) throw new ValidationError(`There is no preview of "${voice.name}" yet; try again in a moment`);
  return out.url;
}

/** Deletes a voice at the renderer, as its record goes (with the account too): it is a real person's voice. */
export async function dropInstantVoice(voice: InstantVoice): Promise<void> {
  try {
    await getAvatarProviderByName(voice.provider).deleteInstantVoice?.(voice.providerVoiceId);
  } catch (err) {
    console.error(`instant voice ${voice.id} was not deleted at the renderer:`, err);
    throw new ConflictError(`The renderer would not delete the voice "${voice.name}" just now, so it was kept (and anything removed before it stays removed); try again in a moment, or ask the operator if this repeats`);
  }
}

async function refreshInstantVoice(voice: InstantVoice): Promise<InstantVoice> {
  try {
    const provider = getAvatarProviderByName(voice.provider);
    if (!provider.instantVoiceStatus) return voice;
    const out = await provider.instantVoiceStatus(voice.providerVoiceId);
    const now = nowIso();
    // Built over the latest row (a rename may land while the renderer is asked), and written only over it.
    return await writeRefresh<InstantVoice>("instantvoice", voice, (current) => {
      const { error: _e, ...kept } = current;
      void _e;
      return { ...kept, ...stripUndefined(out), checkedAt: now };
    });
  } catch (err) {
    console.error(`instant voice check failed for ${voice.id}:`, err);
    return voice;
  }
}

/** The account's recordings spoken again, newest first; one still being spoken is asked for again first. */
export async function listVoiceChanges(ownerId: string = LOCAL_OWNER): Promise<VoiceChange[]> {
  const changes = await getStore().list<VoiceChange>("voicechange", ownerId);
  // A finished one is never asked about again: asking for an answer the renderer no longer keeps would pay again.
  const due = changes.filter((c) => c.status === "processing");
  const checked = new Map((await changeChecks.follow(due)).map((c) => [c.id, c]));
  return changes.map((c) => checked.get(c.id) ?? c).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Speaks one of the account's audio clips again in one of its instant voices. The renderer answers within a couple of
 * minutes; the start waits for most of that, and a conversion not done by then is asked for again (with the same key, so
 * it is not paid for twice) while the list is open. With a client `key`, a start retried after a lost answer returns the
 * conversion already started. `admit` runs once everything is checked, before the renderer is asked.
 */
export async function startVoiceChange(input: z.infer<typeof voiceChangeSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<VoiceChange> {
  const arrived = Date.now();
  const id = opts.key ? keyedId("vc", ownerId, opts.key) : newId("vc");
  const existing = opts.key ? await getStore().get<VoiceChange>("voicechange", id) : null;
  if (existing && existing.ownerId === ownerId) {
    const same = existing.voiceId === input.voiceId && existing.clipId === input.clipId && !!existing.removeNoise === input.removeNoise && (!input.title || (existing.askedTitle ?? existing.title) === input.title);
    if (!same) throw new ConflictError("This Idempotency-Key was already used for another recording; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (!provider.changeVoice) throw new ValidationError(`The voice changer is not available with the ${provider.name} renderer`);
  const voice = await readyVoice(input.voiceId, ownerId);
  const clip = await clipOf(input.clipId, ownerId);
  opts.admit?.();
  const assetId = await assetOf(clip, ownerId);
  const now = nowIso();
  const change: VoiceChange = stripUndefined({
    id,
    ownerId,
    title: input.title || withSuffix(clip.name, ` in ${voice.name}`, 120),
    voiceId: voice.id,
    voiceName: voice.name,
    clipId: clip.id,
    removeNoise: input.removeNoise ? (true as const) : undefined,
    provider: provider.name,
    providerVoiceId: voice.providerVoiceId,
    providerAudio: assetId,
    status: "processing" as const,
    durationSec: clip.durationSec,
    createdAt: now,
    updatedAt: now,
  });
  // Stored before the renderer is asked, so a start whose answer is lost is followed rather than forgotten.
  await getStore().put("voicechange", change);
  try {
    const waitMs = Math.max(MIN_WAIT_MS, START_DEADLINE_MS - (Date.now() - arrived));
    const out = await provider.changeVoice({ voiceId: voice.providerVoiceId, assetId, removeNoise: input.removeNoise, key: id, waitMs });
    if (out.status === "processing") return change;
    // Written over the latest row: a rename landing while the renderer speaks is kept, and a delete stays a delete.
    const checkedAt = nowIso();
    return await writeRefresh<VoiceChange>("voicechange", change, (current) => ({ ...current, status: "completed", audioUrl: out.audioUrl, durationSec: out.durationSec || clip.durationSec, checkedAt }));
  } catch (err) {
    // Refused (the renderer says no to this request): nothing was made, so nothing is kept. Anything else may still be
    // running at the renderer, so it is followed with the same key rather than forgotten.
    if (err instanceof ValidationError || err instanceof LimitError) {
      await getStore().remove("voicechange", change.id);
      throw err;
    }
    console.error(`voice change ${change.id} start failed; it is followed:`, err);
    return change;
  }
}

/** Room for one more recording, and one of the account's voices that is ready to speak. */
async function underChangeCap(ownerId: string): Promise<void> {
  if ((await getStore().list<VoiceChange>("voicechange", ownerId)).length >= MAX_VOICE_CHANGES) throw new ConflictError(`An account keeps at most ${MAX_VOICE_CHANGES} recordings in its voices; delete one to make another`);
}

/** One of the renderer's public voices to speak text in, still offered; Turbo and the boost only for an instant one. */
async function publicSpeaker(input: z.infer<typeof voiceSpeechSchema>, ownerId: string): Promise<{ id: string; name: string; providerVoiceId: string }> {
  await underChangeCap(ownerId);
  const voice = (await listPublicVoices()).find((v) => v.id === input.voiceId);
  if (!voice) throw new ValidationError("That HeyGen voice is no longer offered; choose another");
  if (voice.mode !== "instant" && (input.turbo || input.expressivenessBoost !== undefined)) throw new ValidationError(`Turbo (free or not) and the expressiveness boost are for instant voices, and ${voice.name} is not one; leave them out for this voice`);
  return { id: voice.id, name: voice.name, providerVoiceId: voice.id.slice("pv_".length) };
}

async function readyVoice(voiceId: string, ownerId: string): Promise<InstantVoice> {
  await underChangeCap(ownerId);
  let voice: InstantVoice;
  try {
    voice = owned(await getStore().get<InstantVoice>("instantvoice", voiceId), ownerId, "Instant voice");
  } catch (err) {
    if (err instanceof NotFoundError) throw new ValidationError("That voice is no longer available; choose another");
    throw err;
  }
  if (voice.status !== "completed") throw new ValidationError(voice.status === "failed" ? `The voice "${voice.name}" could not be made; choose another` : `The voice "${voice.name}" is still being made; try again in a moment`);
  return voice;
}

/**
 * Speaks text in one of the account's instant voices or one of the renderer's public voices, kept with the recordings spoken again. The record is stored before
 * the renderer is asked (so a start retried while the first is running returns it) and the start waits for most of a
 * minute; one not done by then is not asked for again (see `SPEECH_GIVE_UP_MS`) but dropped, with a 502 to try again.
 * With a client `key`, a start retried after a lost answer returns what was spoken.
 */
export async function startVoiceSpeech(input: z.infer<typeof voiceSpeechSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<VoiceChange> {
  const arrived = Date.now();
  const id = opts.key ? keyedId("vc", ownerId, opts.key) : newId("vc");
  const existing = opts.key ? await getStore().get<VoiceChange>("voicechange", id) : null;
  if (existing && existing.ownerId === ownerId) {
    // A boost of 1 is HeyGen's default, so one stored as 1 (as an earlier version did) is the same delivery as none.
    const sameDelivery = existing.turbo === input.turbo && existing.free === input.free && existing.format === input.format && pronunciationLanguage(existing.language) === pronunciationLanguage(input.language) && (existing.expressivenessBoost ?? 1) === (input.expressivenessBoost ?? 1);
    if (existing.voiceId !== input.voiceId || existing.text !== input.text || !sameDelivery || (input.title && (existing.askedTitle ?? existing.title) !== input.title)) throw new ConflictError("This Idempotency-Key was already used for another recording; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (!provider.speakText) throw new ValidationError(`Text to speech is not available with the ${provider.name} renderer`);
  const voice = input.voiceId.startsWith("pv_") ? await publicSpeaker(input, ownerId) : await readyVoice(input.voiceId, ownerId);
  opts.admit?.();
  const now = nowIso();
  const change: VoiceChange = {
    id,
    ownerId,
    title: input.title || withSuffix(speechTitle(input.text), ` in ${voice.name}`, 120),
    voiceId: voice.id,
    voiceName: voice.name,
    text: input.text,
    ...(input.turbo ? { turbo: true as const } : {}),
    ...(input.free ? { free: true as const } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.expressivenessBoost !== undefined ? { expressivenessBoost: input.expressivenessBoost } : {}),
    provider: provider.name,
    providerVoiceId: voice.providerVoiceId,
    status: "processing",
    createdAt: now,
    updatedAt: now,
  };
  await getStore().put("voicechange", change);
  try {
    const waitMs = Math.max(MIN_WAIT_MS, START_DEADLINE_MS - (Date.now() - arrived));
    const out = await provider.speakText({ voiceId: voice.providerVoiceId, text: input.text, ...(input.turbo ? { turbo: true as const } : {}), ...(input.free ? { free: true as const } : {}), ...(input.format ? { mp3: true as const } : {}), ...(input.language ? { language: pronunciationLanguage(input.language) } : {}), ...(input.expressivenessBoost !== undefined ? { expressivenessBoost: input.expressivenessBoost } : {}), key: id, waitMs });
    // A free request not answered (a failure of HeyGen's shared free capacity, or no answer in time) is free speech's.
    if (out.status === "processing") throw new UpstreamError(input.free ? "HeyGen's free speech did not answer; try again, or speak the text without Free" : "HeyGen did not finish speaking the text in time; try again, or try a shorter text");
    // The words' times go in a row of their own first; a store that will not take them (a database whose kinds
    // predate them) keeps the speech without captions rather than failing it.
    const timed = out.words?.length ? await keepWords(change, out.words) : false;
    // Written over the latest row: a rename landing while the renderer speaks is kept (a speech not stored as done here
    // is never asked for again), and a delete meanwhile stays a delete, without its words.
    const checkedAt = nowIso();
    const stored = await writeRefresh<VoiceChange>("voicechange", change, (current) => ({ ...current, status: "completed", audioUrl: out.audioUrl, ...(out.durationSec ? { durationSec: out.durationSec } : {}), ...(timed ? { timed: true as const } : {}), ...(out.spokenLanguage ? { spokenLanguage: out.spokenLanguage } : {}), checkedAt }));
    if (stored.status !== "completed" && timed) await getStore().remove("voicewords", wordsRowId(change.id));
    return stored;
  } catch (err) {
    // Nothing to follow: a refusal made nothing, and anything else is not asked again.
    await getStore().remove("voicechange", change.id);
    if (!(err instanceof ValidationError || err instanceof LimitError || err instanceof UpstreamError)) console.error(`voice speech ${change.id} start failed:`, err);
    // The renderer's words are about the account's own voices; a public voice gone is chosen again, not made again.
    if (input.voiceId.startsWith("pv_") && err instanceof ValidationError) {
      if (/no longer has this voice/.test(err.message)) {
        publicVoiceCache = null;
        throw new ValidationError("That HeyGen voice is no longer offered; choose another");
      }
      if (/may not use instant voices/.test(err.message)) throw new ValidationError("The HeyGen account behind this studio may not use HeyGen's voices; ask its operator");
    }
    throw err;
  }
}

/** Punctuation that closes a phrase: stops, ellipses, closing quotes and brackets, and the spaces before them. */
const CLOSING = /[\s,.;:!?…"'”’»)\]}-]+$/u;

/** The first words of a text, as a title: up to about 40 characters, cut at a word and marked when cut, without closing punctuation. */
function speechTitle(text: string): string {
  const chars = graphemes(text.replace(/\s+/g, " ").trim());
  // A whole text keeps its words without the closing punctuation ("Hi there in Narrator", not "Hi there. in Narrator").
  if (chars.length <= 40) return chars.join("").replace(CLOSING, "") || chars.join("");
  const cut = chars.slice(0, 40);
  const space = cut.lastIndexOf(" ");
  const words = cut.slice(0, space > 20 ? space : 40).join("");
  // Cut back to the last word, without trailing punctuation; a text of punctuation alone keeps its first characters.
  return `${words.replace(CLOSING, "") || words}…`;
}

/** Forgets one recording spoken again (the renderer's copy expires on its own). */
export async function deleteVoiceChange(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const change = owned(await getStore().get<VoiceChange>("voicechange", voiceChangeIdSchema.parse(id)), ownerId, "Recording");
  await getStore().remove("voicechange", change.id);
  if (change.timed) await getStore().remove("voicewords", wordsRowId(change.id));
}

/** Asks the renderer again for a conversion still running (same key, so not paid twice). Never throws. */
async function refreshVoiceChange(change: VoiceChange): Promise<VoiceChange> {
  const now = nowIso();
  let next: Partial<VoiceChange>;
  try {
    const age = Date.now() - Date.parse(change.createdAt);
    const giveUp: Partial<VoiceChange> = { status: "failed", error: `The renderer did not finish speaking this ${change.text !== undefined ? "text" : "recording"}; try again`, checkedAt: now };
    if (age > KEY_KEPT_MS || (change.text !== undefined && age > SPEECH_GIVE_UP_MS)) {
      next = giveUp;
    } else if (change.text !== undefined) {
      // Its start is still waiting for the renderer; it finishes it, or this gives it up.
      return change;
    } else {
      // Asked even when long unanswered (a page closed meanwhile): a finished one is returned under its key, unpaid.
      const provider = getAvatarProviderByName(change.provider);
      if (!provider.changeVoice || !change.providerAudio) return change;
      const out = await provider.changeVoice({ voiceId: change.providerVoiceId, assetId: change.providerAudio, removeNoise: !!change.removeNoise, key: change.id, waitMs: CHECK_WAIT_MS });
      if (out.status === "completed") next = { status: "completed", audioUrl: out.audioUrl, durationSec: out.durationSec || change.durationSec, checkedAt: now };
      else next = age > GIVE_UP_MS ? giveUp : { checkedAt: now };
    }
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      console.error(`voice change check failed for ${change.id}:`, err);
      return change;
    }
    next = { status: "failed", error: err.message, checkedAt: now };
  }
  // Built over the latest row (a rename may land while the renderer is asked), and written only over it; one its start
  // finished meanwhile keeps that answer rather than this check's.
  return await writeRefresh<VoiceChange>("voicechange", change, (current) => (current.status === "processing" ? { ...current, ...next } : current));
}
