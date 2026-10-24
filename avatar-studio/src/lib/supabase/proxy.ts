import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_PUBLIC_URL } from "./env";

/** Refresh the Supabase session cookies on every request and report the signed-in user id. */
export async function refreshSupabaseSession(request: NextRequest): Promise<{ response: NextResponse; userId: string | null }> {
  let response = NextResponse.next({ request });
  if (!SUPABASE_PUBLIC_URL || !SUPABASE_ANON_KEY) return { response, userId: null };
  const supabase = createServerClient(SUPABASE_PUBLIC_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(toSet) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { response, userId: user?.id ?? null };
}
