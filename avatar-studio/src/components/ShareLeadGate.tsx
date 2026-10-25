"use client";
import { useState } from "react";
import { Mail } from "lucide-react";
import { api } from "@/lib/client";

/**
 * The form a viewer fills in before a gated share page plays: an email, and a name if they like. Once the
 * email is in, the player (`children`) shows straight away rather than after a reload, because an embedded
 * page in a browser that blocks third-party cookies would otherwise never remember the pass.
 */
export function ShareLeadGate({ videoId, brandName, open, children }: { videoId: string; brandName?: string; open: boolean; children: React.ReactNode }) {
  const [passed, setPassed] = useState(open);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/videos/${videoId}/lead`, { method: "POST", body: JSON.stringify({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}) }) });
      setPassed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not continue");
    } finally {
      setBusy(false);
    }
  }

  if (passed) return <>{children}</>;

  const field = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none";
  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-6 text-center" data-testid="share-gate">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-800 text-slate-300">
        <Mail className="h-5 w-5" />
      </span>
      <p className="text-sm text-slate-300">Enter your email to watch this video.</p>
      <input type="email" required aria-label="Your email" aria-describedby={error ? "share-gate-error" : undefined} aria-invalid={error ? true : undefined} autoComplete="email" className={field} placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
      <input aria-label="Your name (optional)" autoComplete="name" className={field} placeholder="Your name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      <button type="submit" disabled={!email.trim() || busy} className="w-full rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-200 disabled:opacity-50">
        {busy ? "Opening…" : "Watch video"}
      </button>
      <p className="text-xs text-slate-500">Your email goes to {brandName ? brandName : "the person who shared this video"}.</p>
      {error && <p id="share-gate-error" className="text-xs text-rose-400" role="alert">{error}</p>}
    </form>
  );
}
