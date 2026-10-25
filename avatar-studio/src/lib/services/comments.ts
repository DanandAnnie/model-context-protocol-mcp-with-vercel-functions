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
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { owned } from "./shared";

export const MAX_COMMENTS_PER_VIDEO = 200;

export const commentSchema = z.object({ text: z.string().trim().min(1).max(1000) });

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
  await ownedVideo(videoId, ownerId);
  const existing = await listComments(videoId, ownerId);
  if (existing.length >= MAX_COMMENTS_PER_VIDEO) throw new ValidationError(`At most ${MAX_COMMENTS_PER_VIDEO} comments per video`);
  const comment: VideoComment = {
    id: newId("cmt"),
    ownerId,
    videoId,
    authorId: author.id,
    ...(author.email ? { authorEmail: author.email } : {}),
    text: input.text,
    createdAt: nowIso(),
  };
  if (isWorkspaceId(ownerId)) {
    const ws = await getStore().get<Workspace>("workspace", ownerId);
    const mentions = ws ? findMentions(input.text, ws, author.id) : [];
    if (mentions.length) comment.mentions = mentions;
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
  const url = `${config.appUrl.replace(/\/$/, "")}/videos/${encodeURIComponent(video.id)}?ws=${encodeURIComponent(comment.ownerId)}`;
  let sent = 0;
  for (const m of comment.mentions) {
    try {
      await getEmailProvider().send(mentionEmail({ to: m.email, authorEmail: comment.authorEmail, videoTitle: video.title, text: comment.text, url }));
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

/** Removes every comment on a video; part of deleting the video for good. */
export async function clearComments(videoId: string, ownerId: string): Promise<void> {
  const all = await getStore().list<VideoComment>("comment", ownerId);
  await Promise.all(all.filter((c) => c.videoId === videoId).map((c) => getStore().remove("comment", c.id)));
}
