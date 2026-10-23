// Resolves which workspace the current request belongs to.
import { headers } from "next/headers";
import { ownerForApiKey } from "./api-keys";
import { authMode } from "./auth";
import { UnauthorizedError } from "./errors";
import { createSupabaseServer } from "./supabase/server";

import { LOCAL_OWNER } from "./owner-id";
export { LOCAL_OWNER };

/** The bearer secret on this request, if any. */
export async function presentedApiKey(): Promise<string | null> {
  const auth = (await headers()).get("authorization");
  if (!auth || !/^Bearer\s+/i.test(auth)) return null;
  return auth.replace(/^Bearer\s+/i, "").trim() || null;
}

/**
 * Owner of the current request. An `Authorization: Bearer <api key>` header wins over the
 * session (so scripts work in every auth mode); an unknown key is rejected even in open mode.
 */
export async function requireOwner(): Promise<string> {
  const secret = await presentedApiKey();
  if (secret) {
    const owner = await ownerForApiKey(secret);
    if (!owner) throw new UnauthorizedError("Invalid API key");
    return owner;
  }
  if (authMode() !== "supabase") return LOCAL_OWNER;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new UnauthorizedError("Sign in required");
  return user.id;
}
