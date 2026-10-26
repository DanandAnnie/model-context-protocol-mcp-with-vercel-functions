// Uploaded background images: a scene names one as `{ type: "image", value: "/api/backdrops/<id>" }`,
// the editor previews it from that path, and the renderer receives it as a provider asset. Used by API routes only.
//
// The metadata row (`backdrop`) is what lists and renders read; the bytes live in their own row
// (`backdropdata`), like clip audio, so listing backdrops never pulls images.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { decodeDataUrl } from "../providers/image";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { LOCAL_OWNER } from "../owner-id";
import { MAX_BACKDROPS, backdropIdOf, type Backdrop, type BackdropType, type Background, type BrandKit, type VideoTemplate } from "../types";

export { MAX_BACKDROPS };
import { owned } from "./shared";

/** Fits one request body on Vercel (4.5 MB) once base64-encoded; the editor shrinks larger pictures before sending. */
export const MAX_BACKDROP_BYTES = 3 * 1024 * 1024;

export const backdropUploadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** A data URL of a PNG or JPEG image. */
  image: z.string().min(1).max(4_300_000),
});

type BackdropData = { id: string; backdropId: string; ownerId?: string; mimeType: BackdropType; data: string };

/** Prefixed like every other side record: the Supabase table keys every kind by id alone. */
const dataRowId = (backdropId: string) => `backdropdata_${backdropId}`;

/** The image type from the file's first bytes, so a renamed file cannot pass as a picture. */
function sniff(b: Uint8Array): BackdropType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

/** What the API returns: provider asset ids stay on the server. */
const view = ({ providerAssetIds: _ids, ...rest }: Backdrop): Backdrop => rest;

export async function listBackdrops(ownerId: string = LOCAL_OWNER): Promise<Backdrop[]> {
  const items = await getStore().list<Backdrop>("backdrop", ownerId);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view);
}

export async function createBackdrop(input: z.infer<typeof backdropUploadSchema>, ownerId: string = LOCAL_OWNER): Promise<Backdrop> {
  if (!input.image.startsWith("data:image/")) throw new ValidationError("The background must be an image file");
  let decoded: ReturnType<typeof decodeDataUrl>;
  try {
    decoded = decodeDataUrl(input.image);
  } catch {
    throw new ValidationError("The image data is malformed");
  }
  if (decoded.bytes.byteLength > MAX_BACKDROP_BYTES) throw new ValidationError("The image is too large (3 MB max)");
  const mimeType = sniff(decoded.bytes);
  // The editor turns WebP and GIF into JPEG before sending, so anything else here is not a picture at all.
  if (!mimeType) throw new ValidationError("That file is not a picture this app can use (PNG, JPEG, WebP, or GIF)");
  if ((await getStore().list<Backdrop>("backdrop", ownerId)).length >= MAX_BACKDROPS) {
    throw new ConflictError(`At most ${MAX_BACKDROPS} background images per account; delete one you no longer use`);
  }
  const backdrop: Backdrop = { id: newId("bd"), ownerId, name: input.name, mimeType, bytes: decoded.bytes.byteLength, createdAt: nowIso() };
  // Bytes first: a backdrop row that is listed always has its image. If the listed row cannot be written, the bytes
  // are taken back out, since account deletion finds bytes only through their backdrop row.
  await getStore().put<BackdropData>("backdropdata", { id: dataRowId(backdrop.id), backdropId: backdrop.id, ownerId, mimeType, data: Buffer.from(decoded.bytes).toString("base64") });
  try {
    return view(await getStore().put("backdrop", backdrop));
  } catch (err) {
    await getStore().remove("backdropdata", dataRowId(backdrop.id)).catch(() => undefined);
    throw err;
  }
}

/** The stored backdrop with provider asset ids, for rendering. */
export async function getBackdrop(id: string, ownerId: string = LOCAL_OWNER): Promise<Backdrop> {
  return owned(await getStore().get<Backdrop>("backdrop", id), ownerId, `Background image ${id}`);
}

export async function getBackdropImage(id: string, ownerId: string = LOCAL_OWNER): Promise<{ mimeType: BackdropType; bytes: Uint8Array }> {
  await getBackdrop(id, ownerId);
  const row = await getStore().get<BackdropData>("backdropdata", dataRowId(id));
  if (!row) throw new NotFoundError(`Background image ${id} has no image`);
  return { mimeType: row.mimeType, bytes: new Uint8Array(Buffer.from(row.data, "base64")) };
}

/**
 * Records the provider's asset id so later renders (retries, copies, other scenes) skip the upload. The write is
 * conditional on the row still being there, so a backdrop deleted meanwhile is not brought back without its image.
 */
export async function saveBackdropAssetIds(backdrop: Backdrop, ids: Record<string, string>): Promise<Backdrop> {
  const merged = (b: Backdrop): Backdrop => ({ ...b, providerAssetIds: { ...b.providerAssetIds, ...ids } });
  const current = await getStore().get<Backdrop>("backdrop", backdrop.id);
  if (!current) return merged(backdrop);
  const next = merged(current);
  await getStore().putIf("backdrop", next, "createdAt", current.createdAt);
  return next;
}

/** What a template scene or the brand kit shows in place of an image that was deleted: the editor's plain background. */
export const PLAIN_BACKGROUND: Background = { type: "color", value: "#f1f5f9" };

/**
 * Deletes a backdrop and its image. Videos already rendered keep their footage; a retry or copy that names it is
 * refused. The owner's templates and brand kit stop naming it (a plain background takes its place), so a batch or a
 * new video started from them still renders instead of failing on an image that is gone.
 */
export async function deleteBackdrop(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  await getBackdrop(id, ownerId);
  // Bytes first: a failure part-way leaves the listed row, so deleting again finishes the job instead of orphaning the image.
  await getStore().remove("backdropdata", dataRowId(id));
  await getStore().remove("backdrop", id);
  const names = (bg: Background | undefined) => backdropIdOf(bg) === id;
  for (const kit of await getStore().list<BrandKit>("brand", ownerId)) {
    if (!names(kit.defaultBackground)) continue;
    const { defaultBackground: _gone, ...rest } = kit;
    void _gone;
    await getStore().put("brand", { ...rest, updatedAt: nowIso() });
  }
  for (const tpl of await getStore().list<VideoTemplate>("template", ownerId)) {
    if (!tpl.scenes.some((sc) => names(sc.background))) continue;
    await getStore().put("template", { ...tpl, scenes: tpl.scenes.map((sc) => (names(sc.background) ? { ...sc, background: PLAIN_BACKGROUND } : sc)), updatedAt: nowIso() });
  }
}
