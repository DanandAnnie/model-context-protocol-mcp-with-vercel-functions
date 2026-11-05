"use client";
import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { api } from "@/lib/client";
import { EMAIL_KINDS, type EmailKind, type Prefs } from "@/lib/types";

/** What each kind of emailed result is called in Settings. */
const KIND_LABELS: Record<EmailKind, string> = { videos: "Videos", dubs: "Dubs", twins: "Digital twins" };

/** Settings section: email when a render, dub, or digital twin completes or fails, for the kinds chosen. */
export function EmailPrefs() {
  const { data, error, refetch } = useApi<{ prefs: Prefs | null; suggestedEmail: string | null; emailDelivers: boolean }>("/api/prefs");
  const readOnly = useCanEdit() === false; // the workspace's setting: a viewer sees it, the server refuses their changes
  const [email, setEmail] = useState("");
  const [kinds, setKinds] = useState<EmailKind[]>([...EMAIL_KINDS]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setEmail(data.prefs?.emailOnComplete ?? "");
      setKinds(data.prefs?.emailKinds ?? [...EMAIL_KINDS]);
    }
  }, [data]);

  const saved = data?.prefs?.emailKinds ?? EMAIL_KINDS;
  const kindsChanged = kinds.length !== saved.length || kinds.some((k) => !saved.includes(k));

  async function save(value: string) {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api("/api/prefs", { method: "PUT", body: JSON.stringify({ emailOnComplete: value || undefined, ...(value ? { emailKinds: kinds } : {}) }) });
      await refetch();
      const names = kinds.map((k) => KIND_LABELS[k].toLowerCase());
      const which = kinds.length === EMAIL_KINDS.length ? "Results" : `Results for ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}`;
      setNote(value ? `${which} will be emailed to ${value}.` : "Result emails are off.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 p-5" data-testid="email-prefs">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Mail className="h-4 w-4 text-slate-400" /> Email when something finishes
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        One message per video, dub, or digital twin when it is ready or fails, with a link to open it, for the kinds ticked below.
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
        {/* Locked until the saved choice is loaded, so nothing typed or ticked before then is replaced by it. */}
        <fieldset disabled={readOnly || !data} className="contents">
        <input aria-label="Notification email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={data?.suggestedEmail ?? "you@example.com"} maxLength={200} className={`${inputClass} max-w-sm`} />
        <Button type="submit" loading={busy} disabled={!email.trim() || kinds.length === 0}>
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
        <div role="group" aria-labelledby="email-kinds-label" aria-describedby={kinds.length === 0 ? "email-kinds-none" : undefined} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-700">
          <span id="email-kinds-label" className="text-slate-500">Email results for</span>
          {EMAIL_KINDS.map((k) => (
            <label key={k} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={kinds.includes(k)}
                onChange={(e) => setKinds((cur) => EMAIL_KINDS.filter((x) => (x === k ? e.target.checked : cur.includes(x))))}
                className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600"
              />
              {KIND_LABELS[k]}
            </label>
          ))}
          <span role="status" className="text-red-700">
            {kinds.length === 0 && <span id="email-kinds-none" data-testid="email-kinds-none">Tick at least one kind to save.</span>}
          </span>
          {kindsChanged && kinds.length > 0 && data?.prefs?.emailOnComplete && <span className="text-slate-500">Save to apply.</span>}
        </div>
        </fieldset>
      </form>
    </Card>
  );
}
