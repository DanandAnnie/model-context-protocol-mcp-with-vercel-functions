// Sending a finished video's share link by email, from the video page or the API.
import { z } from "zod";
import { shareOffline } from "./client";
import { ConflictError, LimitError } from "./errors";
import { LOCAL_OWNER } from "./owner-id";
import { escapeHtml as escape, getEmailProvider, type EmailMessage } from "./providers/email";
import { reserveRateLimit } from "./rate-limit";
import { owned } from "./services/shared";
import { getStore } from "./store";
import type { Video } from "./types";

export const MAX_SHARE_RECIPIENTS = 10;
/** Recipients per sender per hour, across all videos and workspaces. */
export const SHARE_EMAILS_PER_HOUR = 60;
/** Recipients per hour across the whole instance: the backstop when many accounts send at once. */
export const SHARE_EMAILS_PER_HOUR_GLOBAL = 600;
const HOUR_MS = 60 * 60 * 1000;

export const shareEmailSchema = z.object({
  to: z
    .array(z.string().trim().toLowerCase().email("Each recipient must be an email address").max(200))
    .min(1, "Add at least one recipient")
    .max(MAX_SHARE_RECIPIENTS, `At most ${MAX_SHARE_RECIPIENTS} recipients per send`),
  /** A note from the sender shown above the link (plain text; never rendered as HTML). */
  message: z.string().trim().max(500, "Keep the message under 500 characters").optional(),
});
export type ShareEmailInput = z.infer<typeof shareEmailSchema>;

/** The message a recipient gets: the sender, an optional note, the link, and a hint when a password is needed. */
export function shareEmail(input: { to: string; video: Pick<Video, "title" | "durationSec" | "shareLocked">; url: string; senderEmail?: string; message?: string; siteName?: string }): EmailMessage {
  const site = input.siteName || "Avatar Studio";
  const who = input.senderEmail ? input.senderEmail : "Someone";
  const subject = `${who} shared a video with you: "${input.video.title}"`;
  const length = input.video.durationSec ? ` (${Math.round(input.video.durationSec)}s)` : "";
  const locked = input.video.shareLocked ? "This video is password protected; the sender will give you the password separately." : "";
  const footer = `You received this because ${who} entered your address on ${site}. If you were not expecting it, you can ignore this email.`;
  const text = [`${who} shared "${input.video.title}"${length} with you on ${site}.`, input.message ? `\n${input.message}\n` : "", `Watch it here:\n${input.url}`, locked ? `\n${locked}` : "", `\n${footer}`]
    .filter((p) => p !== "")
    .join("\n");
  const html = [
    `<p><strong>${escape(who)}</strong> shared <strong>${escape(input.video.title)}</strong>${escape(length)} with you on ${escape(site)}.</p>`,
    input.message ? `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #cbd5e1;color:#334155;white-space:pre-wrap">${escape(input.message)}</blockquote>` : "",
    `<p><a href="${escape(input.url)}">Watch the video</a></p>`,
    locked ? `<p style="color:#64748b;font-size:12px">${escape(locked)}</p>` : "",
    `<p style="color:#94a3b8;font-size:12px">${escape(footer)}</p>`,
  ].join("");
  return { to: input.to, subject, text, html, replyTo: input.senderEmail };
}

export type ShareEmailResult = { sent: string[]; failed: { to: string; error: string }[]; delivers: boolean };

/**
 * Emails the share link of a completed video to up to ten people. The link must be live (not
 * switched off or expired), since the recipients would only find "not found". Recipients are
 * de-duplicated. The hourly allowance is charged to the person sending (`senderId`, the signed-in
 * user rather than the active workspace, so switching workspaces does not multiply it) and to the
 * instance as a whole; a batch that does not fit is refused whole and takes nothing.
 */
export async function shareVideoByEmail(
  id: string,
  input: ShareEmailInput,
  ownerId: string = LOCAL_OWNER,
  context: { origin: string; senderId?: string; senderEmail?: string; siteName?: string },
): Promise<ShareEmailResult> {
  const video = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  if (video.status !== "completed") throw new ConflictError("Only a finished video can be shared");
  if (shareOffline(video)) throw new ConflictError("The share link is off or expired; turn it on before sending");
  const to = [...new Set(input.to)];
  const sender = reserveRateLimit(`share-email:sender:${context.senderId ?? ownerId}`, to.length, SHARE_EMAILS_PER_HOUR, HOUR_MS);
  if (!sender.allowed) {
    throw new LimitError(`You can email ${SHARE_EMAILS_PER_HOUR} recipients per hour (${sender.remaining} left); try again in ${Math.max(1, Math.ceil(sender.retryAfterSec / 60))} min`);
  }
  const everyone = reserveRateLimit("share-email:global", to.length, SHARE_EMAILS_PER_HOUR_GLOBAL, HOUR_MS);
  if (!everyone.allowed) throw new LimitError(`Email sharing is busy right now; try again in ${Math.max(1, Math.ceil(everyone.retryAfterSec / 60))} min`);
  const mail = getEmailProvider();
  const url = `${context.origin.replace(/\/$/, "")}/share/${video.id}`;
  const result: ShareEmailResult = { sent: [], failed: [], delivers: mail.delivers };
  for (const recipient of to) {
    try {
      await mail.send(shareEmail({ to: recipient, video, url, senderEmail: context.senderEmail, message: input.message, siteName: context.siteName }));
      result.sent.push(recipient);
    } catch (err) {
      result.failed.push({ to: recipient, error: err instanceof Error ? err.message : "Email could not be sent" });
    }
  }
  return result;
}
