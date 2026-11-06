// Digital twins: a presenter trained from footage of a real person (HeyGen digital twin). The renderer trains a look from
// the footage; the person in it records their consent on the renderer's page; once both are done, the twin is kept as a
// photo avatar of the account. Used by API routes only.
import { z } from "zod";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName, getTtsProvider } from "../providers";
import type { Avatar, TwinJob, Voice } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPublicHttpUrl } from "../safe-url";
import { loadImage } from "../providers/image";
import type { FetchLike } from "../safe-fetch";
import { notifyTwinTransition } from "../notifications";
import { afterResponse, owned } from "./shared";
import { MAX_PORTRAIT_BYTES, rememberMadeLooks } from "./avatars";
import { jobChecker } from "./job-checks";
import { rememberMadeVoices } from "./voices";
import { withSuffix } from "../text";
import { config } from "../config";
import type { TwinFootage } from "../providers/types";

/** Digital twins an account keeps (each one becomes a presenter); another needs one forgotten first. */
export const MAX_TWINS = 10;
/** A consent page lasts this long at the renderer; a new one can be asked for after. */
export const CONSENT_LINK_MS = 24 * 60 * 60 * 1000;
/** A start whose answer is not stored yet is left to the request sending it for this long, then asked for again. */
export const TWIN_RESERVATION_MS = 2 * 60 * 1000;
/** The renderer replays a start's answer for its key this long; a start still unanswered after it is given up. */
export const TWIN_REPLAY_MS = 24 * 60 * 60 * 1000;
/** A start whose answer was lost is asked for again at most this often, however often the twins are listed. */
export const TWIN_RESEND_MS = 5 * 60 * 1000;
const STILL_SENDING = "This twin is still being sent to the renderer; try again in a moment";

export const twinRequestSchema = z
  .object({
    name: z.string().trim().min(1, "Give the twin a name").max(80),
    /** A public https link to the footage: one person speaking to camera, 15 seconds to 10 minutes. */
    footageUrl: z.string().trim().max(2000, "The link is too long").optional(),
    /** Or the `token` of footage uploaded from the browser (`POST /api/twins/uploads`), once its file is sent. */
    upload: z.string().max(4000, "Unknown upload").optional(),
    gender: z.enum(["female", "male"]).optional(),
    /** The account says the person in the footage agreed to be made into a twin (they also record consent at the renderer). */
    agreed: z.literal(true, { message: "Confirm that the person in the footage agreed to be made into a digital twin" }),
  })
  .refine((v) => (v.footageUrl === undefined) !== (v.upload === undefined), { message: "Paste a public https link to the footage, or upload a video file (one of them)" });

/** Footage a browser may upload straight to the renderer: HeyGen's direct upload takes video up to 200 MiB. */
export const MAX_TWIN_UPLOAD_BYTES = 200 * 1024 * 1024;
export const TWIN_UPLOAD_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
/** An upload's token is good for this long to start a new twin (a retried start of the same twin takes it later too). */
export const TWIN_UPLOAD_MS = 24 * 60 * 60 * 1000;

export const twinUploadRequestSchema = z.object({
  fileName: z.string().trim().min(1, "Choose a video file").max(200, "The file name is too long"),
  contentType: z.enum(TWIN_UPLOAD_TYPES, { message: "Choose an MP4, MOV, or WebM video" }),
  sizeBytes: z.number().int().min(1, "The file is empty").max(MAX_TWIN_UPLOAD_BYTES, "The file is over 200 MB; trim or compress it first"),
});

/** What an upload's token vouches for: the account, the renderer, its asset there, the file's name and size, and until when. */
type UploadClaim = { o: string; p: string; a: string; n: string; s: number; e: number };

/** Signs tokens where no server secret is set (demo mode): this instance's own, so no one else can sign them. */
const PROCESS_SECRET = randomBytes(32).toString("hex");

/**
 * The key upload tokens are signed with, from a server secret (the renderer's key, else the database's), so tokens
 * cannot be made outside the server. Deployments sharing that secret accept each other's tokens for the same account.
 */
function uploadKey(): Buffer {
  const secret = config.heygenApiKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? PROCESS_SECRET;
  return createHash("sha256").update(`avatar-studio twin upload\0${secret}`).digest();
}

function signUpload(claim: UploadClaim): string {
  const body = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${body}.${createHmac("sha256", uploadKey()).update(body).digest("base64url")}`;
}

/** Refuses an upload's token past its time (checked only for a new start, so a retried one still finds its twin). */
function assertFresh(claim: UploadClaim, now = Date.now()): void {
  if (!(claim.e > now)) throw new ValidationError("That upload is not this account's, or it expired; upload the file again");
}

/** The upload a token names, if it was signed here for this account and renderer (its time is checked by `assertFresh`). */
function readUpload(token: string, ownerId: string, providerName: string): UploadClaim {
  const refused = new ValidationError("That upload is not this account's, or it expired; upload the file again");
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) throw refused;
  const expected = createHmac("sha256", uploadKey()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw refused;
  let claim: UploadClaim;
  try {
    claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadClaim;
  } catch {
    throw refused;
  }
  if (claim.o !== ownerId || claim.p !== providerName || typeof claim.a !== "string" || !claim.a || typeof claim.e !== "number") throw refused;
  return claim;
}

/** Whether footage can be uploaded from the browser with the renderer in use (else it is pasted as a link). */
export function twinUploadsAvailable(): boolean {
  const provider = getAvatarProvider();
  return typeof provider.startTwinUpload === "function" && typeof provider.finishTwinUpload === "function";
}

/**
 * Begins uploading footage for a twin: the renderer's link the browser sends the file to (with the headers it must
 * carry), and a token that names the upload to `startTwin`. The file never passes through this server. With a client
 * `key`, a retried call returns the same upload. `admit` runs once the request is checked (the hourly limit).
 */
export async function startTwinUpload(
  input: z.infer<typeof twinUploadRequestSchema>,
  ownerId: string = LOCAL_OWNER,
  opts: { key?: string; admit?: () => void } = {},
): Promise<{ token: string; url: string; headers: Record<string, string>; expiresAt: string }> {
  const provider = getAvatarProvider();
  if (!provider.startTwinUpload || !provider.finishTwinUpload) throw new ValidationError(`Uploading footage is not available with the ${provider.name} renderer; paste a link to it instead`);
  // Refused before a large file is sent for nothing.
  if ((await getStore().list<TwinJob>("twin", ownerId)).length >= MAX_TWINS) throw new ConflictError(`An account keeps at most ${MAX_TWINS} digital twins; forget one to train another`);
  opts.admit?.();
  const key = `twu_${createHash("sha256").update(`${ownerId}\0${opts.key ?? newId("k")}`).digest("base64url").slice(0, 40)}`;
  const out = await provider.startTwinUpload({ fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes, key });
  // The token outlives the upload link: once the file is sent, the asset is the renderer's until it is deleted.
  const expires = Date.now() + TWIN_UPLOAD_MS;
  const token = signUpload({ o: ownerId, p: provider.name, a: out.assetId, n: input.fileName, s: input.sizeBytes, e: expires });
  return { token, url: out.uploadUrl, headers: out.uploadHeaders, expiresAt: new Date(expires).toISOString() };
}

/** The footage a twin was started from, as the renderer is sent it. */
function footageOf(job: TwinJob): TwinFootage {
  return job.footageAssetId ? { assetId: job.footageAssetId } : { url: job.footageUrl ?? "" };
}

export const twinIdSchema = z.string().regex(/^tw_[A-Za-z0-9_-]{1,64}$/, "Unknown digital twin");

/** A client's key for one start (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const twinKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function twinsAvailable(): boolean {
  return typeof getAvatarProvider().startTwin === "function";
}

/** What the account sees of a twin: never the renderer, its look, or its character, which stay on the server. */
export type PublicTwin = Omit<TwinJob, "ownerId" | "provider" | "lookId" | "groupId" | "voiceId" | "imageUrl" | "footageAssetId"> & { consentLinkExpired?: true };
/**
 * What the account sees of a twin. The consent link is the person's to record consent with, so only an account that
 * may edit sees it (`canEdit` false hides it from viewers of a workspace).
 */
export function publicTwin(job: TwinJob, now = Date.now(), canEdit = true): PublicTwin {
  const { ownerId: _o, provider: _p, lookId: _l, groupId: _g, voiceId: _v, imageUrl: _i, footageAssetId: _a, ...rest } = job;
  void _a;
  void _o;
  void _p;
  void _l;
  void _g;
  void _v;
  void _i;
  // A link past its day is not offered; a new one is asked for instead.
  const expired = !!job.consentUrlAt && now - Date.parse(job.consentUrlAt) > CONSENT_LINK_MS && job.consent !== "accepted";
  if (!expired && canEdit) return rest;
  const { consentUrl: _u, ...withoutLink } = rest;
  void _u;
  return expired ? { ...withoutLink, consentLinkExpired: true } : withoutLink;
}

/** The finished twin's picture is fetched through this (tests swap it). */
let fetchPictures: FetchLike | undefined;
export function setTwinPictureFetch(impl: FetchLike | undefined): void {
  fetchPictures = impl;
}

const checks = jobChecker<TwinJob>((job) => refreshTwin(job));

/** Forgets when twins were last asked about (tests). */
export function forgetTwinChecks(): void {
  checks.forget();
}

/** The account's digital twins, newest first; one still being trained or consented to is asked about first. */
export async function listTwins(ownerId: string = LOCAL_OWNER): Promise<TwinJob[]> {
  const jobs = await getStore().list<TwinJob>("twin", ownerId);
  return (await checks.follow(jobs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Twins the scheduled background check asks about at most per run, across every account. */
export const BACKGROUND_TWIN_CHECKS = 20;

/**
 * The scheduled background check: twins still being trained or consented to, across every account, asked about the
 * way a listing would (the least recently asked first, at most every few seconds each), so a twin nobody is watching
 * still becomes a presenter and its webhook is sent. Returns how many were asked about and how many finished.
 */
export async function checkTwinsInBackground(max = BACKGROUND_TWIN_CHECKS, now = Date.now()): Promise<{ checked: number; moved: number }> {
  const waiting = (await getStore().list<TwinJob>("twin")).filter((j) => j.status === "processing");
  const { jobs: after, checked } = await checks.followCounted(waiting, now, max);
  return { checked, moved: after.filter((j, i) => j.status !== waiting[i].status).length };
}

/**
 * Starts training a twin from a public link to the footage, or from a file uploaded to the renderer (the upload's
 * token, once the browser has sent the file; it is finished at the renderer first, `finish` counting each time).
 * With a client `key`, the twin's id is derived from the
 * account and the key, so a retried start returns the twin already stored. The row is kept before the renderer is asked
 * (with the twin's id as its key), so an answer lost on the way back is asked for again, from a retry or a later check,
 * and the look and voice it made are never left unknown. `admit` runs once the request is checked (the hourly limit).
 */
export async function startTwin(input: z.infer<typeof twinRequestSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void; finish?: () => void } = {}): Promise<TwinJob> {
  const id = opts.key ? `tw_${createHash("sha256").update(`${ownerId}\0${opts.key}`).digest("base64url").slice(0, 32)}` : newId("tw");
  const provider = getAvatarProvider();
  const upload = input.upload !== undefined ? readUpload(input.upload, ownerId, provider.name) : undefined;
  const existing = opts.key ? await getStore().get<TwinJob>("twin", id) : null;
  if (existing && existing.ownerId === ownerId) {
    if (existing.footageUrl !== input.footageUrl || existing.footageAssetId !== upload?.a || existing.name !== input.name) throw new ConflictError("This Idempotency-Key was already used for another twin; send a new key");
    if (existing.lookId || existing.status !== "processing") return existing;
    if (!dueForResend(existing)) throw new ConflictError(STILL_SENDING);
    return (await resend(existing)) ?? existing;
  }
  if (!provider.startTwin) throw new ValidationError(`Digital twins are not available with the ${provider.name} renderer`);
  if (upload) assertFresh(upload);
  const url = input.footageUrl;
  if (url !== undefined) {
    // The renderer downloads the footage itself, so it must be a public https address (not this network's, say).
    if (!/^https:\/\/[^\s]+$/i.test(url) || !URL.canParse(url)) throw new ValidationError("Paste a public https link to the footage");
    // A name and password in the link would be kept with the twin and shown back; a public link needs none.
    if (new URL(url).username || new URL(url).password) throw new ValidationError("Paste the link to the footage without a name or password in it");
    try {
      await assertPublicHttpUrl(url, "The link to the footage");
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : "Paste a public https link to the footage");
    }
  }
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<TwinJob>("twin", ownerId)).length >= MAX_TWINS) throw new ConflictError(`An account keeps at most ${MAX_TWINS} digital twins; forget one to train another`);
  // An uploaded file becomes usable once finished at the renderer; one it never received is refused here, uncounted.
  if (upload) {
    if (!provider.finishTwinUpload) throw new ValidationError(`Uploading footage is not available with the ${provider.name} renderer; paste a link to it instead`);
    // Its own limit: a finish refused afterwards (a file not yet received) asks the renderer all the same.
    opts.finish?.();
    await provider.finishTwinUpload(upload.a);
  }
  opts.admit?.();
  const now = nowIso();
  const job: TwinJob = {
    id,
    ownerId,
    name: input.name,
    ...(input.gender ? { gender: input.gender } : {}),
    ...(upload ? { footageAssetId: upload.a, footageFile: { name: upload.n, sizeBytes: upload.s } } : { footageUrl: url }),
    provider: provider.name,
    lookId: "",
    groupId: "",
    training: "processing",
    consent: "not_requested",
    status: "processing",
    createdAt: now,
    updatedAt: now,
  };
  // Kept first: a key some other account used maps to another id, and one sent twice at once is refused here.
  if (!(await getStore().insert("twin", job))) throw new ConflictError(STILL_SENDING);
  let out: Awaited<ReturnType<NonNullable<typeof provider.startTwin>>>;
  try {
    out = await provider.startTwin({ name: input.name, footage: footageOf(job), key: id });
  } catch (err) {
    // A refusal made nothing; any other failure may have been an answer lost, asked for again later.
    if (err instanceof ValidationError) await getStore().remove("twin", id);
    throw err;
  }
  return (await keepStart(job, out)) ?? job;
}

/** Sends the owner's webhook, after the response, for a twin a write just moved to completed or failed. */
async function announce(prev: TwinJob, next: TwinJob): Promise<void> {
  if (next.status !== prev.status) await afterResponse(() => notifyTwinTransition(prev, next));
}

/** Stores what the renderer made for a start (the look, character, and voice), noted as the studio's first. */
async function keepStart(job: TwinJob, out: { lookId: string; groupId: string; voiceId?: string }): Promise<TwinJob | null> {
  // The look and voice are the studio's in the renderer's shared account from now on, whatever becomes of this twin.
  await Promise.all([rememberMadeLooks([out.lookId]), rememberMadeVoices([out.voiceId])]);
  const next: TwinJob = { ...job, lookId: out.lookId, groupId: out.groupId, ...(out.voiceId ? { voiceId: out.voiceId } : {}), updatedAt: nowIso() };
  if (await getStore().putIf("twin", next, "updatedAt", job.updatedAt)) return next;
  // Forgotten while it was being sent: the voice is nobody's, so it goes (the look stays the studio's, never offered).
  if (!(await getStore().get<TwinJob>("twin", job.id))) await dropVoice(job.provider, out.voiceId);
  return null;
}

/** Whether a start whose answer was never stored may be asked for again: past the first request's time, and not too often. */
function dueForResend(job: TwinJob, now = Date.now()): boolean {
  return now - Date.parse(job.createdAt) >= TWIN_RESERVATION_MS && (!job.resentAt || now - Date.parse(job.resentAt) >= TWIN_RESEND_MS);
}

/**
 * Asks the renderer again for a start whose answer was never stored, with the same key, so it answers with the twin it
 * made, or makes it now. Past the renderer's replay window, or when it refuses, the twin is marked failed; any other
 * failure is noted (`resentAt`), so it is asked again only a few minutes later, and thrown.
 */
async function resend(job: TwinJob): Promise<TwinJob | null> {
  const failed = (error: string): TwinJob => ({ ...job, training: "failed", status: "failed", error, updatedAt: nowIso() });
  if (Date.now() - Date.parse(job.createdAt) > TWIN_REPLAY_MS) {
    const next = failed("The renderer never confirmed this twin; train it again");
    if (!(await getStore().putIf("twin", next, "updatedAt", job.updatedAt))) return null;
    await announce(job, next);
    return next;
  }
  const provider = getAvatarProviderByName(job.provider);
  if (!provider.startTwin) return null;
  try {
    return await keepStart(job, await provider.startTwin({ name: job.name, footage: footageOf(job), key: job.id }));
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      const at = nowIso();
      await getStore().putIf("twin", { ...job, resentAt: at, updatedAt: at }, "updatedAt", job.updatedAt);
      throw err;
    }
    const next = failed(err.message);
    if (!(await getStore().putIf("twin", next, "updatedAt", job.updatedAt))) return null;
    await announce(job, next);
    return next;
  }
}

/**
 * A twin whose start answer was never stored is asked for once more (at once, while the renderer still replays its
 * key) before it is forgotten, so the voice it made is known and can be deleted; never throws.
 */
async function settle(job: TwinJob): Promise<TwinJob> {
  if (job.lookId || job.status !== "processing" || Date.now() - Date.parse(job.createdAt) > TWIN_REPLAY_MS) return job;
  const provider = getAvatarProviderByName(job.provider);
  try {
    const out = await provider.startTwin?.({ name: job.name, footage: footageOf(job), key: job.id });
    if (!out) return job;
    await Promise.all([rememberMadeLooks([out.lookId]), rememberMadeVoices([out.voiceId])]);
    return { ...job, lookId: out.lookId, groupId: out.groupId, ...(out.voiceId ? { voiceId: out.voiceId } : {}) };
  } catch (err) {
    // A refusal made nothing; otherwise the renderer's own listings still leave a twin and its voice out.
    if (!(err instanceof ValidationError)) console.error(`twin ${job.id} was not confirmed before it was forgotten:`, err);
    return job;
  }
}

/** Deletes a voice the renderer cloned for a twin, unless it is kept as the account's voice; never throws. */
async function dropVoice(providerName: string, voiceId: string | undefined, ownerId?: string): Promise<void> {
  if (!voiceId) return;
  try {
    if (ownerId && (await getStore().get<Voice>("voice", voiceId))?.ownerId === ownerId) return;
    await getAvatarProviderByName(providerName).deleteTwinVoice?.(voiceId);
  } catch (err) {
    // Still noted as the studio's, so no other account is offered it.
    console.error(`twin voice ${voiceId} was not deleted:`, err);
  }
}

/**
 * Asks the renderer for a page where the person in the footage records their consent (it lasts a day). A link still
 * valid is returned as it is; one past its day, or after a refusal, is replaced.
 */
export async function requestTwinConsent(id: string, ownerId: string = LOCAL_OWNER, opts: { admit?: () => void } = {}): Promise<TwinJob> {
  const job = owned(await getStore().get<TwinJob>("twin", twinIdSchema.parse(id)), ownerId, "Digital twin");
  if (job.status === "failed") throw new ValidationError(`"${job.name}" could not be trained${job.error ? `: ${job.error}` : ""}; train it again from other footage`);
  if (job.consent === "accepted") throw new ConflictError(`Consent for "${job.name}" is already given`);
  if (!job.groupId) throw new ConflictError(STILL_SENDING);
  const fresh = job.consentUrl && job.consentUrlAt && Date.now() - Date.parse(job.consentUrlAt) < CONSENT_LINK_MS && job.consent !== "rejected";
  if (fresh) return job;
  const provider = getAvatarProviderByName(job.provider);
  if (!provider.requestTwinConsent) throw new ValidationError(`Consent links are not available with the ${job.provider} renderer`);
  // Counted only when a new link is asked for; the one still valid is handed back as often as it is wanted.
  opts.admit?.();
  // One key per minute: a double click asks once, a link asked for again later is a new one.
  const out = await provider.requestTwinConsent(job.groupId, `${job.id}.${Math.floor(Date.now() / 60_000)}`);
  const now = nowIso();
  const next: TwinJob = { ...job, consent: out.consent, ...(out.url ? { consentUrl: out.url, consentUrlAt: now } : {}), updatedAt: now };
  delete next.error;
  // Written only over the record that was read, so a forget meanwhile stays forgotten.
  if (!(await getStore().putIf("twin", next, "updatedAt", job.updatedAt))) throw new ConflictError(`"${job.name}" changed meanwhile; try again`);
  return next;
}

/**
 * Forgets one twin. The presenter and voice it became stay (deleted from the avatars and voices, as any); a voice the
 * renderer cloned that never became the account's is deleted there. The renderer keeps the trained look, which stays
 * the studio's and is never offered to another account.
 */
export async function deleteTwin(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const job = await settle(owned(await getStore().get<TwinJob>("twin", twinIdSchema.parse(id)), ownerId, "Digital twin"));
  await Promise.all([rememberMadeLooks([job.lookId]), rememberMadeVoices([job.voiceId])]);
  await getStore().remove("twin", job.id);
  await dropVoice(job.provider, job.voiceId, ownerId);
}

/**
 * For account deletion: notes the look and voice a twin made (asking once more for a start whose answer was lost) and
 * deletes at the renderer the voice that never became the account's. Never throws.
 */
export async function dropTwinVoice(stored: TwinJob): Promise<void> {
  const job = await settle(stored);
  await Promise.all([rememberMadeLooks([job.lookId]), rememberMadeVoices([job.voiceId])]);
  await dropVoice(job.provider, job.voiceId, job.ownerId);
}

/** The trained twin's picture, kept as a data URL so the photo avatar keeps it after the renderer's link expires. */
async function keepPicture(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const { bytes, mimeType } = await loadImage(url, fetchPictures);
  if (bytes.byteLength > MAX_PORTRAIT_BYTES) throw new Error("The twin's picture is larger than a photo avatar may be");
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Asks the renderer how training and consent stand; once the twin is trained and consented to, it is kept as a photo
 * avatar of the account (once: its id is derived from the twin), opening the editor with the voice cloned from the
 * footage when the voices come from the same renderer. A start whose answer was lost is asked for again first. Never
 * throws: a failed check keeps what was known.
 */
async function refreshTwin(read: TwinJob): Promise<TwinJob> {
  if (read.status !== "processing") return read;
  let job = read;
  try {
    if (!job.lookId) {
      if (!dueForResend(job)) return job;
      const sent = await resend(job);
      if (!sent?.lookId) return sent ?? job;
      job = sent;
    }
    const provider = getAvatarProviderByName(job.provider);
    let next: TwinJob = { ...job };
    if (next.training === "processing" && provider.portraitStatus) {
      const look = await provider.portraitStatus(job.lookId, "twin");
      if (look.status === "failed" || (look.status === "completed" && !look.imageUrl)) {
        next = { ...next, training: "failed", status: "failed", error: look.error ?? "The renderer could not train a twin from that footage" };
      } else if (look.status === "completed" && look.imageUrl) {
        try {
          next = { ...next, training: "completed", imageUrl: await keepPicture(look.imageUrl) };
        } catch (err) {
          console.error(`twin picture for ${job.id}:`, err);
          next = { ...next, training: "failed", status: "failed", error: "The twin was trained but its picture could not be downloaded" };
        }
      }
    }
    // Consent is asked about once its link has been asked for, or once the twin is trained (a workspace the renderer
    // lets skip the step has it given already), until it is given.
    if (next.status === "processing" && (next.consent !== "not_requested" || next.training === "completed") && next.consent !== "accepted" && provider.twinConsentStatus) {
      const out = await provider.twinConsentStatus(job.groupId, job.consentUrlAt);
      if (out.gone) next = { ...next, training: "failed", status: "failed", error: out.error ?? "The renderer no longer has this twin" };
      else {
        if (out.consent !== "not_requested") next = { ...next, consent: out.consent };
        if (out.consent === "rejected" && out.error) next.error = out.error;
        else if (out.consent !== "rejected") delete next.error;
      }
    }
    if (next.status === "processing" && next.training === "completed" && next.consent === "accepted" && provider.lookAssetIds) {
      const avatarId = `av_${createHash("sha256").update(`${job.id}\0twin`).digest("base64url").slice(0, 20)}`;
      const voice = await keepVoice(job);
      const avatar: Avatar = {
        id: avatarId,
        ownerId: job.ownerId,
        name: job.name,
        imageUrl: next.imageUrl!,
        ...(job.gender ? { gender: job.gender } : {}),
        source: "custom",
        provider: job.provider,
        tags: ["digital twin"],
        providerAssetIds: provider.lookAssetIds(job.lookId),
        ...(voice ? { defaultVoiceId: voice } : {}),
        createdAt: nowIso(),
      };
      // Written once: a check repeated after a failed job write leaves a rename, or a delete, made meanwhile alone.
      await getStore().insert("avatar", avatar);
      next = { ...next, status: "completed", avatarId };
    }
    const now = nowIso();
    const changed = next.training !== job.training || next.consent !== job.consent || next.status !== job.status || next.error !== job.error;
    next = { ...next, checkedAt: now, updatedAt: changed ? now : job.updatedAt };
    // Written only over the record that was read, so a forget meanwhile stays forgotten.
    if (!(await getStore().putIf("twin", next, "updatedAt", job.updatedAt))) return job;
    await announce(job, next);
    return next;
  } catch (err) {
    console.error(`twin check failed for ${job.id}:`, err);
    return job;
  }
}

/**
 * The voice cloned from the twin's footage, kept as the account's own voice (once) when the studio's voices come from
 * the same renderer; otherwise none, and the clone stays unused (deleted when the twin is forgotten).
 */
async function keepVoice(job: TwinJob): Promise<string | undefined> {
  const tts = getTtsProvider();
  if (!job.voiceId || tts.name !== job.provider) return undefined;
  // Its language and preview as the provider knows them (its listing leaves the clone out); a failure keeps it plain.
  const known = await Promise.resolve(tts.describeVoice?.(job.voiceId)).catch((err: unknown) => (console.error(`twin voice ${job.voiceId}:`, err), undefined));
  const voice: Voice = {
    id: job.voiceId,
    name: twinVoiceName(job.name),
    provider: tts.name,
    ...(job.gender ? { gender: job.gender } : {}),
    ...known,
    source: "custom",
    ownerId: job.ownerId,
    tags: ["digital twin"],
    createdAt: nowIso(),
  };
  await getStore().insert("voice", voice);
  return job.voiceId;
}

/** "Name (twin)", within the 60 characters a voice's name may have when it is renamed (counted as the rename counts). */
function twinVoiceName(name: string): string {
  let room = 60;
  let out = withSuffix(name, " (twin)", room);
  while (out.length > 60 && room > 8) out = withSuffix(name, " (twin)", --room);
  // A first character longer than the room itself (heavy combining marks) is cut by code points as a last resort.
  if (out.length > 60) {
    let head = "";
    for (const ch of name) {
      if (head.length + ch.length > 53) break;
      head += ch;
    }
    out = `${head} (twin)`;
  }
  return out;
}

/** Throws NotFound for a twin that is not the account's (routes use it before acting on one). */
export async function getTwin(id: string, ownerId: string = LOCAL_OWNER): Promise<TwinJob> {
  const job = await getStore().get<TwinJob>("twin", twinIdSchema.parse(id));
  if (!job) throw new NotFoundError("Digital twin not found");
  return owned(job, ownerId, "Digital twin");
}
