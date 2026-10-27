// Digital twins: a presenter trained from footage of a real person (HeyGen digital twin). The renderer trains a look from
// the footage; the person in it records their consent on the renderer's page; once both are done, the twin is kept as a
// photo avatar of the account. Used by API routes only.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import type { Avatar, TwinJob } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPublicHttpUrl } from "../safe-url";
import { loadImage } from "../providers/image";
import type { FetchLike } from "../safe-fetch";
import { owned } from "./shared";
import { MAX_PORTRAIT_BYTES, rememberMadeLooks } from "./avatars";
import { jobChecker } from "./job-checks";

/** Digital twins an account keeps (each one becomes a presenter); another needs one forgotten first. */
export const MAX_TWINS = 10;
/** A consent page lasts this long at the renderer; a new one can be asked for after. */
export const CONSENT_LINK_MS = 24 * 60 * 60 * 1000;

export const twinRequestSchema = z.object({
  name: z.string().trim().min(1, "Give the twin a name").max(80),
  /** A public https link to the footage: one person speaking to camera, 15 seconds to 10 minutes. */
  footageUrl: z.string().trim().max(2000, "The link is too long"),
  gender: z.enum(["female", "male"]).optional(),
  /** The account says the person in the footage agreed to be made into a twin (they also record consent at the renderer). */
  agreed: z.literal(true, { message: "Confirm that the person in the footage agreed to be made into a digital twin" }),
});

export const twinIdSchema = z.string().regex(/^tw_[A-Za-z0-9_-]{1,64}$/, "Unknown digital twin");

/** A client's key for one start (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const twinKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function twinsAvailable(): boolean {
  return typeof getAvatarProvider().startTwin === "function";
}

/** What the account sees of a twin: never the renderer, its look, or its character, which stay on the server. */
export type PublicTwin = Omit<TwinJob, "ownerId" | "provider" | "lookId" | "groupId" | "imageUrl"> & { consentLinkExpired?: true };
export function publicTwin(job: TwinJob, now = Date.now()): PublicTwin {
  const { ownerId: _o, provider: _p, lookId: _l, groupId: _g, imageUrl: _i, ...rest } = job;
  void _o;
  void _p;
  void _l;
  void _g;
  void _i;
  // A link past its day is not offered; a new one is asked for instead.
  const expired = !!job.consentUrlAt && now - Date.parse(job.consentUrlAt) > CONSENT_LINK_MS && job.consent !== "accepted";
  if (!expired) return rest;
  const { consentUrl: _u, ...withoutLink } = rest;
  void _u;
  return { ...withoutLink, consentLinkExpired: true };
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

/**
 * Starts training a twin from a public link to the footage. With a client `key`, the twin's id is derived from the
 * account and the key, so a retried start returns the twin already stored, or asks the renderer again with the same key.
 * `admit` runs once the request is checked (the hourly limit).
 */
export async function startTwin(input: z.infer<typeof twinRequestSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<TwinJob> {
  const id = opts.key ? `tw_${createHash("sha256").update(`${ownerId}\0${opts.key}`).digest("base64url").slice(0, 32)}` : newId("tw");
  const existing = opts.key ? await getStore().get<TwinJob>("twin", id) : null;
  if (existing && existing.ownerId === ownerId) {
    if (existing.footageUrl !== input.footageUrl || existing.name !== input.name) throw new ConflictError("This Idempotency-Key was already used for another twin; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (!provider.startTwin) throw new ValidationError(`Digital twins are not available with the ${provider.name} renderer`);
  const url = input.footageUrl;
  // The renderer downloads the footage itself, so it must be a public https address (not this network's, say).
  if (!/^https:\/\/[^\s]+$/i.test(url) || !URL.canParse(url)) throw new ValidationError("Paste a public https link to the footage");
  try {
    await assertPublicHttpUrl(url, "The link to the footage");
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : "Paste a public https link to the footage");
  }
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<TwinJob>("twin", ownerId)).length >= MAX_TWINS) throw new ConflictError(`An account keeps at most ${MAX_TWINS} digital twins; forget one to train another`);
  opts.admit?.();
  const { lookId, groupId } = await provider.startTwin({ name: input.name, footageUrl: url, key: id });
  // The look is the studio's in the renderer's shared account from now on, whatever becomes of this twin.
  await rememberMadeLooks([lookId]);
  const now = nowIso();
  const job: TwinJob = {
    id,
    ownerId,
    name: input.name,
    ...(input.gender ? { gender: input.gender } : {}),
    footageUrl: url,
    provider: provider.name,
    lookId,
    groupId,
    training: "processing",
    consent: "not_requested",
    status: "processing",
    createdAt: now,
    updatedAt: now,
  };
  return getStore().put("twin", job);
}

/**
 * Asks the renderer for a page where the person in the footage records their consent (it lasts a day). A link still
 * valid is returned as it is; one past its day, or after a refusal, is replaced.
 */
export async function requestTwinConsent(id: string, ownerId: string = LOCAL_OWNER): Promise<TwinJob> {
  const job = owned(await getStore().get<TwinJob>("twin", twinIdSchema.parse(id)), ownerId, "Digital twin");
  if (job.status === "failed") throw new ValidationError(`"${job.name}" could not be trained${job.error ? `: ${job.error}` : ""}; train it again from other footage`);
  if (job.consent === "accepted") throw new ConflictError(`Consent for "${job.name}" is already given`);
  const fresh = job.consentUrl && job.consentUrlAt && Date.now() - Date.parse(job.consentUrlAt) < CONSENT_LINK_MS && job.consent !== "rejected";
  if (fresh) return job;
  const provider = getAvatarProviderByName(job.provider);
  if (!provider.requestTwinConsent) throw new ValidationError(`Consent links are not available with the ${job.provider} renderer`);
  // One key per minute: a double click asks once, a link asked for again later is a new one.
  const out = await provider.requestTwinConsent(job.groupId, `${job.id}.${Math.floor(Date.now() / 60_000)}`);
  const now = nowIso();
  const next: TwinJob = { ...job, consent: out.consent, ...(out.url ? { consentUrl: out.url, consentUrlAt: now } : {}), updatedAt: now };
  delete next.error;
  return getStore().put("twin", next);
}

/** Forgets one twin; the presenter it became stays (deleted from the avatars, as any). */
export async function deleteTwin(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const job = owned(await getStore().get<TwinJob>("twin", twinIdSchema.parse(id)), ownerId, "Digital twin");
  await rememberMadeLooks([job.lookId]);
  await getStore().remove("twin", job.id);
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
 * avatar of the account (once: its id is derived from the twin). Never throws: a failed check keeps what was known.
 */
async function refreshTwin(job: TwinJob): Promise<TwinJob> {
  if (job.status !== "processing") return job;
  try {
    const provider = getAvatarProviderByName(job.provider);
    let next: TwinJob = { ...job };
    if (next.training === "processing" && provider.portraitStatus) {
      const look = await provider.portraitStatus(job.lookId);
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
    // Consent is asked about once its link has been asked for, until it is given.
    if (next.status === "processing" && (next.consent === "pending" || next.consent === "rejected") && provider.twinConsentStatus) {
      const out = await provider.twinConsentStatus(job.groupId);
      if (out.consent !== "not_requested") next = { ...next, consent: out.consent };
      if (out.consent === "rejected" && out.error) next.error = out.error;
      else if (out.consent !== "rejected") delete next.error;
    }
    if (next.status === "processing" && next.training === "completed" && next.consent === "accepted" && provider.lookAssetIds) {
      const avatarId = `av_${createHash("sha256").update(`${job.id}\0twin`).digest("base64url").slice(0, 20)}`;
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
    return (await getStore().putIf("twin", next, "updatedAt", job.updatedAt)) ? next : job;
  } catch (err) {
    console.error(`twin check failed for ${job.id}:`, err);
    return job;
  }
}

/** Throws NotFound for a twin that is not the account's (routes use it before acting on one). */
export async function getTwin(id: string, ownerId: string = LOCAL_OWNER): Promise<TwinJob> {
  const job = await getStore().get<TwinJob>("twin", twinIdSchema.parse(id));
  if (!job) throw new NotFoundError("Digital twin not found");
  return owned(job, ownerId, "Digital twin");
}
