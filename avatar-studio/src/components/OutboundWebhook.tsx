"use client";
import { useEffect, useRef, useState } from "react";
import { KeyRound, RotateCcw, Send, Trash2, Webhook } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { api, formatDate } from "@/lib/client";
import { WEBHOOK_EVENTS, type NotifySettings, type WebhookDelivery, type WebhookEvent } from "@/lib/types";

/** What each event is sent for, as Settings names it. */
const EVENT_LABELS: Record<WebhookEvent, string> = {
  "video.completed": "A render completes",
  "video.failed": "A render fails",
  "lead.captured": "A visitor leaves an email",
};

/** A logged delivery as the API lists it: the body sent stays on the server, `resendable` says whether it was kept. */
type LoggedDelivery = Omit<WebhookDelivery, "body"> & { resendable: boolean };
type Shown = Omit<NotifySettings, "deliveries"> & { deliveries?: LoggedDelivery[] };

/** How a delivery went, in a few words: "Delivered (HTTP 200)" or "Failed: Endpoint returned 500". */
function outcome(d: Pick<WebhookDelivery, "ok" | "status" | "error">): string {
  return d.ok ? `Delivered (HTTP ${d.status})` : `Failed: ${d.error ?? "no response"}`;
}

/** Settings section: one signed outbound webhook per account, fired when a render completes or fails. */
export function OutboundWebhook() {
  const { data, error, refetch } = useApi<{ webhook: Shown | null }>("/api/notifications");
  const readOnly = useCanEdit() === false; // the workspace's setting: a viewer sees it, the server refuses their changes
  const [url, setUrl] = useState("");
  // A redelivery is busy as the id of the delivery being sent again.
  const [busy, setBusy] = useState<"save" | "test" | "remove" | "rotate" | "retire" | { redeliver: string } | null>(null);
  // Whether a rotation keeps the old secret signing X-Studio-Signature-Previous for a day.
  const [keepPrevious, setKeepPrevious] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const saved = data?.webhook ?? null;

  // Filled in from the saved URL when it loads or changes, not on every refresh, so a URL being edited is kept.
  const savedUrl = saved?.url;
  useEffect(() => {
    if (savedUrl) setUrl(savedUrl);
  }, [savedUrl]);
  // The events to send, as saved (every one when none were chosen); like the URL, filled in again only when the saved choice changes.
  const savedEvents = (saved?.events ?? WEBHOOK_EVENTS).join(" ");
  const [events, setEvents] = useState<WebhookEvent[]>([...WEBHOOK_EVENTS]);
  useEffect(() => {
    setEvents(savedEvents.split(" ") as WebhookEvent[]);
  }, [savedEvents]);
  const log = useRef<HTMLUListElement>(null);

  async function save() {
    setBusy("save");
    setErr(null);
    setNote(null);
    try {
      await api("/api/notifications", { method: "PUT", body: JSON.stringify({ url, events }) });
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

  async function redeliver(d: LoggedDelivery) {
    setBusy({ redeliver: d.id });
    setErr(null);
    setNote(null);
    try {
      const { delivery } = await api<{ delivery: NonNullable<NotifySettings["lastDelivery"]> }>(`/api/notifications/deliveries/${encodeURIComponent(d.id)}/redeliver`, { method: "POST" });
      setNote(delivery.ok ? `${d.event} sent again: delivered (HTTP ${delivery.status}).` : `${d.event} sent again: failed: ${delivery.error ?? "no response"}.`);
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send the delivery again");
      await refetch().catch(() => {});
    } finally {
      setBusy(null);
      // A full log drops its oldest row for the new attempt: when the button pressed went with it, focus the newest row's.
      requestAnimationFrame(() => {
        if (!log.current?.contains(document.activeElement)) log.current?.querySelector<HTMLButtonElement>("button")?.focus();
      });
    }
  }

  async function rotate() {
    const message =
      (keepPrevious
        ? "Make a new signing secret? For the next 24 hours each delivery is also signed with the current one, in X-Studio-Signature-Previous, while you move your receiver over."
        : "Make a new signing secret? The current one stops at once: a receiver still checking it will reject deliveries until it has the new one.") +
      // Only one earlier secret signs at a time: the one before the current is dropped now.
      (saved?.previousSecretExpiresAt ? ` The previous secret, kept until ${formatDate(saved.previousSecretExpiresAt)}, stops now.` : "");
    if (!window.confirm(message)) return;
    setBusy("rotate");
    setErr(null);
    setNote(null);
    try {
      await api("/api/notifications/secret", { method: "POST", body: JSON.stringify({ keepPrevious }) });
      await refetch();
      setNote(keepPrevious ? "New signing secret made. The old one also signs deliveries for 24 hours." : "New signing secret made. The old one no longer signs deliveries.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not make a new secret");
    } finally {
      setBusy(null);
    }
  }

  async function retire() {
    if (!window.confirm("Stop signing with the previous secret now? Do this once every receiver uses the new one.")) return;
    setBusy("retire");
    setErr(null);
    setNote(null);
    try {
      await api("/api/notifications/secret", { method: "DELETE" });
      await refetch();
      setNote("The previous secret no longer signs deliveries.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not stop the previous secret");
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
        A signed <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">POST</code> is sent to your endpoint, for the events chosen below, when a render completes or fails (events <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">video.completed</code>, <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">video.failed</code>), and when a visitor leaves an email with a shared presenter or at a share page's email gate (<code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">lead.captured</code>, whose <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">source</code> is <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">presenter</code> or <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">share</code>). Verify <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">X-Studio-Signature</code> as HMAC-SHA256 of <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">{"<timestamp>.<body>"}</code> with your secret (after a rotation, accept <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">X-Studio-Signature-Previous</code> too while you move over). Private and local hosts are rejected.
      </p>
      <ErrorBanner message={error ?? err} />
      {/* Always rendered, so a screen reader announces each outcome as it is written. */}
      <div role="status" data-testid="webhook-note" className={note ? "mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700" : "sr-only"}>
        {note}
      </div>
      {readOnly && <p className="mt-3 text-xs text-slate-500" data-testid="settings-read-only">Only owners and editors can change this.</p>}
      <form
        className="mt-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset disabled={readOnly} className="contents">
        <input aria-label="Webhook URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/avatar-studio" className={`${inputClass} min-w-[280px] flex-1`} />
        <Button type="submit" loading={busy === "save"} disabled={!url.trim() || events.length === 0 || !!busy} aria-describedby={events.length === 0 ? "webhook-events-none" : undefined}>
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
        <fieldset className="mt-1 w-full">
          <legend className="text-xs font-medium text-slate-700">Send when</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {WEBHOOK_EVENTS.map((e) => (
              <label key={e} className="inline-flex items-center gap-1.5 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={events.includes(e)}
                  onChange={(ev) => setEvents((prev) => (ev.target.checked ? WEBHOOK_EVENTS.filter((x) => x === e || prev.includes(x)) : prev.filter((x) => x !== e)))}
                />
                {EVENT_LABELS[e]} <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-600">{e}</code>
              </label>
            ))}
          </div>
          {events.length === 0 ? (
            <p id="webhook-events-none" className="mt-1 text-xs text-red-700" data-testid="webhook-events-none">Choose at least one event, or remove the webhook.</p>
          ) : (
            saved && savedEvents !== events.join(" ") && <p className="mt-1 text-xs text-slate-500">Save the webhook to send these events.</p>
          )}
        </fieldset>
        </fieldset>
      </form>
      {saved && (
        <dl className="mt-4 space-y-1.5 text-xs text-slate-600">
          {/* Viewers are not sent the secret. */}
          {saved.secret && (
            <div className="flex flex-wrap gap-2">
              <dt className="w-28 text-slate-500">Signing secret</dt>
              <dd>
                <code className="break-all rounded bg-slate-100 px-1 py-0.5 font-mono" data-testid="webhook-secret">{saved.secret}</code>
                {!readOnly && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={rotate} loading={busy === "rotate"} disabled={!!busy}>
                      <KeyRound className="h-3.5 w-3.5" /> Rotate secret
                    </Button>
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-700">
                      <input type="checkbox" checked={keepPrevious} disabled={!!busy} onChange={(e) => setKeepPrevious(e.target.checked)} />
                      Keep the old secret working for 24 hours
                    </label>
                  </div>
                )}
              </dd>
            </div>
          )}
          {saved.secret && saved.previousSecretExpiresAt && (
            <div className="flex flex-wrap gap-2" data-testid="webhook-previous-secret">
              <dt className="w-28 text-slate-500">Previous secret</dt>
              <dd>
                Also signs each delivery, in <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">X-Studio-Signature-Previous</code>, until {formatDate(saved.previousSecretExpiresAt)}.
                {!readOnly && (
                  <Button type="button" variant="secondary" className="ml-2 px-2.5 py-1 text-xs" onClick={retire} loading={busy === "retire"} disabled={!!busy}>
                    Stop using it now
                  </Button>
                )}
              </dd>
            </div>
          )}
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
      {saved && (saved.deliveries?.length ?? 0) > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-slate-700">Recent deliveries</h4>
          <p className="mt-0.5 text-xs text-slate-500">
            The last {saved.deliveries!.length === 1 ? "delivery" : `${saved.deliveries!.length} deliveries`} to this URL, newest first. Each request carries its id as <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">X-Studio-Delivery</code>; one sent again keeps its body, is signed afresh, and names the original in <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">X-Studio-Redelivery-Of</code>.
          </p>
          <ul ref={log} className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="webhook-deliveries">
            {saved.deliveries!.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs" data-testid="webhook-delivery" data-delivery={d.id}>
                <span className="min-w-0">
                  <span className={d.ok ? "font-medium text-emerald-700" : "font-medium text-red-700"}>{outcome(d)}</span>
                  <span className="text-slate-600">
                    {" · "}
                    <code className="font-mono">{d.event}</code> · {formatDate(d.at)}
                    {d.redeliveryOf ? " · sent again" : ""}
                  </span>
                </span>
                {!readOnly && d.resendable && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="px-2.5 py-1 text-xs"
                    onClick={() => void redeliver(d)}
                    loading={typeof busy === "object" && busy?.redeliver === d.id}
                    disabled={!!busy && !(typeof busy === "object" && busy?.redeliver === d.id)}
                    aria-label={`Redeliver ${d.event} from ${formatDate(d.at)}`}
                    title="Send this delivery's body again, signed afresh, under a new delivery id"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Redeliver
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
