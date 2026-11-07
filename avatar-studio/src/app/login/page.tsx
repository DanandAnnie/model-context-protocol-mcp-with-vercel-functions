"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Lock, Mail, Sparkles } from "lucide-react";
import { Button, ErrorBanner, inputClass } from "@/components/ui";
import { api } from "@/lib/client";
import { supabaseAuthConfigured } from "@/lib/supabase/env";
import { createSupabaseBrowser } from "@/lib/supabase/browser";
import { safeNextPath } from "@/lib/safe-url-client";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const target = safeNextPath(params.get("next"));
  const accounts = supabaseAuthConfigured();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(params.get("error"));
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      if (accounts) {
        const supabase = createSupabaseBrowser();
        if (mode === "signup") {
          const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(target)}` },
          });
          if (error) throw error;
          if (!data.session) {
            setNotice("Check your email to confirm your account, then sign in.");
            setMode("signin");
            return;
          }
        } else {
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
        router.replace(target);
        router.refresh();
      } else {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
        router.replace(target);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Sparkles className="h-4 w-4" />
          </span>
          <span className="text-base font-semibold">Avatar Studio</span>
        </div>
        <h1 className="text-lg font-semibold text-slate-900">{accounts && mode === "signup" ? "Create your account" : "Sign in"}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {accounts ? "Your videos, avatars, and translations are private to your account." : "Enter the studio password to continue."}
        </p>

        {accounts && (
          <label className="mt-5 block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Email</span>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input type="email" autoComplete="email" required className={`${inputClass} pl-9`} value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </label>
        )}
        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Password</span>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="password"
              autoFocus={!accounts}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              minLength={accounts ? 6 : undefined}
              className={`${inputClass} pl-9`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </label>
        <div className="mt-4 space-y-2">
          <ErrorBanner message={err} />
          {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>}
        </div>
        <Button type="submit" loading={busy} disabled={!password || (accounts && !email)} className="mt-4 w-full">
          {accounts && mode === "signup" ? "Create account" : "Continue"}
        </Button>
        {accounts && (
          <p className="mt-4 text-center text-xs text-slate-500">
            {mode === "signup" ? "Already have an account? " : "New here? "}
            <button type="button" className="font-medium text-brand-600 hover:underline" onClick={() => setMode(mode === "signup" ? "signin" : "signup")}>
              {mode === "signup" ? "Sign in" : "Create an account"}
            </button>
          </p>
        )}
      </form>
    </main>
  );
}
