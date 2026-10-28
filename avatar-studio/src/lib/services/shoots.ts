// Photo shoots: photos of one person in a scene they were never photographed in (HeyGen Image, `heygen-image-1`). The
// face, hair, and expression come from a few photos of the person; the pose, clothing, light, and setting from one
// scene picture. Neither set of pictures is kept; the photos are followed until ready, to view and download.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { MAX_FOOTAGE_SEED, MAX_SHOOT_IDENTITY, MAX_SHOOT_PHOTOS, SHOOT_ASPECTS, type ShootJob } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { decodeDataUrl } from "../providers/image";
import { owned, stripUndefined } from "./shared";
import { RELINK_MS, jobChecker } from "./job-checks";
import { sniff } from "./backdrops";

/** Photo shoots an account keeps; another needs one deleted first. */
export const MAX_SHOOTS = 50;
/** Each picture of a start, decoded: six of them (five of the person, one scene) still fit in one request. */
export const MAX_SHOOT_PICTURE_BYTES = 500 * 1024;
const dataUrlMax = (bytes: number) => Math.ceil((bytes * 4) / 3) + 100;

// The pictures come first, so a request with several mistakes leads with the one about a picture (the page shows the first).
export const shootRequestSchema = z
  .object({
    /** Data URLs of PNG or JPEG photos of one person, their face clearly seen: several views of the same face. */
    identity: z
      .array(z.string("Each photo of the person is a data URL"), "Add a photo of the person")
      // The count and each photo's size in one check, which runs only on a list: one message, naming the photo too large.
      .superRefine((photos, ctx) => {
        if (!photos.length) return void ctx.addIssue({ code: "custom", message: "Add a photo of the person" });
        if (photos.length > MAX_SHOOT_IDENTITY) return void ctx.addIssue({ code: "custom", message: `A shoot takes at most ${MAX_SHOOT_IDENTITY} photos of the person` });
        photos.forEach((p, i) => {
          if (p.length > dataUrlMax(MAX_SHOOT_PICTURE_BYTES)) ctx.addIssue({ code: "custom", path: [i], message: `${photos.length > 1 ? `Photo ${i + 1} of the person` : "The photo of the person"} must be at most 500 KB` });
        });
      }),
    /** A data URL of the scene: exactly one person, whose pose, clothing, light, and setting the photos take. */
    reference: z.string("Add the scene picture").max(dataUrlMax(MAX_SHOOT_PICTURE_BYTES), "The scene picture must be at most 500 KB"),
    /** Without one, the photos take the scene picture's shape. */
    aspect: z.enum(SHOOT_ASPECTS, `The shape is one of ${SHOOT_ASPECTS.join(", ")}; leave it out to follow the scene picture`).optional(),
    count: z.number("The number of photos is a whole number").int("The number of photos is a whole number").min(1, "Ask for at least one photo").max(MAX_SHOOT_PHOTOS, `A shoot makes at most ${MAX_SHOOT_PHOTOS} photos`).default(1),
    /** The first photo's seed; later photos take the next ones. The renderer picks one when absent. */
    seed: z.number("A seed is a whole number").int("A seed is a whole number").min(0, "A seed is 0 or more").max(MAX_FOOTAGE_SEED, `A seed is at most ${MAX_FOOTAGE_SEED}`).optional(),
    /** The person in the photos agreed to be photographed this way, or is the one asking. */
    consent: z.literal(true, "Confirm that you have the right to use this person's face"),
    title: z.string("A title is text").trim().max(120, "A title is at most 120 characters").optional(),
  })
  .strict();
type ShootRequest = z.infer<typeof shootRequestSchema>;

export const shootIdSchema = z.string().regex(/^sh_[A-Za-z0-9_-]{1,64}$/, "Unknown photo shoot");

/** One photo of one of the account's photo shoots (1 for its first photo), named by a request that uses it. */
export const shootPhotoSchema = z
  .object({
    shootId: z.string("Name the photo shoot"),
    photo: z.number("Name the photo by its number").int("Name the photo by its number").min(1, "Photos are numbered from 1").max(MAX_SHOOT_PHOTOS, `A shoot has at most ${MAX_SHOOT_PHOTOS} photos`),
  }, "Name the photo shoot and the photo")
  .strict();

/** A shoot id as a lookup takes it: one that cannot be a shoot's reads as not found, like an unknown one. */
function shootId(id: string): string {
  if (!shootIdSchema.safeParse(id).success) throw new NotFoundError("Photo shoot not found");
  return id;
}

/** A client's key for one start (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const shootKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function shootsAvailable(): boolean {
  return typeof getAvatarProvider().startShoot === "function";
}

/** What the account sees of a shoot: never the renderer, its job id, or the pictures' digest, which stay on the server. */
export type PublicShoot = Omit<ShootJob, "ownerId" | "provider" | "providerJobId" | "pictureDigest">;
export function publicShoot(job: ShootJob): PublicShoot {
  const { ownerId: _o, provider: _p, providerJobId: _j, pictureDigest: _d, ...rest } = job;
  void _o;
  void _p;
  void _j;
  void _d;
  return rest;
}

const checks = jobChecker<ShootJob>((job) => refreshShoot(job));

/** Forgets when shoots were last asked about (tests). */
export function forgetShootChecks(): void {
  checks.forget();
}

/** The account's photo shoots, newest first; any still being made, or holding old links, is asked about first. */
export async function listShoots(ownerId: string = LOCAL_OWNER): Promise<ShootJob[]> {
  const jobs = await getStore().list<ShootJob>("shoot", ownerId);
  return (await checks.follow(jobs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A picture of a start, as bytes, checked to be a PNG or JPEG within its size; `which` names it in a refusal. */
function picture(url: string, which: string): { bytes: Uint8Array; mimeType: string } {
  if (!url.startsWith("data:image/")) throw new ValidationError(`${which} must be an image file`);
  let decoded: ReturnType<typeof decodeDataUrl>;
  try {
    decoded = decodeDataUrl(url);
  } catch {
    throw new ValidationError(`${which} is malformed`);
  }
  if (decoded.bytes.byteLength > MAX_SHOOT_PICTURE_BYTES) throw new ValidationError(`${which} is larger than 500 KB`);
  const mimeType = sniff(decoded.bytes);
  if (!mimeType) throw new ValidationError(`${which} is not a PNG or JPEG image`);
  return { bytes: decoded.bytes, mimeType };
}

/**
 * Starts one photo shoot; the renderer keeps the job and the studio follows it. With a client `key`, the job's id is
 * derived from the account and the key: a start retried with the same key returns the job already stored, or, when
 * the first try reached the renderer but was never stored, sends the renderer the same key and body, so the photos are
 * not made or paid for twice. `admit` runs once everything is checked, before the renderer is asked (the hourly limit).
 */
export async function startShoot(input: ShootRequest, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<ShootJob> {
  const identity = input.identity.map((url, i) => picture(url, input.identity.length > 1 ? `Photo ${i + 1} of the person` : "The photo of the person"));
  const reference = picture(input.reference, "The scene picture");
  // One digest for every picture, in order, the scene last.
  const hash = createHash("sha256");
  for (const p of [...identity, reference]) hash.update(createHash("sha256").update(p.bytes).digest()).update("\0");
  const pictureDigest = hash.digest("base64url");
  const title = input.title || `Photo shoot, ${input.count} photo${input.count === 1 ? "" : "s"}`;
  const id = opts.key ? `sh_${createHash("sha256").update(`${ownerId}\0${opts.key}`).digest("base64url").slice(0, 32)}` : newId("sh");
  const existing = opts.key ? await getStore().get<ShootJob>("shoot", id) : null;
  if (existing && existing.ownerId === ownerId) {
    const same = existing.title === title && existing.pictureDigest === pictureDigest && existing.identityCount === identity.length && existing.aspect === input.aspect && existing.count === input.count && existing.seed === input.seed;
    if (!same) throw new ConflictError("This Idempotency-Key was already used for another photo shoot; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (!provider.startShoot) throw new ValidationError(`Photo shoots are not available with the ${provider.name} renderer`);
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<ShootJob>("shoot", ownerId)).length >= MAX_SHOOTS) throw new ConflictError(`An account keeps at most ${MAX_SHOOTS} photo shoots; delete one to make another`);
  opts.admit?.();
  const { jobId } = await provider.startShoot({ identity, reference, aspect: input.aspect, count: input.count, seed: input.seed, key: id });
  const now = nowIso();
  const job: ShootJob = stripUndefined({
    id,
    ownerId,
    title,
    identityCount: identity.length,
    aspect: input.aspect,
    count: input.count,
    seed: input.seed,
    pictureDigest,
    provider: provider.name,
    providerJobId: jobId,
    status: "processing" as const,
    createdAt: now,
    updatedAt: now,
  });
  return getStore().put("shoot", job);
}

/**
 * The link of one finished photo of the account's shoot (`photo` from 1), fresh enough for a renderer to fetch: an old
 * one is renewed first. For a clip that opens on it; a shoot not ready, or a photo it does not have, is refused.
 */
export async function shootPhotoLink(id: string, photo: number, ownerId: string = LOCAL_OWNER): Promise<{ url: string; provider: string }> {
  const [job] = await checks.follow([owned(await getStore().get<ShootJob>("shoot", shootId(id)), ownerId, "Photo shoot")]);
  if (job.status === "failed") throw new ValidationError(`"${job.title}" has no photos${job.error ? ` (${job.error.replace(/\.$/, "")})` : ""}; choose another photo`);
  if (job.status !== "completed") throw new ValidationError(`"${job.title}" is not ready yet; wait for its photos`);
  const url = job.photos?.[photo - 1]?.url;
  if (!url) throw new ValidationError(`"${job.title}" has ${job.photos?.length === 1 ? "one photo" : `${job.photos?.length ?? 0} photos`}; there is no photo ${photo}`);
  // A link the renderer could not renew (it was asked a moment ago and failed) may have expired; it is not sent.
  if (Date.now() - Date.parse(job.checkedAt ?? job.updatedAt) > RELINK_MS) throw new ValidationError(`The link to photo ${photo} of "${job.title}" could not be renewed just now; try again in a few minutes`);
  return { url, provider: job.provider };
}

/** Forgets one photo shoot (the renderer's copies expire on their own). */
export async function deleteShoot(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const job = owned(await getStore().get<ShootJob>("shoot", shootId(id)), ownerId, "Photo shoot");
  await getStore().remove("shoot", job.id);
}

/** Asks the renderer where a shoot stands and stores the answer. Never throws: a failed check keeps what was known. */
async function refreshShoot(job: ShootJob): Promise<ShootJob> {
  try {
    const provider = getAvatarProviderByName(job.provider);
    if (!provider.shootStatus) return job;
    const out = await provider.shootStatus(job.providerJobId);
    const now = nowIso();
    const { photos: _p, error: _e, ...kept } = job;
    void _p;
    void _e;
    const next: ShootJob = {
      ...kept,
      ...stripUndefined({ status: out.status, photos: out.photos?.length ? out.photos : undefined, error: out.error }),
      checkedAt: now,
      updatedAt: out.status !== job.status ? now : job.updatedAt,
    };
    // Written only over the record that was read, so a delete meanwhile stays deleted.
    return (await getStore().putIf("shoot", next, "updatedAt", job.updatedAt)) ? next : job;
  } catch (err) {
    console.error(`photo shoot check failed for ${job.id}:`, err);
    return job;
  }
}
