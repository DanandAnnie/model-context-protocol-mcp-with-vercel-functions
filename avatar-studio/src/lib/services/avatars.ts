// Avatars: library presenters and custom photo avatars. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { LOOK_KEYS, getAvatarProvider } from "../providers";
import { getStore } from "../store";
import type { Agent, Avatar, LookPackJob, MadeLook, PortraitJob, TwinJob } from "../types";
import { createHash } from "node:crypto";
import { LOCAL_OWNER } from "../owner-id";
import { memo } from "../cache";
import { LIST_TTL_MS, owned } from "./shared";
import { listVoices } from "./voices";
import { NotFoundError, ValidationError } from "../errors";
import { loadImage } from "../providers/image";
import type { FetchLike } from "../safe-fetch";
import { UnsafeUrlError } from "../safe-url";
import { shootPhotoLink, shootPhotoSchema } from "./shoots";
import { sniff } from "./backdrops";

/** Provider avatar list, memoised per provider for a few minutes. */
export function providerAvatars(): Promise<Avatar[]> {
  const p = getAvatarProvider();
  return memo(`avatars:${p.name}`, LIST_TTL_MS, () => p.listAvatars());
}

/**
 * Looks the studio made in the renderer's account for any account: the photo avatars made from uploaded portraits, the
 * presenters drawn from a description, and the looks of look packs. The renderer lists them with its own library, to
 * every account that shares its key; they are an account's own and are never offered to another (each account sees its
 * photo avatars instead). A look stays left out after the avatar, portrait, or account that made it is deleted, as the
 * renderer keeps it (see `rememberMadeLooks`).
 */
async function studioMadeLooks(): Promise<Set<string>> {
  const [avatars, portraits, packs, twins, made] = await Promise.all([getStore().list<Avatar>("avatar"), getStore().list<PortraitJob>("portrait"), getStore().list<LookPackJob>("lookpack"), getStore().list<TwinJob>("twin"), getStore().list<MadeLook>("madelook")]);
  return new Set(
    [...avatars.flatMap((a) => madeLooksOf("avatar", a)), ...portraits.map((p) => p.providerJobId), ...packs.flatMap((p) => p.lookIds), ...twins.map((t) => t.lookId), ...made.map((m) => m.lookId)].filter(Boolean),
  );
}

/**
 * Notes looks the studio made in the renderer's shared account, kept whatever becomes of the record that made them (one
 * row per look, by a hash of its id, with no owner, so deleting an account keeps them too). Written as each look is made
 * (a photo avatar prepared, a presenter drawn, a pack started) and again when its record is deleted.
 */
export async function rememberMadeLooks(lookIds: Iterable<string | undefined>): Promise<void> {
  const ids = [...new Set([...lookIds].filter((id): id is string => !!id))];
  await Promise.all(ids.map((lookId) => getStore().put<MadeLook>("madelook", { id: `ml_${createHash("sha256").update(lookId).digest("base64url").slice(0, 32)}`, lookId })));
}

/** The looks a stored record made at the renderer: an avatar's uploads, a drawn portrait, or a pack's looks. */
export function madeLooksOf(kind: string, item: unknown): string[] {
  const row = item as Partial<Avatar & PortraitJob & LookPackJob>;
  // Only the renderer's looks; an upload only the studio uses (D-ID's hosted portrait) is not kept after its avatar.
  if (kind === "avatar") return LOOK_KEYS.map((k) => row.providerAssetIds?.[k]).filter((id): id is string => !!id);
  if (kind === "portrait") return row.providerJobId ? [row.providerJobId] : [];
  if (kind === "lookpack") return row.lookIds ?? [];
  if (kind === "twin") return (row as { lookId?: string }).lookId ? [(row as { lookId: string }).lookId] : [];
  return [];
}

/** The renderer's library without the looks made for accounts here (see `studioMadeLooks`). */
async function sharedProviderAvatars(): Promise<Avatar[]> {
  const [provider, made] = await Promise.all([providerAvatars(), studioMadeLooks()]);
  return provider.filter((a) => !made.has(a.id));
}

export async function listAvatars(ownerId: string = LOCAL_OWNER): Promise<Avatar[]> {
  const [provider, custom] = await Promise.all([sharedProviderAvatars(), getStore().list<Avatar>("avatar", ownerId)]);
  custom.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return [...custom, ...provider];
}

export async function getAvatar(id: string, ownerId: string = LOCAL_OWNER): Promise<Avatar> {
  const custom = await getStore().get<Avatar>("avatar", id);
  if (custom) return owned(custom, ownerId, `Avatar ${id}`);
  const match = (await sharedProviderAvatars()).find((a) => a.id === id);
  if (!match) throw new NotFoundError(`Avatar ${id} not found`);
  return match;
}

export const createAvatarSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    imageUrl: z
      .string()
      .min(1)
      .max(8_000_000, "Uploaded image must be under 6 MB")
      .refine((v) => v.startsWith("data:image/") || /^https?:\/\//.test(v), "Must be an image URL or uploaded image")
      .optional(),
    /** A photo of one of the account's photo shoots to make the presenter of instead of a picture sent (1 for its first). */
    shootPhoto: shootPhotoSchema.optional(),
    gender: z.enum(["male", "female", "neutral"]).optional(),
    /** A voice from `GET /api/voices` (the owner's clones included) the editor picks with this avatar. */
    defaultVoiceId: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => v.imageUrl || v.shootPhoto, { message: "Add a portrait: upload one, paste its address, or pick a photo shoot's photo", path: ["imageUrl"] })
  .refine((v) => !(v.imageUrl && v.shootPhoto), { message: "A photo avatar is made from a portrait sent or from a photo shoot's photo, not both", path: ["shootPhoto"] });

export const generatePortraitSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(20, "Describe the presenter in at least 20 characters").max(1000),
});

/** The studio's own portrait job ids: HeyGen's look ids never leave the server. */
export const portraitJobIdSchema = z.string().regex(/^pt_[A-Za-z0-9_-]{1,64}$/, "Unknown portrait");

/**
 * The largest portrait kept: its data URL must fit both the reply that carries it (Vercel answers at most 4.5 MB) and
 * the photo avatar upload it is saved with (`createAvatarSchema`, also one request).
 */
export const MAX_PORTRAIT_BYTES = 3 * 1024 * 1024;

/** How long a portrait job is kept to be followed; older ones are cleared when the account starts another. */
const PORTRAIT_JOB_TTL_MS = 24 * 60 * 60 * 1000;

export function portraitGenerationAvailable(): boolean {
  return typeof getAvatarProvider().generatePortrait === "function";
}

/**
 * Starts a portrait of a presenter who does not exist, drawn by the renderer from a description (HeyGen's prompt to
 * avatar). Only a job is kept, under the account that asked: the finished portrait becomes a photo avatar only when
 * it is saved like an upload.
 */
export async function startPortrait(input: z.infer<typeof generatePortraitSchema>, ownerId: string = LOCAL_OWNER): Promise<{ jobId: string }> {
  const provider = getAvatarProvider();
  if (!provider.generatePortrait) throw new ValidationError(`Generating a presenter is not available with the ${provider.name} renderer`);
  const now = Date.now();
  for (const old of await getStore().list<PortraitJob>("portrait", ownerId)) {
    if (now - Date.parse(old.createdAt) <= PORTRAIT_JOB_TTL_MS) continue;
    // The drawn look stays at the renderer; it stays the studio's, never offered to other accounts.
    await rememberMadeLooks(madeLooksOf("portrait", old));
    await getStore().remove("portrait", old.id);
  }
  const { jobId } = await provider.generatePortrait({ name: input.name, prompt: input.prompt });
  await rememberMadeLooks([jobId]);
  const job: PortraitJob = { id: newId("pt"), ownerId, provider: provider.name, providerJobId: jobId, status: "processing", createdAt: nowIso() };
  await getStore().put("portrait", job);
  return { jobId: job.id };
}

/**
 * Where one of the account's portrait jobs stands. A finished one is returned as a data URL, read once through the
 * public-address guard and kept on the job, so the photo avatar made from it keeps its picture after the provider's
 * link expires and following it again asks the provider for nothing.
 */
export async function portraitStatus(jobId: string, ownerId: string = LOCAL_OWNER, fetchImpl?: FetchLike): Promise<{ status: "processing" | "completed" | "failed"; imageUrl?: string; error?: string }> {
  const job = owned(await getStore().get<PortraitJob>("portrait", portraitJobIdSchema.parse(jobId)), ownerId, "Portrait");
  if (job.status !== "processing") return { status: job.status, ...(job.imageUrl ? { imageUrl: job.imageUrl } : {}), ...(job.error ? { error: job.error } : {}) };
  const provider = getAvatarProvider();
  if (provider.name !== job.provider || !provider.portraitStatus) throw new ValidationError("That portrait was started with another renderer");
  const out = await provider.portraitStatus(job.providerJobId);
  if (out.status === "processing") return { status: "processing" };
  let done: PortraitJob;
  if (out.status === "failed" || !out.imageUrl) {
    done = { ...job, status: "failed", error: out.error ?? "The presenter could not be drawn" };
  } else if (out.imageUrl.startsWith("data:")) {
    done = { ...job, status: "completed", imageUrl: out.imageUrl };
  } else {
    try {
      const { bytes, mimeType } = await loadImage(out.imageUrl, fetchImpl);
      done =
        bytes.byteLength > MAX_PORTRAIT_BYTES
          ? { ...job, status: "failed", error: "The portrait came back larger than a photo avatar may be" }
          : { ...job, status: "completed", imageUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}` };
    } catch (err) {
      // The picture is drawn but could not be fetched (expired, moved, not an image): the job ends there.
      console.error(err);
      done = { ...job, status: "failed", error: "The portrait was drawn but could not be downloaded; draw it again" };
    }
  }
  await getStore().put("portrait", done);
  return { status: done.status, ...(done.imageUrl ? { imageUrl: done.imageUrl } : {}), ...(done.error ? { error: done.error } : {}) };
}

/** A default voice must be one the owner can render with, like the brand kit's. */
async function assertVoiceAvailable(voiceId: string, ownerId: string): Promise<void> {
  if (!(await listVoices(ownerId)).some((v) => v.id === voiceId)) throw new ValidationError(`Voice ${voiceId} is not available`);
}

/**
 * A photo of one of the account's photo shoots as a photo avatar's portrait. The renderer's link expires within the
 * day, so the photo is read once, through the public-address guard, and kept as a data URL, like a drawn portrait.
 */
async function shootPortrait(from: z.infer<typeof shootPhotoSchema>, ownerId: string, fetchImpl?: FetchLike): Promise<string> {
  const link = await shootPhotoLink(from.shootId, from.photo, ownerId);
  // The demo's photos are drawn by the studio itself and kept as they are.
  if (link.url.startsWith("data:")) return link.url;
  let picture: { bytes: Uint8Array; mimeType: string };
  try {
    picture = await loadImage(link.url, fetchImpl);
  } catch (err) {
    console.error(err);
    // A photo that is not one to keep says why; trying again helps only when the download itself failed.
    const kept = err instanceof UnsafeUrlError || (err instanceof Error && /too large|redirects|did not return an image/.test(err.message));
    throw new ValidationError(kept ? `Photo ${from.photo} cannot be kept as a portrait (${err instanceof Error ? err.message.replace(/^Avatar /, "").replace(/\.$/, "") : "unknown"}); download it and upload it instead` : `Photo ${from.photo} could not be downloaded just now; try again in a few minutes`);
  }
  const mimeType = sniff(picture.bytes);
  if (!mimeType) throw new ValidationError(`Photo ${from.photo} is not a PNG or JPEG image; download it and upload a copy that is`);
  if (picture.bytes.byteLength > MAX_PORTRAIT_BYTES) throw new ValidationError(`Photo ${from.photo} is larger than ${MAX_PORTRAIT_BYTES / 1024 / 1024} MB, the most a photo avatar keeps; download it and upload a copy under 4 MB`);
  return `data:${mimeType};base64,${Buffer.from(picture.bytes).toString("base64")}`;
}

export async function createAvatar(input: z.infer<typeof createAvatarSchema>, ownerId: string = LOCAL_OWNER, fetchImpl?: FetchLike): Promise<Avatar> {
  if (input.defaultVoiceId) await assertVoiceAvailable(input.defaultVoiceId, ownerId);
  const imageUrl = input.shootPhoto ? await shootPortrait(input.shootPhoto, ownerId, fetchImpl) : input.imageUrl;
  if (!imageUrl) throw new ValidationError("Add a portrait: upload one, paste its address, or pick a photo shoot's photo");
  const avatar: Avatar = {
    id: newId("av"),
    ownerId,
    name: input.name,
    imageUrl,
    gender: input.gender,
    ...(input.defaultVoiceId ? { defaultVoiceId: input.defaultVoiceId } : {}),
    source: "custom",
    provider: getAvatarProvider().name,
    tags: ["photo avatar"],
    createdAt: nowIso(),
  };
  return getStore().put("avatar", avatar);
}

export const updateAvatarSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    /** `null` clears the gender. */
    gender: z.enum(["male", "female", "neutral"]).nullable().optional(),
    /** `null` clears the default voice. */
    defaultVoiceId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.gender !== undefined || v.defaultVoiceId !== undefined, "Nothing to update");

/**
 * Renames a photo avatar, changes its gender, or sets its default voice. Library presenters belong to the provider and
 * cannot be edited (404, like any avatar that is not the owner's). Videos keep the name they
 * were rendered with; new renders and shared presenters (which copy the name) pick up the new one.
 */
export async function updateAvatar(id: string, patch: z.infer<typeof updateAvatarSchema>, ownerId: string = LOCAL_OWNER): Promise<Avatar> {
  const existing = owned(await getStore().get<Avatar>("avatar", id), ownerId, `Avatar ${id}`);
  const next: Avatar = { ...existing };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.gender === null) delete next.gender;
  else if (patch.gender !== undefined) next.gender = patch.gender;
  if (patch.defaultVoiceId === null) delete next.defaultVoiceId;
  else if (patch.defaultVoiceId !== undefined) {
    await assertVoiceAvailable(patch.defaultVoiceId, ownerId);
    next.defaultVoiceId = patch.defaultVoiceId;
  }
  const saved = await getStore().put("avatar", next);
  if (patch.name !== undefined) {
    // Every presenter still carrying another name is brought in step (so a rename repeated after a
    // failed write heals the stragglers); a failed write is logged, never a 500 for a rename that landed.
    const stale = (await getStore().list<Agent>("agent", ownerId)).filter((a) => a.avatarId === id && a.avatarName !== saved.name);
    const results = await Promise.allSettled(stale.map((a) => getStore().put("agent", { ...a, avatarName: saved.name, updatedAt: nowIso() })));
    for (const r of results) if (r.status === "rejected") console.error("presenter rename failed:", r.reason);
  }
  return saved;
}

export async function deleteAvatar(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const avatar = owned(await getStore().get<Avatar>("avatar", id), ownerId, `Avatar ${id}`);
  // The renderer keeps the look; it stays the studio's, never offered to other accounts.
  await rememberMadeLooks(madeLooksOf("avatar", avatar));
  await getStore().remove("avatar", id);
}
