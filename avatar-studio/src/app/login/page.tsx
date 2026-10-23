"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Lock, Sparkles } from "lucide-react";
import { Button, ErrorBanner, inputClass } from "@/components/ui";
import { api } from "@/lib/client";

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
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      const next = params.get("next");
      router.replace(next && next.startsWith("/") ? next : "/home");
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
        <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
        <p className="mt-1 text-sm text-slate-500">Enter the studio password to continue.</p>
        <label className="mt-5 block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Password</span>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              className={`${inputClass} pl-9`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </label>
        <div className="mt-4">
          <ErrorBanner message={err} />
        </div>
        <Button type="submit" loading={busy} disabled={!password} className="mt-4 w-full">
          Continue
        </Button>
      </form>
    </main>
  );
}
