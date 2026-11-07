"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, Pencil, Trash2 } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import { API_KEY_ACCESS, type ApiKey, type ApiKeyAccess } from "@/lib/types";

/** A key as the server lists it, `expired` judged by the server's clock rather than this browser's. */
type PublicKey = Omit<ApiKey, "hash"> & { expired?: boolean };

/** What a key may do when it is made, as the server takes it, with how Settings names each. */
const ACCESS_LABELS: Record<ApiKeyAccess, string> = { full: "Full access", read: "Read only" };
const ACCESS = API_KEY_ACCESS.map((value) => ({ value, label: ACCESS_LABELS[value] }));

/** The lifetimes offered when a key is made ("" for one that never expires), as the server takes them. */
const LIFETIMES = [
  { value: "", label: "Never expires" },
  { value: "30", label: "Expires in 30 days" },
  { value: "90", label: "Expires in 90 days" },
  { value: "365", label: "Expires in 1 year" },
] as const;


/** Settings section: create, list, rename, and revoke personal API keys. The secret is shown once. */
export function ApiKeys() {
  const { data, error, refetch } = useApi<{ keys: PublicKey[] }>("/api/keys");
  const [name, setName] = useState("");
  const [lifetime, setLifetime] = useState<(typeof LIFETIMES)[number]["value"]>("");
  const [access, setAccess] = useState<ApiKeyAccess>("full");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The key just made, matched by id (two keys may share a name), with its one-time secret.
  const [fresh, setFresh] = useState<{ id: string; secret: string; readOnly: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  // The key being renamed, and the name typed for it.
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // The key whose new name is being saved.
  const [renameBusy, setRenameBusy] = useState<string | null>(null);
  const renameOpeners = useRef(new Map<string, HTMLButtonElement | null>());
  // The key whose Rename button takes focus once the form has closed (and the list has re-rendered).
  const [focusRename, setFocusRename] = useState<string | null>(null);
  useEffect(() => {
    if (!focusRename || renaming?.id === focusRename) return;
    // Another key's form took focus meanwhile: leave it there.
    if (renaming) return setFocusRename(null);
    renameOpeners.current.get(focusRename)?.focus();
    setFocusRename(null);
  }, [focusRename, renaming, data]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ key: PublicKey; secret: string }>("/api/keys", { method: "POST", body: JSON.stringify({ name, ...(lifetime ? { expiresInDays: Number(lifetime) } : {}), ...(access === "read" ? { access } : {}) }) });
      setFresh({ id: res.key.id, secret: res.secret, readOnly: res.key.access === "read" });
      setName("");
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the key");
    } finally {
      setBusy(false);
    }
  }

  /** Closes the rename form and puts focus back on the Rename button it came from. */
  function closeRename(id: string) {
    // Only this key's form: one opened on another key while this one saved stays open.
    setRenaming((r) => (r?.id === id ? null : r));
    setFocusRename(id);
  }

  async function rename(key: PublicKey) {
    if (!renaming || !renaming.name.trim()) return;
    if (renaming.name.trim() === key.name) return closeRename(key.id);
    const name = renaming.name;
    setRenameBusy(key.id);
    setErr(null);
    try {
      await api(`/api/keys/${key.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await refetch();
      closeRename(key.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not rename the key");
    } finally {
      setRenameBusy(null);
    }
  }

  async function revoke(key: PublicKey) {
    if (!window.confirm(`Revoke "${key.name}"? Scripts using it will stop working immediately.`)) return;
    setErr(null);
    try {
      await api(`/api/keys/${key.id}`, { method: "DELETE" });
      if (fresh?.id === key.id) setFresh(null);
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
            Call every <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">/api/*</code> endpoint from scripts with <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">Authorization: Bearer &lt;key&gt;</code>. Keys act as your account; a read-only key can list and fetch (and download exports) but not create, change, or delete. Creating, renaming, and revoking keys needs a signed-in session.
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
        <select aria-label="Key expiry" value={lifetime} onChange={(e) => setLifetime(e.target.value as typeof lifetime)} title="A key that expires stops working on its own; scripts then need a new one" className={`${inputClass} w-auto`}>
          {LIFETIMES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        <select aria-label="Key access" value={access} onChange={(e) => setAccess(e.target.value as typeof access)} title="A read-only key can list and fetch, not create, change, or delete" className={`${inputClass} w-auto`}>
          {ACCESS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
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
          <pre className="mt-3 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
            {fresh.readOnly
              ? `curl ${origin}/api/videos \\
  -H "Authorization: Bearer ${fresh.secret}"`
              : `curl ${origin}/api/videos \\
  -H "Authorization: Bearer ${fresh.secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Hello","script":"Hi there.","avatarId":"stock_1","voiceId":"stock_voice_1","aspect":"16:9"}'`}
          </pre>
        </div>
      )}
      <ul className="mt-4 divide-y divide-slate-100">
        {data?.keys.length === 0 && <li className="py-3 text-xs text-slate-500">No API keys yet.</li>}
        {data?.keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              {renaming?.id === k.id ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename(k);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && renameBusy !== k.id) {
                      e.preventDefault();
                      closeRename(k.id);
                    }
                  }}
                >
                  <input
                    aria-label={`New name for ${k.name}`}
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: k.id, name: e.target.value })}
                    maxLength={60}
                    autoFocus
                    className={`${inputClass} max-w-xs py-1 text-sm`}
                  />
                  <Button type="submit" className="px-2.5 py-1 text-xs" loading={renameBusy === k.id} disabled={!renaming.name.trim()}>
                    Save
                  </Button>
                  <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => closeRename(k.id)} disabled={renameBusy === k.id}>
                    Cancel
                  </Button>
                </form>
              ) : (
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-slate-900">{k.name}</span>
                {k.access === "read" && (
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700" data-testid="key-read-only">
                    Read only
                  </span>
                )}
              </div>
              )}
              <div className="text-xs text-slate-500">
                <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">{k.prefix}…</code> · created {formatDate(k.createdAt)}
                {k.lastUsedAt ? ` · last used ${formatDate(k.lastUsedAt)}` : " · never used"}
                {k.expiresAt && !k.expired ? ` · expires ${formatDate(k.expiresAt)}` : ""}
                {k.expiresAt && k.expired && (
                  <>
                    {" · "}
                    <span className="font-medium text-red-700" data-testid="key-expired">
                      expired {formatDate(k.expiresAt)}; requests with it are refused
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                ref={(el: HTMLButtonElement | null) => {
                  renameOpeners.current.set(k.id, el);
                }}
                variant="secondary"
                className="px-2.5 py-1 text-xs"
                onClick={() => setRenaming({ id: k.id, name: k.name })}
                aria-label={`Rename ${k.name}`}
              >
                <Pencil className="h-3.5 w-3.5" /> Rename
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => revoke(k)} aria-label={`Revoke ${k.name}`}>
                <Trash2 className="h-3.5 w-3.5" /> Revoke
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
