// Resolves which workspace the current request belongs to.
import { cookies, headers } from "next/headers";
import { ownerForApiKey } from "./api-keys";
import { SESSION_COOKIE, authMode, isValidSession } from "./auth";
import { ForbiddenError, UnauthorizedError } from "./errors";
import { createSupabaseServer } from "./supabase/server";
import { WORKSPACE_COOKIE, canEdit, canManageAccount, isWorkspaceId, workspaceForMember, type User } from "./workspaces";

import { LOCAL_OWNER } from "./owner-id";
export { LOCAL_OWNER };

/** The bearer secret on this request, if any. */
export async function presentedApiKey(): Promise<string | null> {
  const auth = (await headers()).get("authorization");
  if (!auth || !/^Bearer\s+/i.test(auth)) return null;
  return auth.replace(/^Bearer\s+/i, "").trim() || null;
}

/** The signed-in person (their personal owner id), independent of any active workspace. */
export async function currentUser(): Promise<User> {
  const mode = authMode();
  if (mode === "open") return { id: LOCAL_OWNER };
  if (mode === "password") {
    // The proxy already checks this for session requests; route handlers reached with a
    // non-key bearer header or by other means must not get the shared owner for free.
    if (!(await isValidSession((await cookies()).get(SESSION_COOKIE)?.value))) throw new UnauthorizedError("Sign in required");
    return { id: LOCAL_OWNER };
  }
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new UnauthorizedError("Sign in required");
  return { id: user.id, email: user.email ?? undefined };
}

/**
 * The person behind the request for attribution. A script with an API key carries no session,
 * so it is credited to the key's owner; any other failure to resolve the user is an error, not
 * a reason to credit the work to the workspace and leave its real author unable to undo it.
 */
export async function userOrOwner(owner: string): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return { id: owner };
    throw err;
  }
}

/** The workspace selected by the cookie, when the user is still a member of it. */
export async function activeWorkspaceId(user: User): Promise<string | null> {
  const id = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  if (!id) return null;
  const ws = await workspaceForMember(id, user.id);
  return ws ? ws.id : null;
}

/**
 * Owner of the current request. An `Authorization: Bearer <api key>` header wins over the
 * session (so scripts work in every auth mode); an unknown key is rejected even in open mode.
 * Otherwise the active workspace (cookie) when the user belongs to it, else their personal id.
 */
export async function requireOwner(): Promise<string> {
  const secret = await presentedApiKey();
  if (secret) {
    const owner = await ownerForApiKey(secret);
    if (!owner) throw new UnauthorizedError("Invalid API key");
    return owner;
  }
  const user = await currentUser();
  return (await activeWorkspaceId(user)) ?? user.id;
}

/**
 * Owner of the current request for an action that creates, changes, or deletes content. Like
 * `requireOwner`, except that a workspace viewer gets 403: viewers watch and comment. A key is
 * trusted as is; viewers cannot mint one and a member made a viewer loses theirs.
 */
export async function requireEditor(): Promise<string> {
  if (await presentedApiKey()) return requireOwner();
  const user = await currentUser();
  const id = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const ws = id && isWorkspaceId(id) ? await workspaceForMember(id, user.id) : null;
  if (!ws) return user.id;
  if (!canEdit(ws, user.id)) throw new ForbiddenError("Viewers can watch and comment in this workspace, not change it");
  return ws.id;
}

/** The request's owner when it carries a valid key or session, else null; never throws for a missing one. */
export async function optionalOwner(): Promise<string | null> {
  try {
    return await requireOwner();
  } catch (err) {
    if (err instanceof UnauthorizedError) return null;
    throw err;
  }
}

/**
 * Owner of the current request for account-level actions (wiping all data, billing): session
 * only, and when the active owner is a team workspace the signed-in person must hold the
 * owner role there. Editors keep full content access but cannot cancel the team's plan or
 * delete everything at once.
 */
export async function requireAccountOwner(): Promise<string> {
  const user = await currentUser();
  const id = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const ws = id && isWorkspaceId(id) ? await workspaceForMember(id, user.id) : null;
  if (!ws) return user.id;
  if (!canManageAccount(ws, user.id)) throw new ForbiddenError("Only workspace owners can do that");
  return ws.id;
}
