"use client";
import { useEffect, useState } from "react";
import { Send, Trash2, Webhook } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import type { NotifySettings } from "@/lib/types";

/** Settings section: one signed outbound webhook per account, fired when a render completes or fails. */
export function OutboundWebhook() {
  const { data, error, refetch } = useApi<{ webhook: NotifySettings | null }>("/api/notifications");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const saved = data?.webhook ?? null;

  useEffect(() => {
    if (saved) setUrl(saved.url);
  }, [saved]);

  async function save() {
    setBusy("save");
    setErr(null);
    setNote(null);
    try {
      await api("/api/notifications", { method: "PUT", body: JSON.stringify({ url }) });
      await refetch();
      setNote("Webhook saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the webhook");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setErr(null);
    setNote(null);
    try {
      const { delivery } = await api<{ delivery: NonNullable<NotifySettings["lastDelivery"]> }>("/api/notifications/test", { method: "POST" });
      setNote(delivery.ok ? `Test delivered (HTTP ${delivery.status}).` : `Test failed: ${delivery.error ?? "no response"}.`);
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send the test");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm("Remove the webhook? Finished renders will no longer be reported.")) return;
    setBusy("remove");
    setErr(null);
    setNote(null);
    try {
      await api("/api/notifications", { method: "DELETE" });
      setUrl("");
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove the webhook");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-6 p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Webhook className="h-4 w-4 text-slate-400" /> Webhook notifications
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        A signed <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">POST</code> is sent to your endpoint when a render completes or fails (events <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">video.completed</code>, <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">video.failed</code>), and when a visitor leaves an email with a shared presenter or at a share page's email gate (<code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">lead.captured</code>, whose <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">source</code> is <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">presenter</code> or <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">share</code>). Verify <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">X-Studio-Signature</code> as HMAC-SHA256 of <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">{"<timestamp>.<body>"}</code> with your secret. Private and local hosts are rejected.
      </p>
      <ErrorBanner message={error ?? err} />
      {note && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{note}</div>}
      <form
        className="mt-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input aria-label="Webhook URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/avatar-studio" className={`${inputClass} min-w-[280px] flex-1`} />
        <Button type="submit" loading={busy === "save"} disabled={!url.trim() || !!busy}>
          Save webhook
        </Button>
        {saved && (
          <>
            <Button type="button" variant="secondary" onClick={test} loading={busy === "test"} disabled={!!busy}>
              <Send className="h-3.5 w-3.5" /> Send test
            </Button>
            <Button type="button" variant="secondary" onClick={remove} disabled={!!busy} aria-label="Remove webhook">
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          </>
        )}
      </form>
      {saved && (
        <dl className="mt-4 space-y-1.5 text-xs text-slate-600">
          <div className="flex flex-wrap gap-2">
            <dt className="w-28 text-slate-500">Signing secret</dt>
            <dd>
              <code className="break-all rounded bg-slate-100 px-1 py-0.5 font-mono" data-testid="webhook-secret">{saved.secret}</code>
            </dd>
          </div>
          <div className="flex flex-wrap gap-2">
            <dt className="w-28 text-slate-500">Last delivery</dt>
            <dd>
              {saved.lastDelivery
                ? `${saved.lastDelivery.ok ? "delivered" : "failed"} · ${saved.lastDelivery.event} · ${formatDate(saved.lastDelivery.at)}${saved.lastDelivery.error ? ` · ${saved.lastDelivery.error}` : ""}`
                : "none yet"}
            </dd>
          </div>
        </dl>
      )}
    </Card>
  );
}
