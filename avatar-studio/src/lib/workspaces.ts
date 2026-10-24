// Team workspaces: a shared owner id with members. Membership is joined through invite links.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { revokeApiKeysFor } from "./api-keys";
import { deleteNotifySettings } from "./notifications";
import { NotFoundError, ValidationError } from "./errors";
import { newId, nowIso } from "./ids";
import { getStore } from "./store";
import type { Membership, Workspace, WorkspaceInvite, WorkspaceRole } from "./types";
import { roleCanEdit, roleSchema } from "./roles";

export const WORKSPACE_COOKIE = "studio_workspace";
export const MAX_WORKSPACES_PER_USER = 20;
export const MAX_MEMBERS = 50;
const INVITE_TTL_MS = 7 * 86_400_000;

export const workspaceNameSchema = z.object({ name: z.string().trim().min(1).max(60) });
export const inviteSchema = z.object({ email: z.string().trim().email().max(200).optional(), role: roleSchema.default("editor") });

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
 * can act as the workspace afterwards. Its videos and brand kit stay in the store but are unreachable.
 */
export async function deleteWorkspace(id: string, user: User): Promise<void> {
  const ws = await requireRole(id, user, ["owner"]);
  await revokeApiKeysFor(id);
  await deleteNotifySettings(id);
  for (const m of ws.members) await getStore().remove("membership", membershipId(id, m.userId));
  for (const i of await getStore().list<WorkspaceInvite>("invite", id)) await getStore().remove("invite", i.id);
  await getStore().remove("workspace", id);
}

export async function createInvite(id: string, input: z.infer<typeof inviteSchema>, user: User): Promise<WorkspaceInvite> {
  const ws = await requireRole(id, user, ["owner"]);
  const pending = await listInvites(id);
  if (ws.members.length + pending.length >= MAX_MEMBERS) throw new ValidationError(`At most ${MAX_MEMBERS} members per workspace`);
  const token = randomBytes(18).toString("base64url");
  const invite: WorkspaceInvite = { id: token, token, ownerId: id, email: input.email, role: input.role, createdAt: nowIso(), expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() };
  return getStore().put("invite", invite);
}

export async function revokeInvite(id: string, token: string, user: User): Promise<void> {
  await requireRole(id, user, ["owner"]);
  const invite = await getStore().get<WorkspaceInvite>("invite", token);
  if (invite && invite.ownerId === id) await getStore().remove("invite", token);
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

/** Public view: member emails only for members, invite tokens only for owners. */
export async function workspaceView(ws: Workspace, user: User) {
  const me = memberOf(ws, user.id);
  const invites = me?.role === "owner" ? await listInvites(ws.id) : [];
  return {
    id: ws.id,
    name: ws.name,
    role: me?.role ?? null,
    createdAt: ws.createdAt,
    members: ws.members.map((m) => ({ userId: m.userId, email: m.email, role: m.role, joinedAt: m.joinedAt, you: m.userId === user.id })),
    invites: invites.map((i) => ({ token: i.token, email: i.email, role: i.role, expiresAt: i.expiresAt })),
  };
}
