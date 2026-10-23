// Resolves which workspace the current request belongs to.
import { authMode } from "./auth";
import { UnauthorizedError } from "./errors";
import { createSupabaseServer } from "./supabase/server";

/** Owner id used when there are no per-user accounts (open or password mode). */
export const LOCAL_OWNER = "local";

export async function requireOwner(): Promise<string> {
  if (authMode() !== "supabase") return LOCAL_OWNER;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new UnauthorizedError("Sign in required");
  return user.id;
}
