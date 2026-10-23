// Team workspaces: a shared owner id with members. Membership is joined through invite links.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { revokeApiKeysFor } from "./api-keys";
import { deleteNotifySettings } from "./notifications";
import { NotFoundError, ValidationError } from "./errors";
import { newId, nowIso } from "./ids";
import { getStore } from "./store";
import type { Workspace, WorkspaceRole } from "./types";

export const WORKSPACE_COOKIE = "studio_workspace";
export const MAX_WORKSPACES_PER_USER = 20;
export const MAX_MEMBERS = 50;
const INVITE_TTL_MS = 7 * 86_400_000;

export const workspaceNameSchema = z.object({ name: z.string().trim().min(1).max(60) });
export const inviteSchema = z.object({ email: z.string().trim().email().max(200).optional(), role: z.enum(["owner", "editor"]).default("editor") });

export interface User {
  id: string;
  email?: string;
}

export const isWorkspaceId = (id: string) => id.startsWith("ws_");

export function memberOf(ws: Workspace, userId: string) {
  return ws.members.find((m) => m.userId === userId) ?? null;
}

/** Every workspace the user belongs to, newest first. */
export async function listWorkspaces(userId: string): Promise<Workspace[]> {
  const all = await getStore().list<Workspace>("workspace");
  return all.filter((w) => memberOf(w, userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    invites: [],
    createdAt: now,
    updatedAt: now,
  };
  return getStore().put("workspace", ws);
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
  await requireRole(id, user, ["owner"]);
  await revokeApiKeysFor(id);
  await deleteNotifySettings(id);
  await getStore().remove("workspace", id);
}

export async function createInvite(id: string, input: z.infer<typeof inviteSchema>, user: User) {
  const ws = await requireRole(id, user, ["owner"]);
  if (ws.members.length + ws.invites.length >= MAX_MEMBERS) throw new ValidationError(`At most ${MAX_MEMBERS} members per workspace`);
  const now = Date.now();
  const invite = { token: randomBytes(18).toString("base64url"), email: input.email, role: input.role, createdAt: nowIso(), expiresAt: new Date(now + INVITE_TTL_MS).toISOString() };
  const invites = [...ws.invites.filter((i) => Date.parse(i.expiresAt) > now), invite];
  await getStore().put("workspace", { ...ws, invites, updatedAt: nowIso() });
  return invite;
}

export async function revokeInvite(id: string, token: string, user: User): Promise<void> {
  const ws = await requireRole(id, user, ["owner"]);
  await getStore().put("workspace", { ...ws, invites: ws.invites.filter((i) => i.token !== token), updatedAt: nowIso() });
}

/** Looks an invite up by token (for the join page). Expired invites read as not found. */
export async function findInvite(token: string): Promise<{ workspace: Workspace; invite: Workspace["invites"][number] } | null> {
  if (!token) return null;
  const all = await getStore().list<Workspace>("workspace");
  for (const workspace of all) {
    const invite = workspace.invites.find((i) => i.token === token);
    if (invite) return Date.parse(invite.expiresAt) > Date.now() ? { workspace, invite } : null;
  }
  return null;
}

/** Joins the workspace named by the token. Joining twice is a no-op; the invite is consumed either way. */
export async function acceptInvite(token: string, user: User): Promise<Workspace> {
  const found = await findInvite(token);
  if (!found) throw new NotFoundError("This invite link is invalid or has expired");
  const { workspace, invite } = found;
  const members = memberOf(workspace, user.id) ? workspace.members : [...workspace.members, { userId: user.id, email: user.email, role: invite.role, joinedAt: nowIso() }];
  return getStore().put("workspace", { ...workspace, members, invites: workspace.invites.filter((i) => i.token !== token), updatedAt: nowIso() });
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
  return getStore().put("workspace", { ...ws, members: ws.members.map((m) => (m.userId === userId ? { ...m, role } : m)), updatedAt: nowIso() });
}

/** Public view: member emails only for members, invite tokens only for owners. */
export function workspaceView(ws: Workspace, user: User) {
  const me = memberOf(ws, user.id);
  return {
    id: ws.id,
    name: ws.name,
    role: me?.role ?? null,
    createdAt: ws.createdAt,
    members: ws.members.map((m) => ({ userId: m.userId, email: m.email, role: m.role, joinedAt: m.joinedAt, you: m.userId === user.id })),
    invites: me?.role === "owner" ? ws.invites.filter((i) => Date.parse(i.expiresAt) > Date.now()) : [],
  };
}
