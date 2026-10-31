"use client";
import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { api } from "@/lib/client";
import type { Prefs } from "@/lib/types";

/** Settings section: email when a render completes or fails. */
export function EmailPrefs() {
  const { data, error, refetch } = useApi<{ prefs: Prefs | null; suggestedEmail: string | null; emailDelivers: boolean }>("/api/prefs");
  const readOnly = useCanEdit() === false; // the workspace's setting: a viewer sees it, the server refuses their changes
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (data) setEmail(data.prefs?.emailOnComplete ?? "");
  }, [data]);

  async function save(value: string) {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api("/api/prefs", { method: "PUT", body: JSON.stringify({ emailOnComplete: value || undefined }) });
      await refetch();
      setNote(value ? `Render results will be emailed to ${value}.` : "Render emails are off.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 p-5" data-testid="email-prefs">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Mail className="h-4 w-4 text-slate-400" /> Email when a render finishes
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        One message per video when it completes or fails, with a link to open it.
        {data && !data.emailDelivers && " Email sending is not configured (EMAIL_PROVIDER); messages are logged on the server instead."}
      </p>
      <ErrorBanner message={error ?? err} />
      {note && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{note}</div>}
      {readOnly && <p className="mt-3 text-xs text-slate-500" data-testid="settings-read-only">Only owners and editors can change this.</p>}
      <form
        className="mt-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save(email.trim());
        }}
      >
        <fieldset disabled={readOnly} className="contents">
        <input aria-label="Notification email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={data?.suggestedEmail ?? "you@example.com"} maxLength={200} className={`${inputClass} max-w-sm`} />
        <Button type="submit" loading={busy} disabled={!email.trim()}>
          Save
        </Button>
        {data?.prefs?.emailOnComplete && (
          <Button type="button" variant="secondary" onClick={() => save("")} disabled={busy}>
            Turn off
          </Button>
        )}
        {data?.suggestedEmail && !email && (
          <button type="button" onClick={() => setEmail(data.suggestedEmail!)} className="text-xs text-brand-700 hover:underline">
            Use {data.suggestedEmail}
          </button>
        )}
        </fieldset>
      </form>
    </Card>
  );
}
