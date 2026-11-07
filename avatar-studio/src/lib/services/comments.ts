// Comments on videos: review notes from the owner or workspace members. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import type { Video, VideoComment, Workspace } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { isWorkspaceId, type User } from "../workspaces";
import { config } from "../config";
import { getEmailProvider, mentionEmail, replyEmail } from "../providers/email";
import { releaseRateLimit, reserveRateLimit } from "../rate-limit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { owned } from "./shared";
import { formatTimestamp } from "../text";
import { COMMENT_REACTIONS, splitComments, threadLink } from "../comment-list";

export const MAX_COMMENTS_PER_VIDEO = 200;

/** Longest point a comment can be pinned to, in seconds (a render is never close to this). */
const MAX_COMMENT_AT_SEC = 4 * 3600;

export const commentSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  /** Seconds from the start; `null` reads as a note on the whole video, as an API client may send for an empty field. */
  atSec: z.preprocess((v) => (v === null ? undefined : v), z.number().finite().min(0).max(MAX_COMMENT_AT_SEC).optional()),
  /** A note on this video that starts a thread: the new note replies to it. */
  parentId: z.string().min(1).max(80).optional(),
});

/** How many people one comment can notify. */
export const MAX_MENTIONS = 10;

/** Comment emails (mentions and replies) one person can set off per hour, and the whole instance; past either, comments still post but nobody is emailed. */
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
  if (input.parentId !== undefined) {
    // One level of replies: a reply answers an open note that starts a thread, on this same video.
    const parent = existing.find((c) => c.id === input.parentId);
    if (!parent) throw new NotFoundError("The comment to reply to was not found");
    if (parent.parentId) throw new ValidationError("Reply to the comment that starts the thread");
    if (parent.resolvedAt) throw new ConflictError("This thread was resolved; reopen it to reply");
    if (input.atSec !== undefined) throw new ValidationError("A reply cannot be pinned to a moment; the comment it answers can be");
  }
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
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
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
  const saved = await getStore().put("comment", comment);
  // A thread deleted or resolved while this reply was being written takes the reply back, before anyone is mailed about it.
  if (input.parentId !== undefined) {
    const parent = await getStore().get<VideoComment>("comment", input.parentId);
    if (!parent || parent.resolvedAt) {
      await getStore().remove("comment", saved.id);
      if (!parent) throw new NotFoundError("The comment to reply to was deleted");
      throw new ConflictError("This thread was resolved; reopen it to reply");
    }
  }
  return saved;
}

/**
 * Takes `n` comment emails from the author's hourly allowance and the instance's, shared by mentions and
 * replies: posting and deleting a comment in a loop would otherwise mail teammates without limit.
 */
function reserveCommentEmails(comment: VideoComment, n: number, what: string): boolean {
  const senderKey = `mention-email:sender:${comment.authorId}`;
  const sender = reserveRateLimit(senderKey, n, MENTION_EMAILS_PER_HOUR, HOUR_MS);
  const everyone = sender.allowed && reserveRateLimit("mention-email:global", n, MENTION_EMAILS_PER_HOUR_GLOBAL, HOUR_MS).allowed;
  if (everyone) return true;
  // Emails the instance refused are not counted against the author.
  if (sender.allowed) releaseRateLimit(senderKey, n);
  console.warn(`${what} emails for comment ${comment.id} skipped: hourly limit reached`);
  return false;
}

/**
 * Emails each member a comment mentions, with the comment and a link that opens the video in its
 * workspace at the comment's thread. Best effort: one failed send is logged and does not stop the others.
 * `mailed`, when given, collects who was emailed, so a reply's thread email can go to a mentioned member
 * whose mention email did not.
 */
export async function notifyMentions(comment: VideoComment, mailed?: Set<string>): Promise<number> {
  if (!comment.mentions?.length) return 0;
  const video = await getStore().get<Video>("video", comment.videoId);
  if (!video) return 0;
  if (!reserveCommentEmails(comment, comment.mentions.length, "mention")) return 0;
  // A mention in a reply links to the thread it is in, at that thread's moment.
  const thread = (comment.parentId && (await getStore().get<VideoComment>("comment", comment.parentId))) || comment;
  const url = threadLink(config.appUrl, thread);
  let sent = 0;
  for (const m of comment.mentions) {
    try {
      await getEmailProvider().send(mentionEmail({ to: m.email, authorEmail: comment.authorEmail, videoTitle: video.title, text: comment.text, url, ...(thread.atSec !== undefined ? { at: formatTimestamp(thread.atSec) } : {}) }));
      mailed?.add(m.userId);
      sent++;
    } catch (err) {
      console.error(`mention email to ${m.email} failed:`, err);
    }
  }
  return sent;
}

/**
 * Emails the people in a thread that it was answered: whoever wrote the note and each earlier reply, at
 * the address they have as a member of the workspace now (someone who has left is not emailed). The one
 * replying, and anyone their reply mentions (who gets the mention email instead), are left out; with
 * `mentionsMailed` (from `notifyMentions`), only the mentioned who were in fact emailed are. All or none of
 * the thread is emailed within the author's hourly allowance. Workspace threads only: a personal space has
 * one person in it. Best effort, as mentions.
 */
export async function notifyReply(reply: VideoComment, mentionsMailed?: Set<string>): Promise<number> {
  if (!reply.parentId || !isWorkspaceId(reply.ownerId)) return 0;
  const [video, note, ws, all] = await Promise.all([
    getStore().get<Video>("video", reply.videoId),
    getStore().get<VideoComment>("comment", reply.parentId),
    getStore().get<Workspace>("workspace", reply.ownerId),
    getStore().list<VideoComment>("comment", reply.ownerId),
  ]);
  if (!video || !note || !ws) return 0;
  const skip = new Set([reply.authorId, ...(mentionsMailed ?? (reply.mentions ?? []).map((m) => m.userId))]);
  const earlier = all.filter((c) => c.parentId === note.id && c.id !== reply.id && c.createdAt <= reply.createdAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const to: string[] = [];
  for (const c of [note, ...earlier]) {
    if (skip.has(c.authorId)) continue;
    skip.add(c.authorId);
    const email = ws.members.find((m) => m.userId === c.authorId)?.email;
    if (email) to.push(email);
  }
  if (!to.length || !reserveCommentEmails(reply, to.length, "reply")) return 0;
  const url = threadLink(config.appUrl, note);
  let sent = 0;
  for (const address of to) {
    try {
      await getEmailProvider().send(replyEmail({ to: address, authorEmail: reply.authorEmail, videoTitle: video.title, text: reply.text, noteText: note.text, url, ...(note.atSec !== undefined ? { at: formatTimestamp(note.atSec) } : {}) }));
      sent++;
    } catch (err) {
      console.error(`reply email to ${address} failed:`, err);
    }
  }
  return sent;
}

/**
 * The author may delete their own comment; anyone else with access gets 403. A note that starts a thread takes its
 * replies with it, whoever wrote them: they answer a note no longer there. `expectedReplies`, when given, is how many
 * replies the caller saw and agreed to delete: a thread answered since is refused (409) rather than deleted unseen.
 * The replies go first and the note last, so a failure part-way leaves a thread that can be deleted again.
 * Returns how many replies went.
 */
export async function deleteComment(videoId: string, commentId: string, ownerId: string = LOCAL_OWNER, author: User = { id: ownerId }, expectedReplies?: number): Promise<{ replies: number }> {
  await ownedVideo(videoId, ownerId);
  const comment = await getStore().get<VideoComment>("comment", commentId);
  if (!comment || comment.videoId !== videoId || comment.ownerId !== ownerId) throw new NotFoundError("Comment not found");
  if (comment.authorId !== author.id) throw new ForbiddenError("Only the author can delete this comment");
  const replies = comment.parentId ? [] : (await getStore().list<VideoComment>("comment", ownerId)).filter((c) => c.parentId === commentId);
  if (expectedReplies !== undefined && replies.length > expectedReplies) {
    const more = replies.length - expectedReplies;
    throw new ConflictError(`This comment has ${more === 1 ? "a new reply" : `${more} new replies`} since you looked; reload to see ${more === 1 ? "it" : "them"} before deleting`);
  }
  await Promise.all(replies.map((r) => getStore().remove("comment", r.id)));
  await getStore().remove("comment", commentId);
  if (comment.parentId) return { replies: 0 };
  // A reply written while the note was being deleted (after the list above, before the note went) goes too.
  const late = (await getStore().list<VideoComment>("comment", ownerId)).filter((c) => c.parentId === commentId);
  await Promise.all(late.map((r) => getStore().remove("comment", r.id)));
  return { replies: replies.length + late.length };
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

/**
 * A change to a note, one at a time: resolved or reopened by anyone who can comment, its text by its author, or a
 * reaction given (`on: true`) or taken back by the person sending it.
 */
export const commentPatchSchema = z.union([
  z.object({ resolved: z.boolean() }).strict(),
  z.object({ text: commentSchema.shape.text }).strict(),
  // A bare heart (U+2764, as many keyboards send it) is the listed one, which carries the emoji form (U+FE0F).
  z.object({ reaction: z.preprocess((v) => (v === "\u2764" ? "\u2764\uFE0F" : v), z.enum(COMMENT_REACTIONS)), on: z.boolean() }).strict(),
]);

/** How many times a reaction, or a resolve among many, is tried on a note someone else changed in the same moment. */
const RACE_TRIES = 5;

/**
 * Gives a reaction to a note or reply, or takes it back, for the person `user`; anyone who can comment may react to
 * any note, open or resolved. Giving one already given, or taking back one not given, changes nothing. Reactions
 * from two people at once both count: a write that lost the race to another change is made again on the note as it
 * now is, so only a note deleted meanwhile (`404`) or one changing on every try (`409`) refuses it.
 */
export async function reactToComment(
  videoId: string,
  commentId: string,
  reaction: (typeof COMMENT_REACTIONS)[number],
  on: boolean,
  ownerId: string = LOCAL_OWNER,
  user: User = { id: ownerId },
): Promise<VideoComment> {
  await ownedVideo(videoId, ownerId);
  for (let attempt = 1; ; attempt++) {
    const comment = await getStore().get<VideoComment>("comment", commentId);
    if (!comment || comment.videoId !== videoId || comment.ownerId !== ownerId) throw new NotFoundError("Comment not found");
    // A note from before revisions is matched by when it was written, which two writes at once would both pass:
    // it is given a revision first, so the reactions written after it are matched by that and none is lost.
    if (!comment.rev) {
      await rewrite(comment, comment).catch((err) => {
        if (!(err instanceof ConflictError)) throw err;
      });
      continue;
    }
    const who = comment.reactions?.[reaction] ?? [];
    if (who.some((r) => r.userId === user.id) === on) return comment;
    const nextWho = on ? [...who, { userId: user.id, ...(user.email ? { email: user.email } : {}) }] : who.filter((r) => r.userId !== user.id);
    const { reactions: _before, ...rest } = comment;
    const reactions = { ...comment.reactions, [reaction]: nextWho };
    if (!nextWho.length) delete reactions[reaction];
    try {
      return await rewrite(comment, Object.keys(reactions).length ? { ...rest, reactions } : rest);
    } catch (err) {
      if (!(err instanceof ConflictError) || attempt >= RACE_TRIES) throw err;
    }
  }
}

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
  // A thread is resolved as a whole, from the note that starts it (a reply whose note is gone stands on its own).
  if (comment.parentId && (await getStore().get<VideoComment>("comment", comment.parentId))) {
    throw new ValidationError("Resolve the comment that starts the thread; its replies go with it");
  }
  if (resolved === !!comment.resolvedAt) return comment;
  const { resolvedAt: _at, resolvedById: _by, resolvedByEmail: _email, ...open } = comment;
  const next: VideoComment = resolved ? { ...open, resolvedAt: nowIso(), resolvedById: user.id, ...(user.email ? { resolvedByEmail: user.email } : {}) } : open;
  return rewrite(comment, next);
}

export const resolveAllSchema = z.object({
  /** The threads the caller was shown as open (their first notes' ids), so one started since is left open. */
  ids: z.array(z.string().min(1).max(80)).min(1).max(MAX_COMMENTS_PER_VIDEO),
});

/** How many threads Resolve all writes at a time. */
const RESOLVE_ALL_AT_ONCE = 8;

/**
 * Marks the open threads `ids` on the video done at once, for the person `user`, as resolving each would: a thread's
 * replies go with its note, and a reply whose note is gone counts as a thread of its own. Only threads the caller
 * named are resolved, so one started after they looked stays open; an id that is not an open thread start (resolved
 * already, deleted, or a reply in a thread) is left alone. A thread changed in the same moment (a reaction, say) is
 * read again and resolved. Returns how many of them are resolved now (one someone else resolved in the same moment
 * included), how many could not be (`failed`), and how many threads are open on the video afterwards.
 */
export async function resolveAllComments(
  videoId: string,
  ids: string[],
  ownerId: string = LOCAL_OWNER,
  user: User = { id: ownerId },
): Promise<{ resolved: number; failed: number; open: number }> {
  const comments = await listComments(videoId, ownerId);
  const all = new Set(comments.map((c) => c.id));
  const wanted = new Set(ids);
  const targets = comments.filter((c) => wanted.has(c.id) && !c.resolvedAt && (!c.parentId || !all.has(c.parentId)));
  let resolved = 0;
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const thread = targets[next++];
      for (let attempt = 1; ; attempt++) {
        try {
          await resolveComment(videoId, thread.id, true, ownerId, user);
          resolved++;
          break;
        } catch (err) {
          if (err instanceof NotFoundError) break;
          if (err instanceof ConflictError && attempt < RACE_TRIES) continue;
          // One thread that cannot be resolved does not stop the others; the caller is told how many.
          console.error(`resolve all: comment ${thread.id} on ${videoId} failed:`, err);
          failed++;
          break;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(RESOLVE_ALL_AT_ONCE, targets.length) }, worker));
  // Read again, so a thread started meanwhile is counted, and a video deleted meanwhile is a 404 rather than a count.
  const { open } = splitComments(await listComments(videoId, ownerId));
  return { resolved, failed, open: open.length };
}

/** How many open (unresolved) threads each of the owner's videos has, by video id; a video with none is not listed. */
export async function openCommentCounts(ownerId: string): Promise<Map<string, number>> {
  return (await commentCounts(ownerId)).open;
}

/**
 * Open threads by video id, and of those, the ones that name `userId` (`@email` in the note or any reply) as `mentions`:
 * what is still waiting on that person. A thread counts once, by the note that starts it; its replies are part of it,
 * and one whose note is gone counts alone. `latest` is when someone other than `userId` last wrote in an open thread
 * (a note or a reply), by video id, for the library to say what is new since the reader last looked; `latestAny` the
 * same in any thread, resolved ones too, which is the mark the video page keeps once it has shown them. Without
 * `userId`, `mentions`, `latest`, and `latestAny` are empty. `lastAt` is when anyone, the reader too, last wrote a note
 * or a reply on each video, in any thread: the library's Recent comments order. One read of the store for all of them.
 */
export async function commentCounts(
  ownerId: string,
  userId?: string,
): Promise<{ open: Map<string, number>; mentions: Map<string, number>; latest: Map<string, string>; latestAny: Map<string, string>; lastAt: Map<string, string> }> {
  const open = new Map<string, number>();
  const mentions = new Map<string, number>();
  const latest = new Map<string, string>();
  const latestAny = new Map<string, string>();
  const lastAt = new Map<string, string>();
  // The newest wins; the first readable one stands in until then.
  const newer = (map: Map<string, string>, c: VideoComment, at: number) => {
    if (!(Date.parse(map.get(c.videoId) ?? "") >= at)) map.set(c.videoId, c.createdAt);
  };
  const all = await getStore().list<VideoComment>("comment", ownerId);
  const byId = new Map(all.map((c) => [c.id, c]));
  const startOf = (c: VideoComment) => (c.parentId && byId.get(c.parentId)) || c;
  const named = new Set<string>();
  for (const c of all) {
    const start = startOf(c);
    const at = Date.parse(c.createdAt);
    const others = !!userId && c.authorId !== userId && !Number.isNaN(at);
    if (!Number.isNaN(at)) newer(lastAt, c, at);
    if (others) newer(latestAny, c, at);
    if (start.resolvedAt) continue;
    if (start === c) open.set(c.videoId, (open.get(c.videoId) ?? 0) + 1);
    if (userId && !named.has(start.id) && c.mentions?.some((m) => m.userId === userId)) named.add(start.id);
    if (others) newer(latest, c, at);
  }
  for (const id of named) {
    const videoId = byId.get(id)!.videoId;
    mentions.set(videoId, (mentions.get(videoId) ?? 0) + 1);
  }
  return { open, mentions, latest, latestAny, lastAt };
}

/** Removes every comment on a video; part of deleting the video for good. */
export async function clearComments(videoId: string, ownerId: string): Promise<void> {
  const all = await getStore().list<VideoComment>("comment", ownerId);
  await Promise.all(all.filter((c) => c.videoId === videoId).map((c) => getStore().remove("comment", c.id)));
}
