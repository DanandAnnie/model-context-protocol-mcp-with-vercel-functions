import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_PUBLIC_URL } from "./env";

/** Cookie-backed Supabase client for route handlers and server components. */
export async function createSupabaseServer() {
  if (!SUPABASE_PUBLIC_URL || !SUPABASE_ANON_KEY) throw new Error("Supabase auth is not configured");
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_PUBLIC_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Server components cannot set cookies; the proxy refreshes sessions instead.
        }
      },
    },
  });
}
