// Transactional email for workspace invites. Resend when configured; otherwise a mock that records sends.
import { config } from "../config";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
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
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
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

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function inviteEmail(input: { to: string; workspaceName: string; inviterEmail?: string; role: string; url: string; expiresAt: string }): EmailMessage {
  const who = input.inviterEmail ? `${input.inviterEmail} invited you` : "You have been invited";
  const expires = new Date(input.expiresAt).toUTCString();
  const subject = `Join "${input.workspaceName}" on Avatar Studio`;
  const text = `${who} to join the "${input.workspaceName}" workspace on Avatar Studio as ${input.role === "owner" ? "an owner" : "an editor"}.\n\nOpen this link to join:\n${input.url}\n\nThe link expires ${expires}. If you were not expecting this, ignore this email.`;
  const html = `<p>${escape(who)} to join the <strong>${escape(input.workspaceName)}</strong> workspace on Avatar Studio as ${input.role === "owner" ? "an owner" : "an editor"}.</p><p><a href="${escape(input.url)}">Join the workspace</a></p><p style="color:#64748b;font-size:12px">The link expires ${escape(expires)}. If you were not expecting this, ignore this email.</p>`;
  return { to: input.to, subject, text, html };
}
