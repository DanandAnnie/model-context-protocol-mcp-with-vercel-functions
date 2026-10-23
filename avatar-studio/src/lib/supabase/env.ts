// Public Supabase settings. Present on both server and client (NEXT_PUBLIC_*).
export const SUPABASE_PUBLIC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || undefined;
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || undefined;

export function supabaseAuthConfigured(): boolean {
  return Boolean(SUPABASE_PUBLIC_URL && SUPABASE_ANON_KEY);
}
