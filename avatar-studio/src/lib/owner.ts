// Resolves which workspace the current request belongs to.
import { cookies, headers } from "next/headers";
import { ownerForApiKey } from "./api-keys";
import { authMode } from "./auth";
import { UnauthorizedError } from "./errors";
import { createSupabaseServer } from "./supabase/server";
import { WORKSPACE_COOKIE, workspaceForMember, type User } from "./workspaces";

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
  if (authMode() !== "supabase") return { id: LOCAL_OWNER };
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new UnauthorizedError("Sign in required");
  return { id: user.id, email: user.email ?? undefined };
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
