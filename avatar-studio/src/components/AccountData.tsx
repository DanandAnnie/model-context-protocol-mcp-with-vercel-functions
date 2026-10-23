"use client";
import { useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { api } from "@/lib/client";

/** Settings section: export everything as JSON, or delete everything in the active account or workspace. */
export function AccountData() {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function wipe() {
    if (!window.confirm("Delete every video, avatar, cloned voice, presenter, transcript, key, and setting in this space? This cannot be undone.")) return;
    setBusy(true);
    setErr(null);
    try {
      const { deleted } = await api<{ deleted: Record<string, number> }>("/api/account", { method: "DELETE", body: JSON.stringify({ confirm }) });
      const total = Object.values(deleted).reduce((n, c) => n + c, 0);
      setDone(`Deleted ${total} ${total === 1 ? "record" : "records"}.`);
      setConfirm("");
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 p-5" data-testid="account-data">
      <h3 className="text-sm font-semibold text-slate-900">Your data</h3>
      <p className="mt-1 text-xs text-slate-500">
        Export everything stored for this account or workspace as JSON (key and webhook secrets are left out), or delete all of it. Workspace membership is not affected.
      </p>
      <ErrorBanner message={err} />
      {done && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{done}</div>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <a href="/api/account/export" className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50" download>
          <Download className="h-4 w-4" /> Export JSON
        </a>
        <span className="flex-1" />
        <input aria-label="Type DELETE to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type DELETE" className={`${inputClass} w-36`} />
        <Button variant="danger" onClick={wipe} loading={busy} disabled={confirm !== "DELETE"}>
          <Trash2 className="h-4 w-4" /> Delete all data
        </Button>
      </div>
    </Card>
  );
}
