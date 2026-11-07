// A shared folder: one public link (/collection/:id) listing the folder's videos whose share links can be sent now.
import { z } from "zod";
import { posterUrl, shareOffline } from "../client";
import { NotFoundError, ValidationError } from "../errors";
import { newId, nowIso } from "../ids";
import { LOCAL_OWNER } from "../owner-id";
import { getStore } from "../store";
import type { Video } from "../types";
import { MAX_FOLDER_NAME } from "../types";
import { owned } from "./shared";
import { shareCtaSchema } from "../share-cta";
import { purgeDue } from "./videos";

/** The most videos a collection page lists, the first ones in its order. */
export const COLLECTION_MAX_VIDEOS = 100;

export interface Collection {
  /** Also the link's secret: `/collection/<id>`, a random 20-hex-digit id (unguessable; stop sharing to retire it). */
  id: string;
  ownerId: string;
  /** The library folder it shows, by name; a folder rename carries it along. */
  folder: string;
  createdAt: string;
  updatedAt: string;
  /** How often the public page was opened (one per visitor per window; see the view route). */
  views?: number;
  lastViewedAt?: string;
  /** The heading of the public page in place of the folder's name (one line of plain text); none shows the name. */
  title?: string;
  /** The owner's words for viewers, shown under the page's heading (plain text). */
  note?: string;
  /** How the page lists the videos; none is newest first. */
  order?: CollectionOrder;
  /** A call-to-action button above the videos (its text and where it goes, http or https), as on a video's share page. */
  cta?: { label: string; url: string };
  /** Clicks on the page's button (one per visitor per window; see the cta route), kept when the button changes. */
  ctaClicks?: number;
  lastCtaClickAt?: string;
}

/** One video as a collection page shows it: what its own share page would preview, and no more. */
export interface CollectionVideo {
  id: string;
  title: string;
  durationSec?: number;
  aspect?: string;
  /** The poster, or none for a password-protected link, whose share page previews no picture either. */
  poster?: string;
  locked: boolean;
}

export const collectionSchema = z.object({ folder: z.string().trim().min(1).max(MAX_FOLDER_NAME) });

/** The longest heading a shared folder's page shows. */
export const COLLECTION_TITLE_MAX = 100;
/** The longest note a shared folder's page shows. */
export const COLLECTION_NOTE_MAX = 500;
/** How a shared folder's page can list its videos: newest made first (the default), oldest first, or by title. */
export const COLLECTION_ORDERS = ["newest", "oldest", "title"] as const;
export type CollectionOrder = (typeof COLLECTION_ORDERS)[number];
/**
 * A change to a shared folder's page: its title and its note (an empty one, or one with nothing visible, takes it off),
 * its order, its button (null takes it off), or any of them together. A field left out is left as it is. The title's and the note's lengths are checked
 * by updateCollection once they are tidied, so spaces that tidying removes do not count against them.
 */
export const collectionUpdateSchema = z
  .object({
    title: z.string().optional(),
    note: z.string().optional(),
    order: z.enum(COLLECTION_ORDERS, { error: "The order is newest, oldest, or title" }).optional(),
    cta: shareCtaSchema.optional(),
  })
  .refine((v) => v.title !== undefined || v.note !== undefined || v.order !== undefined || v.cta !== undefined, {
    error: "Send a title, a note, an order, or a button",
  });

/**
 * One write at a time per share, in this process: a page view's read-then-write cannot land after the share was
 * removed (bringing it back) or renamed (moving it back), nor two views count as one. The same in-process limit as the
 * video counters applies across server instances.
 */
const shareQueue = new Map<string, Promise<unknown>>();
function withShareLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (shareQueue.get(id) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  shareQueue.set(id, tail);
  void tail.then(() => {
    if (shareQueue.get(id) === tail) shareQueue.delete(id);
  });
  return run;
}
/** Removes a share under its lock, so a page view in flight cannot write it back. Every removal goes through here. */
export const removeShare = (id: string) => withShareLock(id, () => getStore().remove("collection", id));

const sharesOf = async (ownerId: string) => (await getStore().list<Collection>("collection", ownerId)).filter((c) => c.ownerId === ownerId);
const videosOf = async (ownerId: string) => (await getStore().list<Video>("video", ownerId)).filter((v) => v.ownerId === ownerId);

/** The folder names that still hold a video (the trash included, so a restore brings a folder back to its link). */
function foldersHeld(videos: Video[], now: number): Set<string> {
  return new Set(videos.filter((v) => v.folder && !purgeDue(v, now)).map((v) => v.folder!));
}

/**
 * Drops the shares of folders that hold no video at this moment. The writes that move videos call it at both ends of a
 * move: for the folders a write may have emptied (a video moved out, a folder renamed or removed, a video deleted for
 * good), and, before a video lands, for the folder it is about to land in, so a link left over from an earlier folder
 * of that name (one past retention but not yet purged, say) is gone before the new folder can revive it. `folders`
 * limits it to those folders. Best effort through and through: the move it serves has happened or is about to, so a
 * failure here is logged rather than thrown.
 */
export async function dropEmptyShares(ownerId: string, folders?: string[]): Promise<void> {
  try {
    const shares = (await sharesOf(ownerId)).filter((c) => !folders || folders.includes(c.folder));
    if (!shares.length) return;
    const held = foldersHeld(await videosOf(ownerId), Date.now());
    for (const c of shares) if (!held.has(c.folder)) await removeShare(c.id);
  } catch (err) {
    console.error(`could not drop the empty shared folders of ${ownerId}:`, err);
  }
}

/** The owner's shared folders, by folder name, leaving out any whose folder holds no video (read only, never deleted here). */
export async function listCollections(ownerId: string = LOCAL_OWNER): Promise<Collection[]> {
  const [shares, videos] = await Promise.all([sharesOf(ownerId), videosOf(ownerId)]);
  const held = foldersHeld(videos, Date.now());
  return shares.filter((c) => held.has(c.folder)).sort((a, b) => a.folder.localeCompare(b.folder, undefined, { sensitivity: "base" }) || a.createdAt.localeCompare(b.createdAt));
}

/**
 * Shares a folder: its existing link when it has one (`created: false`), else a new one. A folder with no videos in the
 * library (the trash aside) has nothing to show and is refused.
 */
export async function shareFolder(input: z.infer<typeof collectionSchema>, ownerId: string = LOCAL_OWNER): Promise<{ collection: Collection; created: boolean }> {
  const { folder } = collectionSchema.parse(input);
  // A write, so any share left behind by an emptied folder of this name goes first and cannot come back.
  await dropEmptyShares(ownerId, [folder]);
  const existing = (await sharesOf(ownerId)).find((c) => c.folder === folder);
  if (existing) return { collection: existing, created: false };
  const now = Date.now();
  if (!(await videosOf(ownerId)).some((v) => v.folder === folder && !v.deletedAt && !purgeDue(v, now))) throw new ValidationError(`No video is in the folder “${folder}”`);
  const at = nowIso();
  const collection: Collection = { id: newId("col"), ownerId, folder, createdAt: at, updatedAt: at };
  await getStore().put("collection", collection);
  return { collection, created: true };
}

/**
 * Stops sharing a folder: its link answers "not found" from then on, as does any other link the same folder was given
 * (two shares made at once). The videos and their own links are untouched.
 */
export async function stopSharingFolder(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const share = owned(await getStore().get<Collection>("collection", id), ownerId, `Shared folder ${id}`);
  for (const c of await sharesOf(ownerId)) if (c.folder === share.folder) await removeShare(c.id);
}

// Control characters (C0 and C1, line breaks and tabs among them), zero-width spaces, direction marks and overrides,
// the word joiner, and the byte-order mark: never wanted in a one-line heading. The zero-width joiner (U+200D) stays,
// as emoji sequences use it.
const TITLE_STRIP = /[\p{Cc}\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
/** Something a reader can see: a letter, digit, mark, punctuation, or symbol (emoji included). */
const hasVisible = (s: string) => /[\p{L}\p{N}\p{M}\p{P}\p{S}]/u.test(s);

/**
 * Changes a shared folder's page: its title, its note, and its order (see collectionUpdateSchema). The title is one
 * line: control characters (line breaks and tabs among them), zero-width spaces, and direction marks become spaces, and
 * any run of spaces becomes one. The note is plain text: line breaks are kept (Windows ones become plain), spaces at
 * the ends of lines go, and runs of more than one blank line are closed up. Either is checked against its limit once
 * tidied, and either with nothing visible left is taken off. Newest first is the default, so it is stored as no order.
 * Written under the share's lock, so a page view counted meanwhile is kept.
 */
export async function updateCollection(id: string, input: z.input<typeof collectionUpdateSchema> | unknown, ownerId: string = LOCAL_OWNER): Promise<Collection> {
  const parsed = collectionUpdateSchema.safeParse(input);
  // Said plainly to an API client too, not only as a schema issue.
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid change");
  const { order, cta } = parsed.data;
  let title = parsed.data.title?.replace(TITLE_STRIP, " ").replace(/\s+/g, " ").trim();
  let note = parsed.data.note
    ?.trim()
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (title && title.length > COLLECTION_TITLE_MAX) throw new ValidationError(`Keep the title to ${COLLECTION_TITLE_MAX} characters`);
  if (note && note.length > COLLECTION_NOTE_MAX) throw new ValidationError(`Keep the note to ${COLLECTION_NOTE_MAX} characters`);
  if (title !== undefined && !hasVisible(title)) title = "";
  if (note !== undefined && !hasVisible(note)) note = "";
  return withShareLock(id, async () => {
    const share = owned(await getStore().get<Collection>("collection", id), ownerId, `Shared folder ${id}`);
    const next: Collection = { ...share, updatedAt: nowIso() };
    if (title !== undefined) {
      if (title) next.title = title;
      else delete next.title;
    }
    if (note !== undefined) {
      if (note) next.note = note;
      else delete next.note;
    }
    if (order !== undefined) {
      if (order === "newest") delete next.order;
      else next.order = order;
    }
    if (cta !== undefined) {
      if (cta) next.cta = cta;
      else delete next.cta;
    }
    await getStore().put("collection", next);
    return next;
  });
}

/** Sets or clears a shared folder's note (updateCollection with a note). */
export const setCollectionNote = updateCollection;

/**
 * Keeps shared folders with their videos when a folder is renamed. A plain rename (onto a name no video had) carries
 * the link to the new name. A merge into a folder that already held videos stops the moving link, so the other
 * folder's videos are never published without its own share; that folder keeps its link if it had one. Removing the
 * folder (an empty new name, leaving its videos unfiled) stops its link. `targetHeldVideos` is read before the move.
 */
export async function followFolderRename(from: string, to: string, ownerId: string, targetHeldVideos: boolean): Promise<void> {
  if (from === to) return;
  const shares = await sharesOf(ownerId);
  const carry = !!to && !targetHeldVideos;
  // A name that held no video has no live share; any left over from an earlier folder of that name goes (whether or not
  // this folder is shared), so it can neither publish the renamed videos nor stand beside the link being carried.
  if (carry) for (const c of shares) if (c.folder === to) await removeShare(c.id);
  const moving = shares.filter((c) => c.folder === from);
  for (const c of moving) {
    if (!carry) {
      await removeShare(c.id);
      continue;
    }
    // Read again under the lock, so a view counted since the listing is carried along, not written over.
    await withShareLock(c.id, async () => {
      const current = await getStore().get<Collection>("collection", c.id);
      if (current) await getStore().put("collection", { ...current, folder: to, updatedAt: nowIso() });
    });
  }
}

/**
 * Counts an open of a shared folder's public page. Public: no owner check. A share whose folder holds no video (its
 * page answers not found) is a NotFoundError and counts nothing. `gate` is the route's per-visitor window, asked only
 * for a page that shows, so a visit to a dead link does not use up the visitor's slot.
 */
export function recordCollectionView(id: string, gate: () => boolean = () => true, now = Date.now()): Promise<{ views: number; counted: boolean }> {
  return withShareLock(id, async () => {
    const collection = await getStore().get<Collection>("collection", id);
    if (!collection || !foldersHeld(await videosOf(collection.ownerId), now).has(collection.folder)) throw new NotFoundError("Collection not found");
    if (!gate()) return { views: collection.views ?? 0, counted: false };
    const views = (collection.views ?? 0) + 1;
    await getStore().put("collection", { ...collection, views, lastViewedAt: new Date(now).toISOString() });
    return { views, counted: true };
  });
}

/**
 * Counts a click on a shared folder's button. Public, like recordCollectionView: an unknown share is a NotFoundError;
 * a page without a button (taken off since the visitor loaded it) counts nothing, answered before the owner's videos
 * are read; and a button on a share whose folder holds no video is a NotFoundError. `gate` is the route's per-visitor
 * window, asked only for a click that would count.
 */
export function recordCollectionCtaClick(id: string, gate: () => boolean = () => true, now = Date.now()): Promise<{ clicks: number; counted: boolean }> {
  return withShareLock(id, async () => {
    const collection = await getStore().get<Collection>("collection", id);
    if (!collection) throw new NotFoundError("Collection not found");
    if (!collection.cta) return { clicks: collection.ctaClicks ?? 0, counted: false };
    if (!foldersHeld(await videosOf(collection.ownerId), now).has(collection.folder)) throw new NotFoundError("Collection not found");
    if (!gate()) return { clicks: collection.ctaClicks ?? 0, counted: false };
    const clicks = (collection.ctaClicks ?? 0) + 1;
    await getStore().put("collection", { ...collection, ctaClicks: clicks, lastCtaClickAt: new Date(now).toISOString() });
    return { clicks, counted: true };
  });
}

/**
 * The way through a shared folder from one of its videos' share pages, for a viewer who opened the folder's page (it
 * notes its share id in the viewer's browser, see folder-visit.ts): the folder page's address and heading, and the
 * video after this one in the page's order, if the page lists one. None unless that share exists, belongs to the
 * video's owner, and shows the video's folder, so a made-up or stale id adds nothing to the page and reveals nothing.
 * The video itself is in the folder and its share page shows, so the folder's page shows too.
 */
export async function collectionNav(
  from: unknown,
  video: Pick<Video, "id" | "ownerId" | "folder">,
  now = Date.now(),
): Promise<{ href: string; label: string; next: { id: string; href: string; title: string } | null } | null> {
  if (typeof from !== "string" || !/^col_[0-9a-f]{1,64}$/.test(from) || !video.folder) return null;
  const collection = await getStore().get<Collection>("collection", from);
  if (!collection || collection.ownerId !== (video.ownerId ?? LOCAL_OWNER) || collection.folder !== video.folder) return null;
  // The folder's page lists at most COLLECTION_MAX_VIDEOS; the way on follows that list and stops where it does.
  const listed = sendableIn(await videosOf(collection.ownerId), collection, now).slice(0, COLLECTION_MAX_VIDEOS);
  const at = listed.findIndex((v) => v.id === video.id);
  const after = at >= 0 ? listed[at + 1] : undefined;
  return {
    href: `/collection/${encodeURIComponent(collection.id)}`,
    label: collection.title || collection.folder,
    next: after ? { id: after.id, href: `/share/${encodeURIComponent(after.id)}`, title: after.title } : null,
  };
}

/** A shared folder's videos whose own links can be sent now, in its page's order. */
function sendableIn(all: Video[], collection: Collection, now: number): Video[] {
  return all
    .filter((v) => v.folder === collection.folder && v.status === "completed" && !shareOffline(v, now))
    .sort(videoOrder(collection.order));
}

const newestFirst = (a: Video, b: Video) => b.createdAt.localeCompare(a.createdAt);
/** The page's order: newest made first, oldest first, or by title (as a person reads it: case aside, "2" before "10"), newest first among equal titles. */
function videoOrder(order: CollectionOrder = "newest"): (a: Video, b: Video) => number {
  if (order === "oldest") return (a, b) => a.createdAt.localeCompare(b.createdAt);
  if (order === "title") return (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) || newestFirst(a, b);
  return newestFirst;
}

/**
 * The public page of a shared folder: its name and the videos in it whose own share link a viewer can open now
 * (rendered, out of the trash, switched on, live, not expired), in the share's order, at most COLLECTION_MAX_VIDEOS of them,
 * with `total` the count before that cap. A link with a password still lists, without its picture; its page asks for
 * the password, as an email gate asks for an email. An unknown id, or a share whose folder holds no video any more,
 * is a NotFoundError.
 */
export async function collectionPage(id: string, now = Date.now()): Promise<{ collection: Collection; videos: CollectionVideo[]; total: number }> {
  const collection = await getStore().get<Collection>("collection", id);
  if (!collection) throw new NotFoundError("Collection not found");
  const all = await videosOf(collection.ownerId);
  // Read only: a share whose folder holds no video answers not found (the write that emptied it drops it).
  if (!foldersHeld(all, now).has(collection.folder)) throw new NotFoundError("Collection not found");
  const sendable = sendableIn(all, collection, now);
  const videos = sendable.slice(0, COLLECTION_MAX_VIDEOS).map((v) => ({
    id: v.id,
    title: v.title,
    durationSec: v.durationSec,
    aspect: v.aspect,
    poster: v.shareLocked ? undefined : posterUrl(v),
    locked: !!v.shareLocked,
  }));
  return { collection, videos, total: sendable.length };
}
