"use client";
import Link from "next/link";
import { useState } from "react";
import { Building2, Plus } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/client";

interface Summary {
  personalId: string;
  activeId: string;
  workspaces: Array<{ id: string; name: string; role: string | null; members: unknown[] }>;
}

/** Sidebar control: pick the active workspace (or personal space) and create new ones. */
export function WorkspaceSwitcher() {
  const { data, refetch } = useApi<Summary>("/api/workspaces");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;
  const active = data.workspaces.find((w) => w.id === data.activeId);

  async function switchTo(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/workspaces/switch", { method: "POST", body: JSON.stringify({ id }) });
      // Every page reads the owner from the cookie, so a full reload is the simplest consistent refresh.
      window.location.href = "/home";
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not switch workspace");
      setBusy(false);
    }
  }

  async function create() {
    const name = window.prompt("Workspace name", "");
    if (!name?.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { workspace } = await api<{ workspace: { id: string } }>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) });
      await refetch();
      await switchTo(workspace.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the workspace");
      setBusy(false);
    }
  }

  return (
    <div className="px-3 pb-3">
      <label className="block">
        <span className="sr-only">Workspace</span>
        <div className="flex items-center gap-1.5">
          <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
          <select
            aria-label="Workspace"
            value={data.activeId}
            disabled={busy}
            onChange={(e) => switchTo(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800 focus:border-brand-500 focus:outline-none"
          >
            <option value={data.personalId}>Personal</option>
            {data.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      </label>
      <div className="mt-1.5 flex items-center justify-between text-xs">
        <button type="button" onClick={create} disabled={busy} className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-900">
          <Plus className="h-3 w-3" /> New workspace
        </button>
        {active && (
          <Link href="/workspace" className="font-medium text-brand-600 hover:underline">
            Members
          </Link>
        )}
      </div>
      {err && <div className="mt-1 text-xs text-rose-700">{err}</div>}
    </div>
  );
}
