// Browser-safe wording for workspace invites: reading several pasted addresses and summing up a batch.

export type InviteSkipReason = "member" | "pending" | "repeated";

/** How long an expired invite stays on the owner's list, to be sent again or dismissed. */
export const EXPIRED_INVITE_DAYS = 30;

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

export interface Seats {
  members: number;
  pending: number;
  max: number;
}

/** Seats still free: the limit less members and pending invites (each pending invite holds one). */
export function seatsLeft(seats: Seats): number {
  return Math.max(0, seats.max - seats.members - seats.pending);
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 of 50 seats used: 10 members and 2 pending invites." */
export function seatLine(seats: Seats): string {
  const used = seats.members + seats.pending;
  const parts = [count(seats.members, "member", "members")];
  if (seats.pending) parts.push(count(seats.pending, "pending invite", "pending invites"));
  return `${used} of ${seats.max} seats used: ${parts.join(" and ")}.`;
}

/** A workspace with this many members and invites (pending or expired) gets a Find box above its member list. */
export const PEOPLE_SEARCH_FROM = 6;

/**
 * Whether a member or invite matches what was typed into Find: the text it is listed by (an address, a member's id
 * when there is no address, or "Link invite"), ignoring case and spaces around the query. An empty query matches all.
 */
export function personMatches(query: string, listedAs: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || listedAs.toLowerCase().includes(q);
}

/** How many of each list a Find shows, for the status line: [shown, of]. A list with none at all is left out. */
export interface PeopleMatches {
  members: [number, number];
  pending: [number, number];
  expired: [number, number];
}

/**
 * "2 of 12 members and 1 of 3 pending invites match “ann”.", or "No member or invite matches “zed”."; a reader who
 * is not an owner sees no invites, so `invites: false` says "No member matches" instead.
 */
export function peopleMatchLine(m: PeopleMatches, query: string, { invites = true }: { invites?: boolean } = {}): string {
  const q = `“${query.trim()}”`;
  if (m.members[0] + m.pending[0] + m.expired[0] === 0) return `No ${invites ? "member or invite" : "member"} matches ${q}.`;
  const parts: string[] = [];
  const add = ([shown, of]: [number, number], one: string, many: string) => {
    if (of > 0) parts.push(`${shown} of ${count(of, one, many)}`);
  };
  add(m.members, "member", "members");
  add(m.pending, "pending invite", "pending invites");
  add(m.expired, "expired invite", "expired invites");
  const listed = list(parts);
  // "1 of 12 members matches", but "0 of 1 member and 1 of 3 pending invites match": the verb follows what is listed.
  const one = parts.length === 1 && m.members[0] + m.pending[0] + m.expired[0] === 1;
  return `${listed} ${one ? "matches" : "match"} ${q}.`;
}

/** The columns of the Workspace page's people download. */
export const PEOPLE_CSV_COLUMNS = ["email", "user_id", "role", "status", "joined", "expires", "last_active"];

/** What a people download is made from: the workspace as its reader sees it (invites only for owners). */
export interface PeopleSheet {
  members: Array<{ userId: string; email?: string; role: string; joinedAt: string }>;
  invites: Array<{ email?: string; role: string; expiresAt: string }>;
  expiredInvites?: Array<{ email?: string; role: string; expiresAt: string }>;
}

/**
 * The people of a workspace as spreadsheet rows: members first (with when they joined and, from the kept
 * activity, when they last did something there), then pending invites, then expired ones. A link invite has no
 * address, so its email cell reads "Link invite". Pending invites come soonest to expire first and expired ones most
 * recently lapsed first. Invite tokens are never included: the file is for records.
 */
export function peopleRows(sheet: PeopleSheet, lastActive: Record<string, string> = {}): Array<Record<string, string>> {
  return [
    ...sheet.members.map((m) => ({ email: m.email ?? "", user_id: m.userId, role: m.role, status: "member", joined: m.joinedAt, expires: "", last_active: lastActive[m.userId] ?? "" })),
    // Invites soonest to expire first, whatever order the store lists them in.
    ...[...sheet.invites].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)).map((i) => ({ email: i.email ?? "Link invite", user_id: "", role: i.role, status: "pending invite", joined: "", expires: i.expiresAt, last_active: "" })),
    ...[...(sheet.expiredInvites ?? [])].sort((a, b) => b.expiresAt.localeCompare(a.expiresAt)).map((i) => ({ email: i.email ?? "Link invite", user_id: "", role: i.role, status: "expired invite", joined: "", expires: i.expiresAt, last_active: "" })),
  ];
}

/** How the Workspace page orders its members: by role (owners first, the default), name A–Z, last active, or newest joined. */
export const MEMBER_SORTS = ["role", "name", "active", "joined"] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];
export const MEMBER_SORT_KEY = "avatar-studio:member-sort";

/** A stored sort read back: one of the four, or the default for anything else (nothing stored, an old or edited value). */
export function memberSortFrom(stored: string | null | undefined): MemberSort {
  return (MEMBER_SORTS as readonly string[]).includes(stored ?? "") ? (stored as MemberSort) : "role";
}

const ROLE_RANK: Record<string, number> = { owner: 0, editor: 1, viewer: 2 };

/**
 * The members in the order asked for, a new array. Each order falls back to the name (the address, or the id when
 * there is none, ignoring case), then to who joined first, so the list never shuffles between loads. "active" puts
 * the most recently active first, from `lastActive` (member id → ISO time); members with nothing kept come last.
 */
export function sortMembers<T extends { userId: string; email?: string; role: string; joinedAt: string }>(members: T[], sort: MemberSort, lastActive: Record<string, string> = {}): T[] {
  const name = (m: T) => m.email ?? m.userId;
  // Plain comparisons of the ISO times; names compare as people read them ("u2" before "u10").
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const byName = (a: T, b: T) => name(a).localeCompare(name(b), undefined, { sensitivity: "base", numeric: true }) || cmp(a.joinedAt, b.joinedAt);
  const order: Record<MemberSort, (a: T, b: T) => number> = {
    role: (a, b) => (ROLE_RANK[a.role] ?? 3) - (ROLE_RANK[b.role] ?? 3) || byName(a, b),
    name: byName,
    active: (a, b) => cmp(lastActive[b.userId] ?? "", lastActive[a.userId] ?? "") || byName(a, b),
    joined: (a, b) => cmp(b.joinedAt, a.joinedAt) || byName(a, b),
  };
  return [...members].sort(order[sort]);
}

/**
 * The sort the page can show now: a remembered "active" waits for the last-active times (owners first until they
 * arrive, or for good if they could not be read), so the list never claims an order it cannot give. The remembered
 * choice is kept.
 */
export function shownMemberSort(sort: MemberSort, lastActiveReady: boolean): MemberSort {
  return sort === "active" && !lastActiveReady ? "role" : sort;
}

/** The order the member list was last drawn in: the sort it was drawn under and the members' ids in that order. */
export interface MemberOrder {
  sort: MemberSort;
  ids: string[];
}

/**
 * The members in a steady order: sorted afresh when the sort changes or someone joins or leaves, else in the order
 * they were last drawn in, so the row an owner just changed (a role, say) stays where it is rather than jumping to
 * its new place (and taking the focus with it). Returns the members and the order to keep for next time.
 */
export function steadyMembers<T extends { userId: string; email?: string; role: string; joinedAt: string }>(
  previous: MemberOrder | null,
  members: T[],
  sort: MemberSort,
  lastActive: Record<string, string> = {},
): { members: T[]; order: MemberOrder } {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const same = previous && previous.sort === sort && previous.ids.length === members.length && previous.ids.every((id) => byId.has(id));
  const ordered = same ? previous!.ids.map((id) => byId.get(id)!) : sortMembers(members, sort, lastActive);
  return { members: ordered, order: same ? previous! : { sort, ids: ordered.map((m) => m.userId) } };
}
