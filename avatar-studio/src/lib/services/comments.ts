// Comments on videos: review notes from the owner or workspace members. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import type { Video, VideoComment, Workspace } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { isWorkspaceId, type User } from "../workspaces";
import { config } from "../config";
import { getEmailProvider, mentionEmail } from "../providers/email";
import { reserveRateLimit } from "../rate-limit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { owned } from "./shared";
import { formatTimestamp } from "../text";

export const MAX_COMMENTS_PER_VIDEO = 200;

/** Longest point a comment can be pinned to, in seconds (a render is never close to this). */
const MAX_COMMENT_AT_SEC = 4 * 3600;

export const commentSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  /** Seconds from the start; `null` reads as a note on the whole video, as an API client may send for an empty field. */
  atSec: z.preprocess((v) => (v === null ? undefined : v), z.number().finite().min(0).max(MAX_COMMENT_AT_SEC).optional()),
});

/** How many people one comment can notify. */
export const MAX_MENTIONS = 10;

/** Mention emails one person can set off per hour, and the whole instance; past either, comments still post but nobody is emailed. */
export const MENTION_EMAILS_PER_HOUR = 60;
export const MENTION_EMAILS_PER_HOUR_GLOBAL = 600;
const HOUR_MS = 60 * 60 * 1000;

/**
 * `@` at the start or after a space or opening punctuation, followed by an email address, so the middle
 * of a plain address (`alice@bob@example.com`) is not a mention; the address ends before trailing punctuation.
 */
const MENTION = /(?:^|[\s(\[,;:])@([\p{L}\p{N}._%+'-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,})/gu;

/**
 * Workspace members named as `@email` in a comment, matched without regard to case, in order of first
 * mention, the author left out. Addresses that are not members are ignored: a mention only reaches people
 * who can already open the video.
 */
export function findMentions(text: string, ws: Pick<Workspace, "members">, authorId: string): Array<{ userId: string; email: string }> {
  const out: Array<{ userId: string; email: string }> = [];
  for (const match of text.matchAll(MENTION)) {
    const email = match[1].replace(/\.+$/, "").toLowerCase();
    const member = ws.members.find((m) => m.email && m.email.toLowerCase() === email);
    if (!member || member.userId === authorId || out.some((o) => o.userId === member.userId)) continue;
    out.push({ userId: member.userId, email: member.email! });
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

async function ownedVideo(videoId: string, ownerId: string): Promise<Video> {
  return owned(await getStore().get<Video>("video", videoId), ownerId, `Video ${videoId}`);
}

/** Comments on a video the owner can read, oldest first. */
export async function listComments(videoId: string, ownerId: string = LOCAL_OWNER): Promise<VideoComment[]> {
  await ownedVideo(videoId, ownerId);
  const all = await getStore().list<VideoComment>("comment", ownerId);
  return all.filter((c) => c.videoId === videoId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addComment(videoId: string, input: z.infer<typeof commentSchema>, ownerId: string = LOCAL_OWNER, author: User = { id: ownerId }): Promise<VideoComment> {
  const video = await ownedVideo(videoId, ownerId);
  const existing = await listComments(videoId, ownerId);
  if (existing.length >= MAX_COMMENTS_PER_VIDEO) throw new ValidationError(`At most ${MAX_COMMENTS_PER_VIDEO} comments per video`);
  if (input.atSec !== undefined) {
    if (video.status !== "completed") throw new ValidationError("A note can be pinned to a moment once the video has finished rendering");
    // A player reports a little past the stated length at the very end, so half a second of slack. Demo
    // renders all play one sample clip while their length is estimated from the script, so the two differ.
    if (video.provider !== "mock" && video.durationSec && input.atSec > video.durationSec + 0.5) {
      throw new ValidationError(`That point is past the end of the video (${formatTimestamp(video.durationSec)})`);
    }
  }
  const comment: VideoComment = {
    id: newId("cmt"),
    ownerId,
    videoId,
    authorId: author.id,
    ...(author.email ? { authorEmail: author.email } : {}),
    text: input.text,
    ...(input.atSec !== undefined ? { atSec: Math.round(input.atSec * 10) / 10 } : {}),
    createdAt: nowIso(),
    rev: newId("rev"),
  };
  if (isWorkspaceId(ownerId)) {
    const ws = await getStore().get<Workspace>("workspace", ownerId);
    const mentions = ws ? findMentions(input.text, ws, author.id) : [];
    if (mentions.length) {
      comment.mentions = mentions;
      comment.notified = mentions.map((m) => m.userId);
    }
  }
  return getStore().put("comment", comment);
}

/**
 * Emails each member a comment mentions, with the comment and a link that opens the video in its
 * workspace. Best effort: one failed send is logged and does not stop the others.
 */
export async function notifyMentions(comment: VideoComment): Promise<number> {
  if (!comment.mentions?.length) return 0;
  const video = await getStore().get<Video>("video", comment.videoId);
  if (!video) return 0;
  // Posting and deleting a comment in a loop would otherwise mail teammates without limit.
  const n = comment.mentions.length;
  const sender = reserveRateLimit(`mention-email:sender:${comment.authorId}`, n, MENTION_EMAILS_PER_HOUR, HOUR_MS);
  if (!sender.allowed || !reserveRateLimit("mention-email:global", n, MENTION_EMAILS_PER_HOUR_GLOBAL, HOUR_MS).allowed) {
    console.warn(`mention emails for comment ${comment.id} skipped: hourly limit reached`);
    return 0;
  }
  // A pinned note's link opens the player at its moment (`t`, whole seconds).
  const at = comment.atSec !== undefined ? `&t=${Math.floor(comment.atSec)}` : "";
  const url = `${config.appUrl.replace(/\/$/, "")}/videos/${encodeURIComponent(video.id)}?ws=${encodeURIComponent(comment.ownerId)}${at}`;
  let sent = 0;
  for (const m of comment.mentions) {
    try {
      await getEmailProvider().send(mentionEmail({ to: m.email, authorEmail: comment.authorEmail, videoTitle: video.title, text: comment.text, url, ...(comment.atSec !== undefined ? { at: formatTimestamp(comment.atSec) } : {}) }));
      sent++;
    } catch (err) {
      console.error(`mention email to ${m.email} failed:`, err);
    }
  }
  return sent;
}

/** The author may delete their own comment; anyone else with access gets 403. */
export async function deleteComment(videoId: string, commentId: string, ownerId: string = LOCAL_OWNER, author: User = { id: ownerId }): Promise<void> {
  await ownedVideo(videoId, ownerId);
  const comment = await getStore().get<VideoComment>("comment", commentId);
  if (!comment || comment.videoId !== videoId || comment.ownerId !== ownerId) throw new NotFoundError("Comment not found");
  if (comment.authorId !== author.id) throw new ForbiddenError("Only the author can delete this comment");
  await getStore().remove("comment", commentId);
}

/**
 * Writes a changed note over the one read, only while it is still that one: a note deleted meanwhile (by its
 * author, or with its video) stays deleted, and one changed meanwhile (edited while being resolved, say) is not
 * overwritten. A note from before revisions is matched by when it was written.
 */
async function rewrite(prev: VideoComment, next: VideoComment): Promise<VideoComment> {
  const stamped = { ...next, rev: newId("rev") };
  const written = prev.rev ? await getStore().putIf("comment", stamped, "rev", prev.rev) : await getStore().putIf("comment", stamped, "createdAt", prev.createdAt);
  if (written) return stamped;
  if (!(await getStore().get<VideoComment>("comment", prev.id))) throw new NotFoundError("Comment not found");
  throw new ConflictError("This comment was changed meanwhile; reload to see it, then try again");
}

/** A change to a note: resolved or reopened by anyone who can comment, or its text by its author; one at a time. */
export const commentPatchSchema = z.union([z.object({ resolved: z.boolean() }).strict(), z.object({ text: commentSchema.shape.text }).strict()]);

/**
 * Changes the text of the author's own note (`403` for anyone else's). Mentions are read again from the new
 * text; only members the note has never named before are returned in `newMentions`, to be emailed, so fixing
 * a typo, or taking a name out and putting it back, does not mail anyone twice. The same text changes nothing.
 */
export async function editComment(videoId: string, commentId: string, text: string, ownerId: string = LOCAL_OWNER, author: User = { id: ownerId }): Promise<{ comment: VideoComment; newMentions: VideoComment["mentions"] }> {
  await ownedVideo(videoId, ownerId);
  const comment = await getStore().get<VideoComment>("comment", commentId);
  if (!comment || comment.videoId !== videoId || comment.ownerId !== ownerId) throw new NotFoundError("Comment not found");
  if (comment.authorId !== author.id) throw new ForbiddenError("Only the author can edit this comment");
  if (text === comment.text) return { comment, newMentions: [] };
  const { mentions: _before, notified: _notified, ...rest } = comment;
  let mentions: VideoComment["mentions"] = [];
  if (isWorkspaceId(ownerId)) {
    const ws = await getStore().get<Workspace>("workspace", ownerId);
    mentions = ws ? findMentions(text, ws, author.id) : [];
  }
  // Everyone the note ever named was mailed then; naming them again, or again after taking them out, does not mail them twice.
  const known = new Set([...(comment.notified ?? []), ...(comment.mentions ?? []).map((m) => m.userId)]);
  const newMentions = mentions.filter((m) => !known.has(m.userId));
  const notified = [...known, ...newMentions.map((m) => m.userId)];
  const next: VideoComment = { ...rest, text, editedAt: nowIso(), ...(mentions.length ? { mentions } : {}), ...(notified.length ? { notified } : {}) };
  return { comment: await rewrite(comment, next), newMentions };
}

/**
 * Marks a note done, or open again. Anyone who can comment on the video may, as in a shared review: the
 * person who acted on a note is often not the one who wrote it. Resolving a resolved note keeps who did it first.
 */
export async function resolveComment(videoId: string, commentId: string, resolved: boolean, ownerId: string = LOCAL_OWNER, user: User = { id: ownerId }): Promise<VideoComment> {
  await ownedVideo(videoId, ownerId);
  const comment = await getStore().get<VideoComment>("comment", commentId);
  if (!comment || comment.videoId !== videoId || comment.ownerId !== ownerId) throw new NotFoundError("Comment not found");
  if (resolved === !!comment.resolvedAt) return comment;
  const { resolvedAt: _at, resolvedById: _by, resolvedByEmail: _email, ...open } = comment;
  const next: VideoComment = resolved ? { ...open, resolvedAt: nowIso(), resolvedById: user.id, ...(user.email ? { resolvedByEmail: user.email } : {}) } : open;
  return rewrite(comment, next);
}

/** How many open (unresolved) notes each of the owner's videos has, by video id; a video with none is not listed. */
export async function openCommentCounts(ownerId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const c of await getStore().list<VideoComment>("comment", ownerId)) {
    if (!c.resolvedAt) counts.set(c.videoId, (counts.get(c.videoId) ?? 0) + 1);
  }
  return counts;
}

/** Removes every comment on a video; part of deleting the video for good. */
export async function clearComments(videoId: string, ownerId: string): Promise<void> {
  const all = await getStore().list<VideoComment>("comment", ownerId);
  await Promise.all(all.filter((c) => c.videoId === videoId).map((c) => getStore().remove("comment", c.id)));
}
