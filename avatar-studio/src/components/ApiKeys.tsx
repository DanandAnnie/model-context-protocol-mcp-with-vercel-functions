"use client";
import { useState } from "react";
import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import type { ApiKey } from "@/lib/types";

type PublicKey = Omit<ApiKey, "hash">;

/** Settings section: create, list, and revoke personal API keys. The secret is shown once. */
export function ApiKeys() {
  const { data, error, refetch } = useApi<{ keys: PublicKey[] }>("/api/keys");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ key: PublicKey; secret: string }>("/api/keys", { method: "POST", body: JSON.stringify({ name }) });
      setFresh({ name: res.key.name, secret: res.secret });
      setName("");
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the key");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: PublicKey) {
    if (!window.confirm(`Revoke "${key.name}"? Scripts using it will stop working immediately.`)) return;
    setErr(null);
    try {
      await api(`/api/keys/${key.id}`, { method: "DELETE" });
      if (fresh && fresh.name === key.name) setFresh(null);
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not revoke the key");
    }
  }

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this key", fresh.secret);
    }
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <Card className="mt-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <KeyRound className="h-4 w-4 text-slate-400" /> Developer API
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Call every <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">/api/*</code> endpoint from scripts with <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">Authorization: Bearer &lt;key&gt;</code>. Keys act as your account; creating and revoking keys needs a signed-in session.
          </p>
        </div>
      </div>
      <ErrorBanner message={error ?? err} />
      <form
        className="mt-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input aria-label="Key name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. Zapier" maxLength={60} className={`${inputClass} max-w-xs`} />
        <Button type="submit" loading={busy} disabled={!name.trim()}>
          Create key
        </Button>
      </form>
      {fresh && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="fresh-key">
          <div className="font-medium">Copy your new key now. It will not be shown again.</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs text-slate-900">{fresh.secret}</code>
            <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="mt-3 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{`curl ${origin}/api/videos \\
  -H "Authorization: Bearer ${fresh.secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Hello","script":"Hi there.","avatarId":"stock_1","voiceId":"stock_voice_1","aspect":"16:9"}'`}</pre>
        </div>
      )}
      <ul className="mt-4 divide-y divide-slate-100">
        {data?.keys.length === 0 && <li className="py-3 text-xs text-slate-500">No API keys yet.</li>}
        {data?.keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-900">{k.name}</div>
              <div className="text-xs text-slate-500">
                <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">{k.prefix}…</code> · created {formatDate(k.createdAt)}
                {k.lastUsedAt ? ` · last used ${formatDate(k.lastUsedAt)}` : " · never used"}
              </div>
            </div>
            <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => revoke(k)} aria-label={`Revoke ${k.name}`}>
              <Trash2 className="h-3.5 w-3.5" /> Revoke
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
