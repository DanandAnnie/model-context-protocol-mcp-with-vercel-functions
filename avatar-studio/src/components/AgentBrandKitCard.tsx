"use client";
import Link from "next/link";
import { useState } from "react";
import { Globe, Sparkles, Trash2 } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/client";
import type { AgentBrandKit } from "@/lib/types";

/** How often the card asks again while HeyGen reads the page (HeyGen suggests every 2 to 5 seconds). */
const POLL_MS = 3000;

/**
 * The account's HeyGen brand kit: HeyGen reads the colours, fonts, and logo of a website and its Video Agent dresses
 * every directed video in them. Import, what HeyGen read (while it reads, the card checks back), import again, remove.
 */
export function AgentBrandKitCard({ canEdit }: { canEdit: boolean }) {
  const { data, error, refetch, setData } = useApi<{ kit: AgentBrandKit | null }>("/api/brand/heygen", { pollMs: POLL_MS, pollWhile: (d) => d.kit?.status === "loading" });
  const kit = data?.kit ?? null;
  const [site, setSite] = useState("");
  const [busy, setBusy] = useState<"import" | "remove" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function importSite() {
    setBusy("import");
    setErr(null);
    setNote(null);
    try {
      const out = await api<{ kit: AgentBrandKit }>("/api/brand/heygen", { method: "POST", body: JSON.stringify({ url: site.trim() }) });
      setData({ kit: out.kit });
      setSite("");
      setNote("HeyGen is reading the page; this takes up to two minutes. Directed videos use the kit from now on.");
      void refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "HeyGen could not import that page");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm("Stop dressing HeyGen-directed videos in this brand kit? Videos already made keep their look.")) return;
    setBusy("remove");
    setErr(null);
    setNote(null);
    try {
      await api("/api/brand/heygen", { method: "DELETE" });
      setData({ kit: null });
      // A check already on its way is set aside, so it cannot bring the removed kit back.
      void refetch();
      setNote("Removed; new directed videos are no longer dressed in a HeyGen brand kit.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove the HeyGen brand kit");
    } finally {
      setBusy(null);
    }
  }

  const statusLine = !kit ? null : kit.status === "loading" ? "HeyGen is reading the page…" : kit.status === "completed" ? "Ready" : (kit.error ?? "HeyGen stopped reading the page early");
  return (
    <Card className="p-4 text-sm text-slate-600" data-testid="agent-brand-kit">
      <section aria-labelledby="agent-brand-title">
        <h3 id="agent-brand-title" className="mb-1 flex items-center gap-1.5 font-semibold text-slate-900">
          <Sparkles className="h-4 w-4 text-brand-600" aria-hidden /> HeyGen brand kit
        </h3>
        <p className="text-xs text-slate-500">
          HeyGen reads your website&apos;s colours, fonts, and logo, and its Video Agent uses them in every video it <Link href="/agent" className="underline">directs</Link> for you. The kit is yours alone; the form beside this is not changed.
        </p>
        {kit && (
          <div className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3">
            <div className="flex items-center gap-2">
              {kit.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={kit.logoUrl} alt="" className="h-8 w-8 rounded bg-slate-50 object-contain p-0.5" />
              )}
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-900">{kit.name || new URL(kit.url).hostname}</div>
                <div className="truncate text-xs text-slate-500">{kit.url}</div>
              </div>
            </div>
            <p role="status" className={`text-xs ${kit.status === "error" ? "text-amber-800" : kit.status === "completed" ? "text-emerald-700" : "text-slate-600"}`} data-testid="agent-brand-status">
              {statusLine}
            </p>
            {!!kit.colors?.length && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Colours HeyGen read">
                {kit.colors.map((c) => (
                  <li key={c} className="flex items-center gap-1 text-xs">
                    <span className="h-4 w-4 rounded border border-slate-200" style={{ background: c }} aria-hidden />
                    <span className="font-mono">{c}</span>
                  </li>
                ))}
              </ul>
            )}
            {!!kit.fonts?.length && <p className="text-xs">Fonts: {kit.fonts.join(", ")}</p>}
            <Button type="button" variant="secondary" onClick={() => void remove()} loading={busy === "remove"} disabled={!!busy || !canEdit}>
              <Trash2 className="h-4 w-4" /> Remove
            </Button>
          </div>
        )}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void importSite();
          }}
        >
          <input aria-label="Website for HeyGen to read" value={site} onChange={(e) => setSite(e.target.value)} placeholder="acme.com" maxLength={2000} className={inputClass} disabled={!!busy || !canEdit} />
          <Button type="submit" variant="secondary" loading={busy === "import"} disabled={!site.trim() || !!busy || !canEdit}>
            <Globe className="h-4 w-4" /> {kit ? "Import again" : "Import"}
          </Button>
        </form>
        <p className="mt-1 text-xs text-slate-500">Use a public page that opens without a login. By importing, you confirm you may use the site&apos;s logos, fonts, and colours.</p>
        <span role="status" className="mt-2 block text-xs empty:hidden" data-testid="agent-brand-note">
          {err || error ? <span className="text-rose-700">{err ?? error}</span> : note ? <span className="text-emerald-700">{note}</span> : null}
        </span>
      </section>
    </Card>
  );
}
