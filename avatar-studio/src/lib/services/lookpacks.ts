// Look packs: a set of new looks for one of the account's photo avatars, its face in a pack's wardrobe and setting
// (HeyGen Look Packs). Each finished look is kept as a photo avatar of its own. Used by API routes only.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import type { Avatar, LookPackJob, LookPackLook } from "../types";
import { LOOK_PACK_ASPECTS, LOOK_PACK_KEYS, lookPackName } from "../look-packs";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { loadImage } from "../providers/image";
import type { FetchLike } from "../safe-fetch";
import { owned } from "./shared";
import { MAX_PORTRAIT_BYTES, rememberMadeLooks } from "./avatars";
import { prepareOnce } from "./videos";
import { jobChecker } from "./job-checks";

/** Look packs an account keeps (each made up to five photo avatars); another needs one forgotten first. */
export const MAX_LOOK_PACKS = 20;

export const lookPackRequestSchema = z.object({
  /** One of the account's own photo avatars. */
  avatarId: z.string().trim().min(1).max(100),
  pack: z.enum(LOOK_PACK_KEYS),
  /** Which of the pack's two variants to use; by default the avatar's own gender, when it is female or male. */
  gender: z.enum(["female", "male"]).optional(),
  aspect: z.enum(LOOK_PACK_ASPECTS).default("16:9"),
});

export const lookPackIdSchema = z.string().regex(/^lk_[A-Za-z0-9_-]{1,64}$/, "Unknown look pack");

/** A client's key for one start (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const lookPackKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function lookPacksAvailable(): boolean {
  return typeof getAvatarProvider().startLookPack === "function";
}

/** What the account sees of a look pack: never the renderer or its look ids, which stay on the server. */
export type PublicLookPack = Omit<LookPackJob, "ownerId" | "provider" | "lookIds">;
export function publicLookPack(job: LookPackJob): PublicLookPack {
  const { ownerId: _o, provider: _p, lookIds: _l, ...rest } = job;
  void _o;
  void _p;
  void _l;
  return rest;
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
export async function startLookPack(input: z.infer<typeof lookPackRequestSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<LookPackJob> {
  const id = opts.key ? `lk_${createHash("sha256").update(`${ownerId}\0${opts.key}`).digest("base64url").slice(0, 32)}` : newId("lk");
  const existing = opts.key ? await getStore().get<LookPackJob>("lookpack", id) : null;
  if (existing && existing.ownerId === ownerId) {
    const same = existing.avatarId === input.avatarId && existing.pack === input.pack && existing.aspect === input.aspect && (!input.gender || existing.gender === input.gender);
    if (!same) throw new ConflictError("This Idempotency-Key was already used for another look pack; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (!provider.startLookPack) throw new ValidationError(`New looks are not available with the ${provider.name} renderer`);
  const stored = await getStore().get<Avatar>("avatar", input.avatarId);
  // Only the account's own photo avatars; a library presenter is the renderer's, not the account's to restyle.
  if (!stored || (stored.ownerId ?? LOCAL_OWNER) !== ownerId || stored.source !== "custom") throw new NotFoundError("Only your own photo avatars can be given new looks");
  if (stored.provider !== provider.name) throw new ValidationError(`"${stored.name}" was made for another renderer`);
  const gender = input.gender ?? (stored.gender === "female" || stored.gender === "male" ? stored.gender : undefined);
  if (!gender) throw new ValidationError("Choose the women's or the men's looks of the pack");
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<LookPackJob>("lookpack", ownerId)).length >= MAX_LOOK_PACKS) throw new ConflictError(`An account keeps at most ${MAX_LOOK_PACKS} look packs; forget one to make another`);
  opts.admit?.();
  const avatar = provider.prepareAvatar ? await prepareOnce(provider, stored) : stored;
  const { lookIds } = await provider.startLookPack({ avatar, pack: input.pack, gender, aspect: input.aspect, key: id });
  const now = nowIso();
  const job: LookPackJob = {
    id,
    ownerId,
    avatarId: stored.id,
    avatarName: stored.name,
    pack: input.pack,
    gender,
    aspect: input.aspect,
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
  await getStore().remove("lookpack", job.id);
}

/** A finished look's picture, kept as a data URL so the photo avatar keeps it after the renderer's link expires. */
async function keepPicture(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const { bytes, mimeType } = await loadImage(url, fetchPictures);
  if (bytes.byteLength > MAX_PORTRAIT_BYTES) throw new Error("The look's picture is larger than a photo avatar may be");
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
      const out = await provider.portraitStatus(lookId);
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
        looks.push({ status: "failed", error: "The look was made but its picture could not be downloaded" });
        continue;
      }
      const avatarId = `av_${createHash("sha256").update(`${job.id}\0${i}`).digest("base64url").slice(0, 20)}`;
      const avatar: Avatar = {
        id: avatarId,
        ownerId: job.ownerId,
        name: `${job.avatarName} · ${name} ${i + 1}`.slice(0, 80),
        imageUrl,
        gender: job.gender,
        ...(source?.defaultVoiceId ? { defaultVoiceId: source.defaultVoiceId } : {}),
        source: "custom",
        provider: job.provider,
        tags: ["photo avatar", name],
        providerAssetIds: provider.lookAssetIds(lookId),
        createdAt: nowIso(),
      };
      await getStore().put("avatar", avatar);
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
