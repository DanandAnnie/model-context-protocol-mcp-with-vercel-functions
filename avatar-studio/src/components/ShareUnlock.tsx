"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "@/lib/client";

/** The password form a visitor sees on a protected share page. A correct password sets a cookie and re-renders the page. */
export function ShareUnlock({ videoId }: { videoId: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/videos/${videoId}/unlock`, { method: "POST", body: JSON.stringify({ password }) });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlock the video");
    } finally {
      // A browser that drops the cookie shows the form again; it must not be left on "Checking…".
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-6 text-center" data-testid="share-unlock">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-800 text-slate-300">
        <Lock className="h-5 w-5" />
      </span>
      <p className="text-sm text-slate-300">This video is password protected.</p>
      <input
        type="password"
        aria-label="Password"
        autoComplete="off"
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
        placeholder="Enter the password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" disabled={!password || busy} className="w-full rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-200 disabled:opacity-50">
        {busy ? "Checking…" : "Watch video"}
      </button>
      {error && <p className="text-xs text-rose-400" role="alert">{error}</p>}
    </form>
  );
}
