// The voice changer: instant voices made at the renderer from one recording of a person (HeyGen Voice's instant clone),
// and recordings spoken again in one of them, the words and timing kept (HeyGen's speech to speech). Each voice is the
// account's own: the renderer's shared account holds it under the studio's mark, and no other account is offered it.
// Used by API routes only.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import type { AudioClip, InstantVoice, VoiceChange } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, LimitError, NotFoundError, UpstreamError, ValidationError } from "../errors";
import { owned, stripUndefined } from "./shared";
import { getClip } from "./clips";
import { prepareClipOnce } from "./videos";
import { rememberMadeVoices } from "./voices";
import { jobChecker } from "./job-checks";
import { graphemes, withSuffix } from "../text";

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
});

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
  voiceId: z.string({ error: "Choose one of your instant voices" }).regex(/^iv_[A-Za-z0-9_-]{1,64}$/, "Choose one of your instant voices"),
  text: z.string({ error: "Write the text to speak" }).trim().min(1, "Write the text to speak").max(MAX_SPEECH_CHARS, `Keep the text to ${MAX_SPEECH_CHARS.toLocaleString("en-US")} characters`),
  title: z.string().trim().max(120, "Keep the title to 120 characters").optional(),
});

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
export type PublicInstantVoice = Omit<InstantVoice, "ownerId" | "provider" | "providerVoiceId">;
export type PublicVoiceChange = Omit<VoiceChange, "ownerId" | "provider" | "providerVoiceId" | "providerAudio">;
export function publicInstantVoice(v: InstantVoice): PublicInstantVoice {
  const { ownerId: _o, provider: _p, providerVoiceId: _v, ...rest } = v;
  void _o;
  void _p;
  void _v;
  return rest;
}
export function publicVoiceChange(c: VoiceChange): PublicVoiceChange {
  const { ownerId: _o, provider: _p, providerVoiceId: _v, providerAudio: _a, ...rest } = c;
  void _o;
  void _p;
  void _v;
  void _a;
  return rest;
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
    if (existing.clipId !== input.clipId || existing.name !== input.name) throw new ConflictError("This Idempotency-Key was already used for another voice; send a new key");
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
  opts.admit?.();
  const assetId = await assetOf(clip, ownerId);
  const { voiceId } = await provider.createInstantVoice({ name: input.name, assetId, key: id });
  // Noted at once, whatever becomes of this record, so the renderer's voice listings never offer it to another account.
  await rememberMadeVoices([voiceId]);
  const now = nowIso();
  const voice: InstantVoice = { id, ownerId, name: input.name, clipId: clip.id, provider: provider.name, providerVoiceId: voiceId, status: "processing", createdAt: now, updatedAt: now };
  await getStore().put("instantvoice", voice);
  return voice;
}

/** Deletes an instant voice at the renderer and here; a voice the renderer would not delete is kept, to try again. */
export async function deleteInstantVoice(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const voice = owned(await getStore().get<InstantVoice>("instantvoice", instantVoiceIdSchema.parse(id)), ownerId, "Instant voice");
  await dropInstantVoice(voice);
  await getStore().remove("instantvoice", voice.id);
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
    const { error: _e, ...kept } = voice;
    void _e;
    const next: InstantVoice = { ...kept, ...stripUndefined(out), checkedAt: now, updatedAt: out.status !== voice.status ? now : voice.updatedAt };
    return (await getStore().putIf("instantvoice", next, "updatedAt", voice.updatedAt)) ? next : voice;
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
    const same = existing.voiceId === input.voiceId && existing.clipId === input.clipId && !!existing.removeNoise === input.removeNoise && (!input.title || existing.title === input.title);
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
    const done: VoiceChange = { ...change, status: "completed", audioUrl: out.audioUrl, durationSec: out.durationSec || clip.durationSec, checkedAt: nowIso(), updatedAt: nowIso() };
    return (await getStore().putIf("voicechange", done, "updatedAt", change.updatedAt)) ? done : change;
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
async function readyVoice(voiceId: string, ownerId: string): Promise<InstantVoice> {
  if ((await getStore().list<VoiceChange>("voicechange", ownerId)).length >= MAX_VOICE_CHANGES) throw new ConflictError(`An account keeps at most ${MAX_VOICE_CHANGES} recordings in its voices; delete one to make another`);
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
 * Speaks text in one of the account's instant voices, kept with the recordings spoken again. The record is stored before
 * the renderer is asked (so a start retried while the first is running returns it) and the start waits for most of a
 * minute; one not done by then is not asked for again (see `SPEECH_GIVE_UP_MS`) but dropped, with a 502 to try again.
 * With a client `key`, a start retried after a lost answer returns what was spoken.
 */
export async function startVoiceSpeech(input: z.infer<typeof voiceSpeechSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<VoiceChange> {
  const arrived = Date.now();
  const id = opts.key ? keyedId("vc", ownerId, opts.key) : newId("vc");
  const existing = opts.key ? await getStore().get<VoiceChange>("voicechange", id) : null;
  if (existing && existing.ownerId === ownerId) {
    if (existing.voiceId !== input.voiceId || existing.text !== input.text || (input.title && existing.title !== input.title)) throw new ConflictError("This Idempotency-Key was already used for another recording; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (!provider.speakText) throw new ValidationError(`Text to speech in an instant voice is not available with the ${provider.name} renderer`);
  const voice = await readyVoice(input.voiceId, ownerId);
  opts.admit?.();
  const now = nowIso();
  const change: VoiceChange = {
    id,
    ownerId,
    title: input.title || withSuffix(speechTitle(input.text), ` in ${voice.name}`, 120),
    voiceId: voice.id,
    voiceName: voice.name,
    text: input.text,
    provider: provider.name,
    providerVoiceId: voice.providerVoiceId,
    status: "processing",
    createdAt: now,
    updatedAt: now,
  };
  await getStore().put("voicechange", change);
  try {
    const waitMs = Math.max(MIN_WAIT_MS, START_DEADLINE_MS - (Date.now() - arrived));
    const out = await provider.speakText({ voiceId: voice.providerVoiceId, text: input.text, key: id, waitMs });
    if (out.status === "processing") throw new UpstreamError("HeyGen did not finish speaking the text in time; try again, or try a shorter text");
    const done: VoiceChange = { ...change, status: "completed", audioUrl: out.audioUrl, ...(out.durationSec ? { durationSec: out.durationSec } : {}), checkedAt: nowIso(), updatedAt: nowIso() };
    return (await getStore().putIf("voicechange", done, "updatedAt", change.updatedAt)) ? done : change;
  } catch (err) {
    // Nothing to follow: a refusal made nothing, and anything else is not asked again.
    await getStore().remove("voicechange", change.id);
    if (!(err instanceof ValidationError || err instanceof LimitError || err instanceof UpstreamError)) console.error(`voice speech ${change.id} start failed:`, err);
    throw err;
  }
}

/** The first words of a text, as a title: up to about 40 characters, cut at a word and marked when cut, without closing punctuation. */
function speechTitle(text: string): string {
  const chars = graphemes(text.replace(/\s+/g, " ").trim());
  // A whole text keeps its words without the closing punctuation ("Hi there in Narrator", not "Hi there. in Narrator").
  if (chars.length <= 40) return chars.join("").replace(/[\s,.;:!?-]+$/, "") || chars.join("");
  const cut = chars.slice(0, 40);
  const space = cut.lastIndexOf(" ");
  const words = cut.slice(0, space > 20 ? space : 40).join("");
  // Cut back to the last word, without trailing punctuation; a text of punctuation alone keeps its first characters.
  return `${words.replace(/[\s,.;:!?-]+$/, "") || words}…`;
}

/** Forgets one recording spoken again (the renderer's copy expires on its own). */
export async function deleteVoiceChange(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const change = owned(await getStore().get<VoiceChange>("voicechange", voiceChangeIdSchema.parse(id)), ownerId, "Recording");
  await getStore().remove("voicechange", change.id);
}

/** Asks the renderer again for a conversion still running (same key, so not paid twice). Never throws. */
async function refreshVoiceChange(change: VoiceChange): Promise<VoiceChange> {
  const now = nowIso();
  let next: VoiceChange;
  try {
    const age = Date.now() - Date.parse(change.createdAt);
    const giveUp: VoiceChange = { ...change, status: "failed", error: `The renderer did not finish speaking this ${change.text !== undefined ? "text" : "recording"}; try again`, checkedAt: now, updatedAt: now };
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
      if (out.status === "completed") next = { ...change, status: "completed", audioUrl: out.audioUrl, durationSec: out.durationSec || change.durationSec, checkedAt: now, updatedAt: now };
      else next = age > GIVE_UP_MS ? giveUp : { ...change, checkedAt: now };
    }
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      console.error(`voice change check failed for ${change.id}:`, err);
      return change;
    }
    next = { ...change, status: "failed", error: err.message, checkedAt: now, updatedAt: now };
  }
  return (await getStore().putIf("voicechange", next, "updatedAt", change.updatedAt)) ? next : change;
}
