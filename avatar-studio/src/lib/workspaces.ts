// Team workspaces: a shared owner id with members. Membership is joined through invite links.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { revokeApiKeysFor } from "./api-keys";
import { deleteNotifySettings } from "./notifications";
import { LimitError, NotFoundError, ValidationError } from "./errors";
import { assertNoRenewingPlan } from "./billing";
import { newId, nowIso } from "./ids";
import { getStore } from "./store";
import { EXPIRED_INVITE_DAYS, type InviteSkipReason } from "./invite-text";
import type { Membership, Workspace, WorkspaceInvite, WorkspaceRole } from "./types";
import { roleCanEdit, roleSchema } from "./roles";

export const WORKSPACE_COOKIE = "studio_workspace";
export const MAX_WORKSPACES_PER_USER = 20;
export const MAX_MEMBERS = 50;
const INVITE_TTL_MS = 7 * 86_400_000;
/** How long a resent invite waits before it can be resent again, so the route cannot be used to flood an inbox. */
export const RESEND_COOLDOWN_MS = 5 * 60_000;

export const workspaceNameSchema = z.object({ name: z.string().trim().min(1).max(60) });
export const inviteSchema = z.object({ email: z.string().trim().email().max(200).optional(), role: roleSchema.default("editor") });
/** The most addresses one request can invite, each getting its own link. */
export const MAX_BULK_INVITES = 20;
export const bulkInviteSchema = z.object({
  emails: z
    .array(z.string().trim().max(200))
    .min(1, "Give at least one email address")
    .max(MAX_BULK_INVITES, `At most ${MAX_BULK_INVITES} addresses at a time`)
    // Names the address that is wrong, so a long pasted list can be fixed without guessing.
    .superRefine((emails, ctx) => {
      const bad = emails.find((e) => !z.string().email().safeParse(e).success);
      if (bad !== undefined) ctx.addIssue({ code: "custom", message: `"${bad.slice(0, 80)}" is not an email address` });
    }),
  role: roleSchema.default("editor"),
});

export interface User {
  id: string;
  email?: string;
}

export const isWorkspaceId = (id: string) => id.startsWith("ws_");

export function memberOf(ws: Workspace, userId: string) {
  return ws.members.find((m) => m.userId === userId) ?? null;
}

/** Creating, changing, and deleting content inside a workspace is for its owners and editors; viewers watch and comment. */
export function canEdit(ws: Workspace | null, userId: string): boolean {
  return !ws || roleCanEdit(memberOf(ws, userId)?.role);
}

/** Account-level actions (wiping all data, billing) inside a workspace are for its owners only. */
export function canManageAccount(ws: Workspace | null, userId: string): boolean {
  return !ws || memberOf(ws, userId)?.role === "owner";
}

const membershipId = (workspaceId: string, userId: string) => `mem_${workspaceId}_${userId}`;

async function putMembership(ws: Workspace, userId: string, role: WorkspaceRole, joinedAt: string) {
  const m: Membership = { id: membershipId(ws.id, userId), ownerId: userId, workspaceId: ws.id, role, joinedAt };
  await getStore().put("membership", m);
}

/** Every workspace the user belongs to, newest first. One indexed list plus one get per workspace. */
export async function listWorkspaces(userId: string): Promise<Workspace[]> {
  const memberships = await getStore().list<Membership>("membership", userId);
  const found = await Promise.all(memberships.map((m) => getStore().get<Workspace>("workspace", m.workspaceId)));
  // A membership whose workspace is gone, or that the authoritative list no longer confirms, is ignored.
  return found
    .filter((w): w is Workspace => !!w && !!memberOf(w, userId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function listInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
  const now = Date.now();
  return (await getStore().list<WorkspaceInvite>("invite", workspaceId)).filter((i) => Date.parse(i.expiresAt) > now);
}

export { EXPIRED_INVITE_DAYS };

/** Whether an invite lapsed within the last EXPIRED_INVITE_DAYS: shown to owners, and the only kind that can be invited again. */
function recentlyExpired(invite: WorkspaceInvite, now = Date.now()): boolean {
  const at = Date.parse(invite.expiresAt);
  return at <= now && at > now - EXPIRED_INVITE_DAYS * 86_400_000;
}

/** A workspace's live invites and those that lapsed recently (the latest first), from one read of the store. */
async function listAllInvites(workspaceId: string): Promise<{ pending: WorkspaceInvite[]; expired: WorkspaceInvite[] }> {
  const now = Date.now();
  const all = await getStore().list<WorkspaceInvite>("invite", workspaceId);
  return {
    pending: all.filter((i) => Date.parse(i.expiresAt) > now),
    expired: all.filter((i) => recentlyExpired(i, now)).sort((a, b) => b.expiresAt.localeCompare(a.expiresAt)),
  };
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const ws = await getStore().get<Workspace>("workspace", id);
  if (!ws) throw new NotFoundError("Workspace not found");
  return ws;
}

/** The workspace if the user is a member, else null. Used to resolve the active owner from the cookie. */
export async function workspaceForMember(id: string, userId: string): Promise<Workspace | null> {
  const ws = await getStore().get<Workspace>("workspace", id);
  return ws && memberOf(ws, userId) ? ws : null;
}

async function requireRole(id: string, user: User, roles: WorkspaceRole[]): Promise<Workspace> {
  const ws = await getWorkspace(id);
  const m = memberOf(ws, user.id);
  if (!m) throw new NotFoundError("Workspace not found");
  if (!roles.includes(m.role)) throw new ValidationError("Only workspace owners can do that");
  return ws;
}

export async function createWorkspace(name: string, user: User): Promise<Workspace> {
  if ((await listWorkspaces(user.id)).length >= MAX_WORKSPACES_PER_USER) throw new ValidationError(`At most ${MAX_WORKSPACES_PER_USER} workspaces per account`);
  const now = nowIso();
  const ws: Workspace = {
    id: newId("ws"),
    name,
    createdBy: user.id,
    members: [{ userId: user.id, email: user.email, role: "owner", joinedAt: now }],
    createdAt: now,
    updatedAt: now,
  };
  await getStore().put("workspace", ws);
  await putMembership(ws, user.id, "owner", now);
  return ws;
}

export async function renameWorkspace(id: string, name: string, user: User): Promise<Workspace> {
  const ws = await requireRole(id, user, ["owner"]);
  return getStore().put("workspace", { ...ws, name, updatedAt: nowIso() });
}

/**
 * Deletes the workspace record, every API key minted under it, and its outbound webhook, so nothing
 * can act as the workspace afterwards. The keys go first, so no script keeps writing while the rest
 * is removed. `purge` then removes what the workspace owns (videos, viewer emails, conversations,
 * voices, and the rest) before the workspace record, so a failure part-way leaves the workspace in
 * place for the owner to try again rather than orphaning its data.
 */
export async function deleteWorkspace(id: string, user: User, purge?: (ownerId: string) => Promise<unknown>): Promise<void> {
  const ws = await requireRole(id, user, ["owner"]);
  // The purge deletes by owner id; never let it run on anything but this workspace's own id.
  if (!isWorkspaceId(id) || ws.id !== id) throw new NotFoundError("Workspace not found");
  // Checked before anything is touched, so a refusal leaves the keys working.
  if (purge) await assertNoRenewingPlan(id);
  await revokeApiKeysFor(id);
  if (purge) await purge(id);
  await deleteNotifySettings(id);
  for (const m of ws.members) await getStore().remove("membership", membershipId(id, m.userId));
  for (const i of await getStore().list<WorkspaceInvite>("invite", id)) await getStore().remove("invite", i.id);
  await getStore().remove("workspace", id);
}

function putInvite(id: string, email: string | undefined, role: WorkspaceRole): Promise<WorkspaceInvite> {
  const token = randomBytes(18).toString("base64url");
  const invite: WorkspaceInvite = { id: token, token, ownerId: id, email, role, createdAt: nowIso(), expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() };
  return getStore().put("invite", invite);
}

export async function createInvite(id: string, input: z.infer<typeof inviteSchema>, user: User, reserve: (count: number) => boolean = () => true): Promise<WorkspaceInvite> {
  const ws = await requireRole(id, user, ["owner"]);
  const pending = await listInvites(id);
  if (ws.members.length + pending.length >= MAX_MEMBERS) throw new ValidationError(`At most ${MAX_MEMBERS} members per workspace`);
  if (!reserve(1)) throw new LimitError("Too many invites from this workspace in the last hour; try again later");
  return putInvite(id, input.email, input.role);
}

/**
 * Invites several addresses at once, one link each, all with the same role. Addresses that are
 * already members, already have a pending invite, or repeat an earlier one in the list are skipped
 * and reported rather than refused. The room left under MAX_MEMBERS, and `reserve` (a send allowance
 * the route passes in, since each invite can send an email), are checked for the whole batch before
 * anything is written, so a refused batch invites nobody. Two batches at the same moment can still
 * both pass the room check, as two single invites can; the invites are written one by one.
 */
export async function createInvites(
  id: string,
  input: z.infer<typeof bulkInviteSchema>,
  user: User,
  reserve: (count: number) => boolean = () => true,
): Promise<{ invites: WorkspaceInvite[]; skipped: Array<{ email: string; reason: InviteSkipReason }> }> {
  const ws = await requireRole(id, user, ["owner"]);
  const pending = await listInvites(id);
  const members = new Set(ws.members.flatMap((m) => (m.email ? [m.email.toLowerCase()] : [])));
  const invited = new Set(pending.flatMap((i) => (i.email ? [i.email.toLowerCase()] : [])));
  const seen = new Set<string>();
  const fresh: string[] = [];
  const skipped: Array<{ email: string; reason: InviteSkipReason }> = [];
  for (const email of input.emails) {
    const key = email.toLowerCase();
    if (seen.has(key)) skipped.push({ email, reason: "repeated" });
    else if (members.has(key)) skipped.push({ email, reason: "member" });
    else if (invited.has(key)) skipped.push({ email, reason: "pending" });
    else fresh.push(email);
    seen.add(key);
  }
  const room = MAX_MEMBERS - ws.members.length - pending.length;
  if (fresh.length > room) {
    throw new ValidationError(room > 0 ? `There is room for ${room} more of the ${MAX_MEMBERS} members a workspace can have; invite fewer at a time` : `At most ${MAX_MEMBERS} members per workspace`);
  }
  if (fresh.length && !reserve(fresh.length)) throw new LimitError("Too many invites from this workspace in the last hour; try again later");
  const invites: WorkspaceInvite[] = [];
  for (const email of fresh) invites.push(await putInvite(id, email, input.role));
  return { invites, skipped };
}

export async function revokeInvite(id: string, token: string, user: User): Promise<void> {
  await requireRole(id, user, ["owner"]);
  const invite = await getStore().get<WorkspaceInvite>("invite", token);
  if (invite && invite.ownerId === id) await getStore().remove("invite", token);
}

/**
 * Gives a pending invite a fresh expiry, the full 7 days from now, keeping its token, address and
 * role, so a resent email or a re-shared link works for another week. An invite that has already
 * expired reads as not found, the same as on the join page; create a new one instead. A second
 * resend within RESEND_COOLDOWN_MS is refused, since each one can send an email.
 */
export async function renewInvite(id: string, token: string, user: User): Promise<WorkspaceInvite> {
  await requireRole(id, user, ["owner"]);
  const invite = token && token.length <= 64 ? await getStore().get<WorkspaceInvite>("invite", token) : null;
  if (!invite || invite.ownerId !== id || Date.parse(invite.expiresAt) <= Date.now()) throw new NotFoundError("Invite not found or already expired");
  if (invite.renewedAt && Date.now() - Date.parse(invite.renewedAt) < RESEND_COOLDOWN_MS) {
    throw new LimitError("This invite was resent a few minutes ago; try again later");
  }
  const now = Date.now();
  const next: WorkspaceInvite = { ...invite, expiresAt: new Date(now + INVITE_TTL_MS).toISOString(), renewedAt: new Date(now).toISOString() };
  // Only over the record read: an invite accepted or revoked meanwhile stays gone rather than coming back for a week.
  if (!(await getStore().putIf("invite", next, "expiresAt", invite.expiresAt))) throw new NotFoundError("Invite not found or already expired");
  return next;
}

/**
 * Sends an expired invite again: a new link, with the same address and role and a full 7 days,
 * replaces the lapsed one, whose old link stays dead. Refused when the address has joined or has
 * another pending invite meanwhile, or when the workspace has no room left. `reserve` is the send
 * allowance the route passes in, taken only once every check has passed.
 */
export async function reinviteExpired(id: string, token: string, user: User, reserve: (count: number) => boolean = () => true): Promise<WorkspaceInvite> {
  const ws = await requireRole(id, user, ["owner"]);
  const old = token && token.length <= 64 ? await getStore().get<WorkspaceInvite>("invite", token) : null;
  if (!old || old.ownerId !== id || !recentlyExpired(old)) throw new NotFoundError("Expired invite not found");
  const pending = await listInvites(id);
  const key = old.email?.toLowerCase();
  if (key && ws.members.some((m) => m.email?.toLowerCase() === key)) throw new ValidationError(`${old.email} is already a member`);
  if (key && pending.some((i) => i.email?.toLowerCase() === key)) throw new ValidationError(`${old.email} already has a pending invite; resend that one`);
  if (ws.members.length + pending.length >= MAX_MEMBERS) throw new ValidationError(`At most ${MAX_MEMBERS} members per workspace`);
  if (!reserve(1)) throw new LimitError("Too many invites from this workspace in the last hour; try again later");
  // Claim the lapsed one first (it drops off the list), so two clicks, or a Dismiss at the same moment, make no second invite.
  if (!(await getStore().putIf("invite", { ...old, expiresAt: new Date(0).toISOString() }, "expiresAt", old.expiresAt))) throw new NotFoundError("Expired invite not found");
  const fresh = await putInvite(id, old.email, old.role);
  await getStore().remove("invite", old.id);
  return fresh;
}

/** Looks an invite up by token (for the join page): one get. Expired invites read as not found. */
export async function findInvite(token: string): Promise<{ workspace: Workspace; invite: WorkspaceInvite } | null> {
  if (!token || token.length > 64) return null;
  const invite = await getStore().get<WorkspaceInvite>("invite", token);
  if (!invite || Date.parse(invite.expiresAt) <= Date.now()) return null;
  const workspace = await getStore().get<Workspace>("workspace", invite.ownerId);
  return workspace ? { workspace, invite } : null;
}

/** Joins the workspace named by the token. Joining twice is a no-op; the invite is consumed either way. */
export async function acceptInvite(token: string, user: User): Promise<Workspace> {
  const found = await findInvite(token);
  if (!found) throw new NotFoundError("This invite link is invalid or has expired");
  const { workspace, invite } = found;
  const joinedAt = nowIso();
  const already = memberOf(workspace, user.id);
  const members = already ? workspace.members : [...workspace.members, { userId: user.id, email: user.email, role: invite.role, joinedAt }];
  const next = await getStore().put("workspace", { ...workspace, members, updatedAt: joinedAt });
  if (!already) await putMembership(next, user.id, invite.role, joinedAt);
  await getStore().remove("invite", token);
  return next;
}

/** Removes a member. Owners can remove anyone but the last owner; anyone can remove themselves (leave). */
export async function removeMember(id: string, userId: string, user: User): Promise<Workspace> {
  const ws = await getWorkspace(id);
  const actor = memberOf(ws, user.id);
  if (!actor) throw new NotFoundError("Workspace not found");
  if (userId !== user.id && actor.role !== "owner") throw new ValidationError("Only workspace owners can remove members");
  const target = memberOf(ws, userId);
  if (!target) throw new NotFoundError("Member not found");
  if (target.role === "owner" && ws.members.filter((m) => m.role === "owner").length === 1) {
    throw new ValidationError("A workspace needs at least one owner; delete it or promote someone first");
  }
  const next = await getStore().put("workspace", { ...ws, members: ws.members.filter((m) => m.userId !== userId), updatedAt: nowIso() });
  await getStore().remove("membership", membershipId(id, userId));
  // Keys the departing member minted under this workspace must not outlive their membership.
  await revokeApiKeysFor(id, userId);
  return next;
}

export async function setMemberRole(id: string, userId: string, role: WorkspaceRole, user: User): Promise<Workspace> {
  const ws = await requireRole(id, user, ["owner"]);
  const target = memberOf(ws, userId);
  if (!target) throw new NotFoundError("Member not found");
  if (target.role === "owner" && role !== "owner" && ws.members.filter((m) => m.role === "owner").length === 1) {
    throw new ValidationError("A workspace needs at least one owner");
  }
  const next = await getStore().put("workspace", { ...ws, members: ws.members.map((m) => (m.userId === userId ? { ...m, role } : m)), updatedAt: nowIso() });
  await putMembership(next, userId, role, target.joinedAt);
  // A key acts with the full power of the workspace; a member made a viewer keeps none.
  if (!roleCanEdit(role)) await revokeApiKeysFor(id, userId);
  return next;
}

/** Public view: member emails only for members, invite tokens (pending and recently expired) only for owners. */
export async function workspaceView(ws: Workspace, user: User) {
  const me = memberOf(ws, user.id);
  const owner = me?.role === "owner";
  const { pending: invites, expired } = owner ? await listAllInvites(ws.id) : { pending: [], expired: [] };
  return {
    id: ws.id,
    name: ws.name,
    role: me?.role ?? null,
    createdAt: ws.createdAt,
    members: ws.members.map((m) => ({ userId: m.userId, email: m.email, role: m.role, joinedAt: m.joinedAt, you: m.userId === user.id })),
    invites: invites.map((i) => ({ token: i.token, email: i.email, role: i.role, expiresAt: i.expiresAt })),
    expiredInvites: expired.map((i) => ({ token: i.token, email: i.email, role: i.role, expiresAt: i.expiresAt })),
    // Pending invites hold a seat until they are used or lapse; only owners, who see the invites, get the count.
    seats: owner ? { members: ws.members.length, pending: invites.length, max: MAX_MEMBERS } : undefined,
  };
}
