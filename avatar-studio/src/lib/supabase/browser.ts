"use client";
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_PUBLIC_URL } from "./env";

export function createSupabaseBrowser() {
  if (!SUPABASE_PUBLIC_URL || !SUPABASE_ANON_KEY) throw new Error("Supabase auth is not configured");
  return createBrowserClient(SUPABASE_PUBLIC_URL, SUPABASE_ANON_KEY);
}
