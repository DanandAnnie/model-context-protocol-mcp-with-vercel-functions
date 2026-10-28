// Generated clips: a short shot the renderer makes from a description, brings to life from a picture as its first
// frame, or builds around pictures of things it must feature (HeyGen Video), to watch, download, or loop behind a
// presenter as a scene's video background. Used by API routes and by renders that loop one.
import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import type { AvatarProvider } from "../providers/types";
import { FOOTAGE_ASPECTS, FOOTAGE_MAX_SEC, FOOTAGE_MAX_SEC_SHORT, FOOTAGE_MIN_SEC, MAX_FOOTAGE_REFERENCES, MAX_FOOTAGE_SEED, footageIdOf, type Background, type BrandKit, type FootageJob, type VideoTemplate } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { decodeDataUrl } from "../providers/image";
import { owned, stripUndefined } from "./shared";
import { jobChecker } from "./job-checks";
import { plainScene, rewriteIfNamed, sniff } from "./backdrops";
import { promptExcerpt } from "./lookpacks";
import { danglingLabels } from "../picture-labels";

/** Generated clips an account keeps; another needs one deleted first. */
export const MAX_FOOTAGE = 50;
/** The longest description of a shot (HeyGen takes far more; a shot is a few sentences). */
export const MAX_FOOTAGE_PROMPT = 2000;
/** A first-frame picture, decoded (the page shrinks larger ones first). */
export const MAX_FOOTAGE_IMAGE_BYTES = 3 * 1024 * 1024;
/** Each picture a clip features, decoded: three of them still fit in one request. */
export const MAX_FOOTAGE_REFERENCE_BYTES = 900 * 1024;
const dataUrlMax = (bytes: number) => Math.ceil((bytes * 4) / 3) + 100;

export const footageRequestSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    /** The shot: what is seen, what happens, how the camera moves. */
    prompt: z.string().trim().min(10, "Describe the shot in a few words").max(MAX_FOOTAGE_PROMPT, `Describe the shot in at most ${MAX_FOOTAGE_PROMPT} characters`),
    // Each message holds for every clip: the limit for one that features pictures or is exact is checked below.
    durationSec: z
      .number("A clip's length is a number of seconds")
      .int("A clip is a whole number of seconds")
      .min(FOOTAGE_MIN_SEC, `A clip is at least ${FOOTAGE_MIN_SEC} seconds`)
      .max(FOOTAGE_MAX_SEC, `A clip is at most ${FOOTAGE_MAX_SEC} seconds (${FOOTAGE_MAX_SEC_SHORT} when it features pictures or follows the description exactly)`)
      .default(FOOTAGE_MIN_SEC),
    /** Ignored shape for a clip from a picture, which takes the picture's shape. */
    aspect: z.enum(FOOTAGE_ASPECTS, `The frame is ${FOOTAGE_ASPECTS.join(", ")}; leave it out for a clip from pictures to follow the first one`).optional(),
    quality: z.enum(["standard", "hd"]).default("standard"),
    /** Send the description to the renderer exactly as written, without its prompt enhancement. */
    exact: z.boolean().optional(),
    /** The take to make again (a clip's seed); the renderer picks one when absent. */
    seed: z.number().int("A seed is a whole number").min(0, "A seed is 0 or more").max(MAX_FOOTAGE_SEED, `A seed is at most ${MAX_FOOTAGE_SEED}`).optional(),
    /** A data URL of a PNG or JPEG the clip opens on, as its first frame. */
    image: z.string().max(dataUrlMax(MAX_FOOTAGE_IMAGE_BYTES), "The picture is larger than 3 MB").optional(),
    /**
     * Data URLs of PNG or JPEG pictures of things the shot must feature (a product, a place, a person), named in the
     * description as <Picture 1>, <Picture 2>… in this order.
     */
    references: z
      // The per-picture check below names the picture; this one still holds when another field stops the object's
      // checks from running.
      .array(z.string().max(dataUrlMax(MAX_FOOTAGE_REFERENCE_BYTES), "Each picture to feature must be at most 900 KB"))
      .min(1, "Add a picture to feature, or leave the pictures out")
      .max(MAX_FOOTAGE_REFERENCES, `A clip features at most ${MAX_FOOTAGE_REFERENCES} pictures`)
      .optional(),
  })
  .strict()
  .refine((v) => !(v.image && v.references), { message: "A clip either opens on one picture or features pictures, not both", path: ["references"] })
  // HeyGen makes clips over 15 seconds only from a description or a first frame, with its prompt enhancement on.
  .refine((v) => v.durationSec <= FOOTAGE_MAX_SEC_SHORT || !(v.references || v.exact), {
    message: `A clip that features pictures, or follows the description exactly, is at most ${FOOTAGE_MAX_SEC_SHORT} seconds`,
    path: ["durationSec"],
  })
  .refine((v) => !(v.image && v.aspect), { message: "A clip from a picture takes the picture's shape; leave the frame out", path: ["aspect"] })
  // Each picture to feature is named by its number when it is too large (the request would be refused whole).
  .superRefine((v, ctx) => {
    (v.references ?? []).forEach((r, i) => {
      if (r.length > dataUrlMax(MAX_FOOTAGE_REFERENCE_BYTES)) {
        const which = (v.references ?? []).length > 1 ? `Picture ${i + 1}` : "The picture to feature";
        ctx.addIssue({ code: "custom", path: ["references", i], message: `${which} must be at most 900 KB` });
      }
    });
  })
  // HeyGen does not rewrite the labels, so one that names no picture sent (or any, with no pictures featured) would
  // point the shot at nothing.
  .superRefine((v, ctx) => {
    const count = v.references?.length ?? 0;
    const missing = danglingLabels(v.prompt, count);
    if (!missing.length) return;
    const names = missing.map((n) => `<Picture ${n}>`).join(", ");
    const featured = count === 0 ? "no picture is featured; feature the pictures or take the labels out" : `${count === 1 ? "one picture is" : `${count} pictures are`} featured`;
    ctx.addIssue({ code: "custom", path: ["prompt"], message: `The description names ${names}, but ${featured}` });
  })
  // HeyGen renders HD in landscape or portrait only, and a clip featuring pictures in the first one's shape at standard only.
  .refine((v) => v.quality !== "hd" || v.image || (v.references ? v.aspect === "16:9" || v.aspect === "9:16" : (v.aspect ?? "16:9") !== "1:1"), {
    message: "HD clips are landscape or portrait; choose 16:9 or 9:16, or standard quality",
    path: ["quality"],
  });
type FootageRequest = z.infer<typeof footageRequestSchema>;

export const footageIdSchema = z.string().regex(/^ft_[A-Za-z0-9_-]{1,64}$/, "Unknown clip");

/** A clip id as a lookup takes it: one that cannot be a clip's reads as not found, like an unknown one. */
function clipId(id: string): string {
  if (!footageIdSchema.safeParse(id).success) throw new NotFoundError("Clip not found");
  return id;
}

/** A client's key for one start (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const footageKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function footageAvailable(): boolean {
  return typeof getAvatarProvider().startFootage === "function";
}

/** What the account sees of a clip: never the renderer, its job id, or the picture's digest, which stay on the server. */
export type PublicFootage = Omit<FootageJob, "ownerId" | "provider" | "providerJobId" | "imageDigest">;
export function publicFootage(job: FootageJob): PublicFootage {
  const { ownerId: _o, provider: _p, providerJobId: _j, imageDigest: _d, ...rest } = job;
  void _o;
  void _p;
  void _j;
  void _d;
  return rest;
}

const checks = jobChecker<FootageJob>((job) => refreshFootage(job));

/** Forgets when clips were last asked about (tests). */
export function forgetFootageChecks(): void {
  checks.forget();
}

/** The account's generated clips, newest first; any still being made, or holding an old link, is asked about first. */
export async function listFootage(ownerId: string = LOCAL_OWNER): Promise<FootageJob[]> {
  const jobs = await getStore().list<FootageJob>("footage", ownerId);
  return (await checks.follow(jobs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A picture of a start, as bytes, checked to be a PNG or JPEG within its size; `which` names it in a refusal. */
function picture(url: string, which: string, maxBytes: number, size: string): { bytes: Uint8Array; mimeType: string } {
  if (!url.startsWith("data:image/")) throw new ValidationError(`${which} must be an image file`);
  let decoded: ReturnType<typeof decodeDataUrl>;
  try {
    decoded = decodeDataUrl(url);
  } catch {
    throw new ValidationError(`${which} is malformed`);
  }
  if (decoded.bytes.byteLength > maxBytes) throw new ValidationError(`${which} is larger than ${size}`);
  const mimeType = sniff(decoded.bytes);
  if (!mimeType) throw new ValidationError(`${which} is not a PNG or JPEG image`);
  return { bytes: decoded.bytes, mimeType };
}

/**
 * Starts generating one clip; the renderer keeps the job and the studio follows it. With a client `key`, the job's id
 * is derived from the account and the key: a start retried with the same key returns the job already stored, or, when
 * the first try reached the renderer but was never stored, sends the renderer the same key and body, so the clip is not
 * made or paid for twice. `admit` runs once everything is checked, before the renderer is asked (the hourly limit).
 */
export async function startFootage(input: FootageRequest, ownerId: string = LOCAL_OWNER, opts: { key?: string; admit?: () => void } = {}): Promise<FootageJob> {
  const image = input.image ? picture(input.image, "The picture", MAX_FOOTAGE_IMAGE_BYTES, "3 MB") : undefined;
  const references = input.references?.map((url, i) => picture(url, input.references!.length > 1 ? `Picture ${i + 1}` : "The picture to feature", MAX_FOOTAGE_REFERENCE_BYTES, "900 KB"));
  // One digest for what the clip is conditioned on: the first frame alone, or the pictures it features, in order.
  const hash = createHash("sha256");
  if (image) hash.update(image.bytes);
  for (const r of references ?? []) hash.update(createHash("sha256").update(r.bytes).digest()).update("\0");
  const imageDigest = image || references ? `${references ? "ref:" : ""}${hash.digest("base64url")}` : undefined;
  // A first frame sets the shape; pictures to feature follow the first one's unless a frame is chosen.
  const aspect = image ? undefined : references ? input.aspect : (input.aspect ?? "16:9");
  const id = opts.key ? `ft_${createHash("sha256").update(`${ownerId}\0${opts.key}`).digest("base64url").slice(0, 32)}` : newId("ft");
  const existing = opts.key ? await getStore().get<FootageJob>("footage", id) : null;
  if (existing && existing.ownerId === ownerId) {
    const same = existing.title === (input.title || promptExcerpt(input.prompt, 60)) && existing.prompt === input.prompt && existing.durationSec === input.durationSec && existing.aspect === aspect && existing.quality === input.quality && (existing.imageDigest ?? "") === (imageDigest ?? "") && (existing.references ?? 0) === (references?.length ?? 0) && !!existing.exact === !!input.exact && existing.seed === input.seed;
    if (!same) throw new ConflictError("This Idempotency-Key was already used for another clip; send a new key");
    return existing;
  }
  const provider = getAvatarProvider();
  if (!provider.startFootage) throw new ValidationError(`Generated clips are not available with the ${provider.name} renderer`);
  // Read then written: two starts at the same moment can between them pass the cap.
  if ((await getStore().list<FootageJob>("footage", ownerId)).length >= MAX_FOOTAGE) throw new ConflictError(`An account keeps at most ${MAX_FOOTAGE} generated clips; delete one to make another`);
  opts.admit?.();
  const { jobId } = await provider.startFootage({ prompt: input.prompt, image, references, durationSec: input.durationSec, aspect, quality: input.quality, exact: input.exact, seed: input.seed, key: id });
  const now = nowIso();
  const job: FootageJob = stripUndefined({
    id,
    ownerId,
    title: input.title || promptExcerpt(input.prompt, 60),
    prompt: input.prompt,
    fromPicture: image ? (true as const) : undefined,
    references: references?.length,
    exact: input.exact ? (true as const) : undefined,
    seed: input.seed,
    durationSec: input.durationSec,
    aspect,
    quality: input.quality,
    imageDigest,
    provider: provider.name,
    providerJobId: jobId,
    status: "processing" as const,
    createdAt: now,
    updatedAt: now,
  });
  return getStore().put("footage", job);
}

/**
 * Forgets one generated clip (the renderer's copy expires on its own). Videos already rendered keep their footage; a
 * retry or copy that loops it is refused. The owner's brand kit and templates stop naming it first (a plain background
 * takes its place, as for a deleted image), so a batch or a video started from them still renders.
 */
export async function deleteFootage(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const job = owned(await getStore().get<FootageJob>("footage", clipId(id)), ownerId, "Clip");
  const names = (bg: Background | undefined) => footageIdOf(bg) === job.id;
  for (const kit of await getStore().list<BrandKit>("brand", ownerId)) {
    await rewriteIfNamed<BrandKit>("brand", kit, (k) => names(k.defaultBackground), (k) => {
      const { defaultBackground: _gone, ...rest } = k;
      void _gone;
      return rest as BrandKit;
    });
  }
  for (const tpl of await getStore().list<VideoTemplate>("template", ownerId)) {
    await rewriteIfNamed<VideoTemplate>("template", tpl, (t) => t.scenes.some((sc) => names(sc.background)), (t) => ({
      ...t,
      scenes: t.scenes.map((sc) => (names(sc.background) ? plainScene(sc) : sc)),
    }));
  }
  await getStore().remove("footage", job.id);
}

/** One of the owner's clips, for a record that will loop it later (a brand kit, a template): a foreign or unknown id reads as not found. */
export async function getFootage(id: string, ownerId: string = LOCAL_OWNER): Promise<FootageJob> {
  return owned(await getStore().get<FootageJob>("footage", clipId(id)), ownerId, "Clip");
}

/**
 * A finished clip of the account with a link fresh enough to use now: for a render that loops it, and for the editor's
 * preview. An old link is renewed first; one the renderer cannot renew is tried as it is.
 */
export async function footageLink(id: string, ownerId: string = LOCAL_OWNER): Promise<{ job: FootageJob; videoUrl: string }> {
  // A clip still being made is asked about here too (a render may come before any listing does), and an old link is
  // renewed; both through the shared checker, so lookups side by side make one renderer call, at most every few seconds.
  const [job] = await checks.follow([owned(await getStore().get<FootageJob>("footage", clipId(id)), ownerId, "Clip")]);
  if (job.status !== "completed" || !job.videoUrl) {
    throw new ValidationError(job.status === "failed" ? `The generated clip "${job.title}" could not be made; choose another background` : `The generated clip "${job.title}" is not ready yet; wait for it, or choose another background`);
  }
  return { job, videoUrl: job.videoUrl };
}

/**
 * A generated clip a scene loops, or a missing one, said as a render's error rather than the store's (another
 * account's clip reads the same as a deleted one, so whether it exists is not told).
 */
export async function footageForRender(id: string, ownerId: string): Promise<{ videoUrl: string }> {
  try {
    return { videoUrl: (await footageLink(id, ownerId)).videoUrl };
  } catch (err) {
    if (err instanceof NotFoundError) throw new ValidationError("A scene loops a generated clip that was deleted; choose another background");
    throw err;
  }
}

/** Whether a renderer loops video backgrounds at all (D-ID shows its own background whatever it is given). */
export function rendersFootage(provider: AvatarProvider): boolean {
  return typeof provider.footageStatus === "function";
}

/** Asks the renderer where a clip stands and stores the answer. Never throws: a failed check keeps what was known. */
async function refreshFootage(job: FootageJob): Promise<FootageJob> {
  try {
    const provider = getAvatarProviderByName(job.provider);
    if (!provider.footageStatus) return job;
    const out = await provider.footageStatus(job.providerJobId);
    const now = nowIso();
    const { videoUrl: _v, width: _w, height: _h, error: _e, ...kept } = job;
    void _v;
    void _w;
    void _h;
    void _e;
    const next: FootageJob = {
      ...kept,
      // The length asked for is kept (it is what a retried start is compared on); the clip's own is in the file.
      ...stripUndefined({ status: out.status, videoUrl: out.videoUrl, width: out.width, height: out.height, error: out.error, takeSeed: out.seed ?? job.takeSeed }),
      checkedAt: now,
      updatedAt: out.status !== job.status ? now : job.updatedAt,
    };
    // Written only over the record that was read, so a delete meanwhile stays deleted.
    return (await getStore().putIf("footage", next, "updatedAt", job.updatedAt)) ? next : job;
  } catch (err) {
    console.error(`clip check failed for ${job.id}:`, err);
    return job;
  }
}
