// Look packs: a set of new looks for one of the account's photo avatars, its face in a pack's wardrobe and setting
// (HeyGen Look Packs). Each finished look is kept as a photo avatar of its own. Used by API routes only.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import type { Avatar, LookPackJob, LookPackLook } from "../types";
import { DESCRIBED, DESCRIBED_ASPECTS, LOOK_PACK_ASPECTS, LOOK_PACK_KEYS, MAX_LOOK_PROMPT, MAX_LOOK_REFERENCES, lookPackName } from "../look-packs";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { decodeDataUrl, loadImage } from "../providers/image";
import type { FetchLike } from "../safe-fetch";
import { owned } from "./shared";
import { MAX_PORTRAIT_BYTES, rememberMadeLooks } from "./avatars";
import { prepareOnce } from "./videos";
import { jobChecker } from "./job-checks";
import { withSuffix } from "../text";
import { sniff } from "./backdrops";

/** Look packs an account keeps (each made up to five photo avatars); another needs one forgotten first. */
export const MAX_LOOK_PACKS = 20;

/** A wardrobe or setting picture sent with a described look, decoded (the page shrinks larger ones first). */
export const MAX_REFERENCE_BYTES = 1024 * 1024;

export const lookPackRequestSchema = z.discriminatedUnion("pack", [
  z.object({
    /** One of the account's own photo avatars. */
    avatarId: z.string().trim().min(1).max(100),
    pack: z.enum(LOOK_PACK_KEYS),
    /** Which of the pack's two variants to use; by default the avatar's own gender, when it is female or male. */
    gender: z.enum(["female", "male"]).optional(),
    aspect: z.enum(LOOK_PACK_ASPECTS).default("16:9"),
  }),
  z.object({
    avatarId: z.string().trim().min(1).max(100),
    pack: z.literal(DESCRIBED),
    /** The outfit and setting, in words; the face stays the avatar's. */
    prompt: z.string().trim().min(10, "Describe the outfit and setting in a few words").max(MAX_LOOK_PROMPT, `Describe the look in at most ${MAX_LOOK_PROMPT} characters`),
    aspect: z.enum(DESCRIBED_ASPECTS).default("4:5"),
    /** Data URLs of PNG or JPEG pictures of the clothes or the place, used as guidance and not kept. */
    references: z
      .array(z.string().max(Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 100, "A picture is larger than 1 MB"))
      .max(MAX_LOOK_REFERENCES, `Send at most ${MAX_LOOK_REFERENCES} pictures`)
      .default([]),
  }),
]);
type LookPackRequest = z.infer<typeof lookPackRequestSchema>;

export const lookPackIdSchema = z.string().regex(/^lk_[A-Za-z0-9_-]{1,64}$/, "Unknown look pack");

/** A client's key for one start (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const lookPackKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function lookPacksAvailable(): boolean {
  return typeof getAvatarProvider().startLookPack === "function";
}

export function describedLooksAvailable(): boolean {
  return typeof getAvatarProvider().startDescribedLook === "function";
}

/** What the account sees of a look pack: never the renderer or its look ids, which stay on the server. */
export type PublicLookPack = Omit<LookPackJob, "ownerId" | "provider" | "lookIds" | "referenceDigest">;
export function publicLookPack(job: LookPackJob): PublicLookPack {
  const { ownerId: _o, provider: _p, lookIds: _l, referenceDigest: _r, ...rest } = job;
  void _o;
  void _p;
  void _l;
  void _r;
  return rest;
}

/** The pictures of a described look as bytes, each checked to be a PNG or JPEG of at most 1 MB. */
function referencePictures(references: string[]): Array<{ bytes: Uint8Array; mimeType: string }> {
  return references.map((url, i) => {
    const which = references.length > 1 ? `Picture ${i + 1}` : "The picture";
    if (!url.startsWith("data:image/")) throw new ValidationError(`${which} must be an image file`);
    let decoded: ReturnType<typeof decodeDataUrl>;
    try {
      decoded = decodeDataUrl(url);
    } catch {
      throw new ValidationError(`${which} is malformed`);
    }
    if (decoded.bytes.byteLength > MAX_REFERENCE_BYTES) throw new ValidationError(`${which} is larger than 1 MB`);
    const mimeType = sniff(decoded.bytes);
    if (!mimeType) throw new ValidationError(`${which} is not a PNG or JPEG image`);
    return { bytes: decoded.bytes, mimeType };
  });
}

function digestOf(pictures: Array<{ bytes: Uint8Array }>): string {
  const hash = createHash("sha256");
  for (const p of pictures) hash.update(createHash("sha256").update(p.bytes).digest());
  return hash.digest("base64url");
}

/** Whether a stored job is the start a retried request with the same key asks for. */
function sameStart(existing: LookPackJob, input: LookPackRequest, digest: string | undefined): boolean {
  if (existing.avatarId !== input.avatarId || existing.pack !== input.pack || existing.aspect !== input.aspect) return false;
  if (input.pack === DESCRIBED) return existing.prompt === input.prompt && (existing.referenceDigest ?? "") === (digest ?? "");
  return !input.gender || existing.gender === input.gender;
}

/** The pictures of finished looks are fetched through this (tests swap it). */
let fetchPictures: FetchLike | undefined;
export function setLookPictureFetch(impl: FetchLike | undefined): void {
  fetchPictures = impl;
}

const checks = jobChecker<LookPackJob>((job) => refreshLookPack(job));

/** Forgets when look packs were last asked about (tests). */
export function forgetLookPackChecks(): void {
  checks.forget();
}

/** The account's look packs, newest first; one still being made is asked about first. */
export async function listLookPacks(ownerId: string = LOCAL_OWNER): Promise<LookPackJob[]> {
  const jobs = await getStore().list<LookPackJob>("lookpack", ownerId);
  return (await checks.follow(jobs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Starts a look pack for one of the account's photo avatars. The avatar is made into a renderer photo avatar first if no
 * render has done so yet (its look is the identity reference). With a client `key`, the job's id is derived from the
 * account and the key, so a retried start returns the job already stored, or, when the first try reached the renderer
 * but was never stored, asks it again with the same key. `admit` runs once the request is checked (the hourly limit).
 */
export async function startLookPack(input: LookPackRequest, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<LookPackJob> {
  const described = input.pack === DESCRIBED ? input : null;
  const pictures = described ? referencePictures(described.references) : [];
  const digest = pictures.length ? digestOf(pictures) : undefined;
  const id = opts.key ? `lk_${createHash("sha256").update(`${ownerId}\0${opts.key}`).digest("base64url").slice(0, 32)}` : newId("lk");
  const existing = opts.key ? await getStore().get<LookPackJob>("lookpack", id) : null;
  if (existing && existing.ownerId === ownerId) {
    if (!sameStart(existing, input, digest)) throw new ConflictError("This Idempotency-Key was already used for other new looks; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (described ? !provider.startDescribedLook : !provider.startLookPack) throw new ValidationError(`${described ? "Looks from a description are" : "New looks are"} not available with the ${provider.name} renderer`);
  const stored = await getStore().get<Avatar>("avatar", input.avatarId);
  // Only the account's own photo avatars; a library presenter is the renderer's, not the account's to restyle.
  if (!stored) throw new NotFoundError("That photo avatar no longer exists");
  if ((stored.ownerId ?? LOCAL_OWNER) !== ownerId || stored.source !== "custom") throw new NotFoundError("Only your own photo avatars can be given new looks");
  if (stored.provider !== provider.name) throw new ValidationError(`"${stored.name}" was made for another renderer`);
  const own = stored.gender === "female" || stored.gender === "male" ? stored.gender : undefined;
  const gender = input.pack === DESCRIBED ? own : (input.gender ?? own);
  if (!described && !gender) throw new ValidationError("Choose the women's or the men's looks of the pack");
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<LookPackJob>("lookpack", ownerId)).length >= MAX_LOOK_PACKS) throw new ConflictError(`An account keeps at most ${MAX_LOOK_PACKS} look packs and described looks; forget one to make another`);
  opts.admit?.();
  const avatar = provider.prepareAvatar ? await prepareOnce(provider, stored) : stored;
  const { lookIds } = described
    ? await provider.startDescribedLook!({ avatar, prompt: described.prompt, aspect: described.aspect, references: pictures, key: id })
    : await provider.startLookPack!({ avatar, pack: input.pack, gender: gender!, aspect: input.aspect as "16:9" | "9:16", key: id });
  const now = nowIso();
  const job: LookPackJob = {
    id,
    ownerId,
    avatarId: stored.id,
    avatarName: stored.name,
    pack: input.pack,
    ...(gender ? { gender } : {}),
    aspect: input.aspect,
    ...(described ? { prompt: described.prompt, ...(pictures.length ? { references: pictures.length, referenceDigest: digest } : {}) } : {}),
    provider: provider.name,
    lookIds,
    looks: lookIds.map(() => ({ status: "processing" as const })),
    status: "processing",
    createdAt: now,
    updatedAt: now,
  };
  // The looks are the studio's in the renderer's shared account from now on, whatever becomes of this job.
  await rememberMadeLooks(lookIds);
  return getStore().put("lookpack", job);
}

/** Forgets one look pack; the photo avatars made of its looks stay (they are deleted one by one, as any). */
export async function deleteLookPack(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const job = owned(await getStore().get<LookPackJob>("lookpack", lookPackIdSchema.parse(id)), ownerId, "Look pack");
  await rememberMadeLooks(job.lookIds);
  await getStore().remove("lookpack", job.id);
}

class PictureTooLarge extends Error {}

/** A finished look's picture, kept as a data URL so the photo avatar keeps it after the renderer's link expires. */
async function keepPicture(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const { bytes, mimeType } = await loadImage(url, fetchPictures);
  if (bytes.byteLength > MAX_PORTRAIT_BYTES) throw new PictureTooLarge();
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Asks the renderer about each look still being made; a finished one becomes a photo avatar of the account (named after
 * the avatar and the pack, with its gender and default voice). The avatar's id is derived from the job and the look, so
 * a check repeated elsewhere writes the same avatar rather than a second one. Never throws: a failed check keeps what
 * was known.
 */
async function refreshLookPack(job: LookPackJob): Promise<LookPackJob> {
  if (job.status !== "processing") return job;
  try {
    const provider = getAvatarProviderByName(job.provider);
    if (!provider.portraitStatus || !provider.lookAssetIds) return job;
    const source = await getStore().get<Avatar>("avatar", job.avatarId);
    const name = lookPackName(job.pack);
    const looks: LookPackLook[] = [];
    for (const [i, look] of job.looks.entries()) {
      if (look.status !== "processing") {
        looks.push(look);
        continue;
      }
      const lookId = job.lookIds[i];
      let out: Awaited<ReturnType<NonNullable<typeof provider.portraitStatus>>>;
      try {
        out = await provider.portraitStatus(lookId);
      } catch (err) {
        // One look the renderer no longer has ends there; any other failed check leaves it to the next, and the other
        // looks are still followed.
        if (/ failed: (404|410)\b/.test(err instanceof Error ? err.message : "")) looks.push({ status: "failed", error: "The renderer no longer has this look" });
        else {
          console.error(`look ${i + 1} of ${job.id}:`, err);
          looks.push(look);
        }
        continue;
      }
      if (out.status === "processing") {
        looks.push(look);
        continue;
      }
      if (out.status === "failed" || !out.imageUrl) {
        looks.push({ status: "failed", error: out.error ?? "The renderer could not make this look" });
        continue;
      }
      let imageUrl: string;
      try {
        imageUrl = await keepPicture(out.imageUrl);
      } catch (err) {
        console.error(`look ${i + 1} of ${job.id}:`, err);
        looks.push({ status: "failed", error: err instanceof PictureTooLarge ? "The look's picture is larger than a photo avatar may be" : "The look was made but its picture could not be downloaded" });
        continue;
      }
      const avatarId = `av_${createHash("sha256").update(`${job.id}\0${i}`).digest("base64url").slice(0, 20)}`;
      const avatar: Avatar = {
        id: avatarId,
        ownerId: job.ownerId,
        // A long name is shortened, never the pack and number that tell the looks apart.
        name: withSuffix(job.avatarName, job.pack === DESCRIBED ? ` · ${name}` : ` · ${name} ${i + 1}`, 80),
        imageUrl,
        // A described look has no variant of its own: it keeps the gender the avatar had.
        ...((job.gender ?? source?.gender) ? { gender: job.gender ?? source?.gender } : {}),
        ...(source?.defaultVoiceId ? { defaultVoiceId: source.defaultVoiceId } : {}),
        source: "custom",
        provider: job.provider,
        tags: ["photo avatar", name],
        providerAssetIds: provider.lookAssetIds(lookId),
        createdAt: nowIso(),
      };
      // Written once: a check repeated after a failed job write leaves a rename, or a delete, made meanwhile alone.
      await getStore().insert("avatar", avatar);
      looks.push({ status: "completed", avatarId });
    }
    const now = nowIso();
    const status: LookPackJob["status"] = looks.some((l) => l.status === "processing") ? "processing" : looks.some((l) => l.status === "completed") ? "completed" : "failed";
    const next: LookPackJob = { ...job, looks, status, checkedAt: now, updatedAt: status !== job.status || looks.some((l, i) => l.status !== job.looks[i].status) ? now : job.updatedAt };
    // Written only over the record that was read, so a forget meanwhile stays forgotten.
    return (await getStore().putIf("lookpack", next, "updatedAt", job.updatedAt)) ? next : job;
  } catch (err) {
    console.error(`look pack check failed for ${job.id}:`, err);
    return job;
  }
}
