// Browser-safe wording for workspace invites: reading several pasted addresses and summing up a batch.

export type InviteSkipReason = "member" | "pending" | "repeated";

export interface BulkInviteAnswer {
  invites: Array<{ invite: { email?: string }; emailed: boolean; emailError?: string }>;
  skipped: Array<{ email: string; reason: InviteSkipReason }>;
}

/**
 * The addresses in what was typed or pasted: separated by commas, semicolons, spaces, or new lines.
 * A list copied from a mail app ("Ana Diaz <ana@x.com>, \"Lee, Ben\" <ben@x.com>") gives the
 * addresses inside the angle brackets; the names around them are dropped.
 */
export function splitEmails(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.replace(/"[^"]*"/g, " ").split(/[,;\n]+/)) {
    const angled = [...piece.matchAll(/<([^<>]*)>/g)].map((m) => m[1].trim()).filter(Boolean);
    if (angled.length) out.push(...angled);
    else out.push(...piece.split(/\s+/).filter(Boolean));
  }
  return out;
}

const SKIP_WORDS: Record<InviteSkipReason, string> = {
  member: "already a member",
  pending: "already invited; resend it from Pending invites",
  repeated: "listed twice",
};

const list = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`);

/** One line saying what a batch of invites did: who was emailed, whose link to share by hand, and who was skipped and why. */
export function bulkInviteSummary(answer: BulkInviteAnswer): string {
  const parts: string[] = [];
  const emailed = answer.invites.filter((i) => i.emailed).map((i) => i.invite.email ?? "");
  // Each failed address keeps its own reason: providers fail one message for one reason and the next for another.
  const failed = answer.invites.filter((i) => !i.emailed && i.emailError).map((i) => `${i.invite.email ?? ""} (${i.emailError})`);
  const unsent = answer.invites.filter((i) => !i.emailed && !i.emailError).map((i) => i.invite.email ?? "");
  const n = answer.invites.length;
  parts.push(n ? `Invited ${n} ${n === 1 ? "person" : "people"}.` : "No new invites.");
  if (emailed.length) parts.push(`Emailed ${list(emailed)}.`);
  if (failed.length) parts.push(`The email to ${list(failed)} failed; copy ${failed.length === 1 ? "that link" : "those links"} from Pending invites.`);
  if (unsent.length) parts.push(`Email sending is not configured; copy the ${unsent.length === 1 ? "link" : "links"} for ${list(unsent)} from Pending invites.`);
  if (answer.skipped.length) parts.push(`Skipped ${answer.skipped.map((s) => `${s.email} (${SKIP_WORDS[s.reason]})`).join(", ")}.`);
  return parts.join(" ");
}
