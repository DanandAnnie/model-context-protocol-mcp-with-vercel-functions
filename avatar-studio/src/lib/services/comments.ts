// Comments on videos: review notes from the owner or workspace members. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import type { Video, VideoComment } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import type { User } from "../workspaces";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { owned } from "./shared";

export const MAX_COMMENTS_PER_VIDEO = 200;

export const commentSchema = z.object({ text: z.string().trim().min(1).max(1000) });

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
  return getStore().put("comment", comment);
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
