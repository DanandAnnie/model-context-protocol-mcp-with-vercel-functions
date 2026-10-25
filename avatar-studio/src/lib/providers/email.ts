// Transactional email for workspace invites. Resend when configured; otherwise a mock that records sends.
import { config } from "../config";
import { roleArticle } from "../roles";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Where a reply should go when the message is sent on someone's behalf. */
  replyTo?: string;
}

export interface EmailProvider {
  name: string;
  /** True when the provider can actually deliver mail (the mock cannot). */
  delivers: boolean;
  send(message: EmailMessage): Promise<void>;
}

/** Keeps every "sent" message in memory so tests and local runs can inspect them. */
export class MockEmailProvider implements EmailProvider {
  name = "mock";
  delivers = false;
  sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    if (this.sent.length > 100) this.sent.shift();
    console.info(`[email:mock] to=${message.to} subject=${JSON.stringify(message.subject)}`);
  }
}

export class ResendEmailProvider implements EmailProvider {
  name = "resend";
  delivers = true;
  constructor(private apiKey: string, private from: string) {}
  async send(message: EmailMessage) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, html: message.html, ...(message.replyTo ? { reply_to: message.replyTo } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __avatarStudioEmail: EmailProvider | undefined;
}

export function getEmailProvider(): EmailProvider {
  if (globalThis.__avatarStudioEmail) return globalThis.__avatarStudioEmail;
  const provider: EmailProvider =
    config.emailProvider === "resend" && config.resendApiKey ? new ResendEmailProvider(config.resendApiKey, config.emailFrom) : new MockEmailProvider();
  globalThis.__avatarStudioEmail = provider;
  return provider;
}

/** Test hook. */
export function setEmailProvider(p: EmailProvider | undefined) {
  globalThis.__avatarStudioEmail = p;
}

/** HTML-escapes text for the html part of a message. */
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const escape = escapeHtml;

/** Tells a workspace member they were mentioned in a comment, with the comment and a link to the video. */
export function mentionEmail(input: { to: string; authorEmail?: string; videoTitle: string; text: string; url: string }): EmailMessage {
  const who = input.authorEmail ?? "A teammate";
  const subject = `${who} mentioned you on "${input.videoTitle}"`;
  const quote = input.text.length > 600 ? `${input.text.slice(0, 600)}…` : input.text;
  const text = `${who} mentioned you in a comment on "${input.videoTitle}":\n\n${quote}\n\nOpen the video:\n${input.url}`;
  const html = `<p>${escape(who)} mentioned you in a comment on <strong>${escape(input.videoTitle)}</strong>:</p><blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #cbd5e1;color:#334155;white-space:pre-wrap">${escape(quote)}</blockquote><p><a href="${escape(input.url)}">Open the video</a></p>`;
  return { to: input.to, subject, text, html, ...(input.authorEmail ? { replyTo: input.authorEmail } : {}) };
}

export function inviteEmail(input: { to: string; workspaceName: string; inviterEmail?: string; role: string; url: string; expiresAt: string }): EmailMessage {
  const who = input.inviterEmail ? `${input.inviterEmail} invited you` : "You have been invited";
  const expires = new Date(input.expiresAt).toUTCString();
  const subject = `Join "${input.workspaceName}" on Avatar Studio`;
  const text = `${who} to join the "${input.workspaceName}" workspace on Avatar Studio as ${roleArticle(input.role)}.\n\nOpen this link to join:\n${input.url}\n\nThe link expires ${expires}. If you were not expecting this, ignore this email.`;
  const html = `<p>${escape(who)} to join the <strong>${escape(input.workspaceName)}</strong> workspace on Avatar Studio as ${roleArticle(input.role)}.</p><p><a href="${escape(input.url)}">Join the workspace</a></p><p style="color:#64748b;font-size:12px">The link expires ${escape(expires)}. If you were not expecting this, ignore this email.</p>`;
  return { to: input.to, subject, text, html };
}
