"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Trash2, UserRound } from "lucide-react";
import { Button, Card, ErrorBanner, Field, StatusBadge, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { api, formatDate, isRefusal } from "@/lib/client";
import type { TwinJob } from "@/lib/types";

/** A twin as the server lists it: never the renderer, its look, its character, or its voice there. */
type Twin = Omit<TwinJob, "ownerId" | "provider" | "lookId" | "groupId" | "voiceId" | "imageUrl"> & { consentLinkExpired?: true };
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

/** What a twin is waiting for, in words. */
function stepOf(t: Twin): string {
  if (t.status === "completed") return "Ready: it is in your avatars";
  if (t.status === "failed") return t.error ?? "It could not be trained";
  const training = t.training === "completed" ? "Trained" : "Training from the footage (usually a few minutes)";
  const consent =
    t.consent === "accepted" ? "consent given" : t.consent === "rejected" ? `consent not accepted${t.error ? `: ${t.error}` : ""}` : t.consent === "pending" ? "waiting for the person's consent" : "consent not asked for yet";
  return `${training} · ${consent}`;
}

/**
 * Digital twins: a presenter trained from footage of a real person (HeyGen digital twin). The footage is a public link to
 * one person speaking to camera; HeyGen trains a look from it, and the person records their consent on HeyGen's page,
 * from a link the account sends them. Once both are done the twin is in the avatars, like a photo avatar.
 */
export function DigitalTwins({ canEdit, onReady }: { canEdit: boolean | null; onReady: () => void }) {
  const { data, error, setData, refetch } = useApi<{ twins: Twin[]; available: boolean }>("/api/twins");
  const twins = data?.twins ?? [];
  // While a twin is trained or waits for consent the list is asked again, only while the tab is visible; a link past its
  // day waits for a new one to be asked for.
  const following = twins.some((t) => t.status === "processing" && (t.training === "processing" || (t.consent === "pending" && !t.consentLinkExpired)));
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 10_000);
    return () => clearInterval(timer);
  }, [following, refetch]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [footageUrl, setFootageUrl] = useState("");
  const [gender, setGender] = useState<"" | "female" | "male">("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(() => newKey());
  const listRef = useRef<HTMLElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useFocusAfterRender();
  // A twin that becomes ready, fails, or has its consent refused while the page is open is announced, and a ready one
  // joins the avatars.
  const seen = useRef<Map<string, Pick<Twin, "status" | "consent">>>(new Map());
  useEffect(() => {
    if (!data) return;
    const parts: string[] = [];
    let ready = false;
    for (const t of data.twins) {
      const before = seen.current.get(t.id);
      if (before?.status === "processing" && t.status !== "processing") {
        parts.push(t.status === "completed" ? `${t.name} is ready in your avatars.` : `${t.name} could not be trained: ${t.error ?? "the renderer failed"}.`);
        ready ||= t.status === "completed";
      } else if (before && before.consent !== "rejected" && t.consent === "rejected" && t.status === "processing") {
        parts.push(`The consent for ${t.name} was not accepted${t.error ? `: ${t.error}` : ""}. Get a new consent link to record it again.`);
      }
      seen.current.set(t.id, { status: t.status, consent: t.consent });
    }
    if (ready) onReady();
    if (parts.length) setNote(parts.join(" "));
  }, [data, onReady]);
  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open]);
  const changed = () => {
    setErr(null);
    setRequestKey(newKey());
  };
  if (!data?.available && !error) return null;

  function close() {
    setOpen(false);
    focusAfterRender(() => openButton.current);
  }

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const { twin } = await api<{ twin: Twin }>("/api/twins", { method: "POST", body: JSON.stringify({ name: name.trim(), footageUrl: footageUrl.trim(), ...(gender ? { gender } : {}), agreed }), headers: { "Idempotency-Key": requestKey } });
      setData((prev) => ({ available: prev?.available ?? true, twins: [twin, ...(prev?.twins ?? []).filter((t) => t.id !== twin.id)] }));
      void refetch();
      setOpen(false);
      setName("");
      setFootageUrl("");
      setGender("");
      setAgreed(false);
      setRequestKey(newKey());
      setNote(`Training ${twin.name}. Ask the person in the footage for their consent while it trains.`);
      focusAfterRender(() => listRef.current?.querySelector<HTMLElement>(`[data-twin="${CSS.escape(twin.id)}"]`) ?? openButton.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The twin could not be started");
      // A refusal is an answer: trying again is a new start. A lost answer keeps its key, so a retry returns the same twin.
      if (isRefusal(e)) setRequestKey(newKey());
    } finally {
      setBusy(false);
    }
  }

  async function askConsent(t: Twin) {
    setErr(null);
    try {
      const { twin } = await api<{ twin: Twin }>(`/api/twins/${t.id}/consent`, { method: "POST" });
      setData((prev) => (prev ? { ...prev, twins: prev.twins.map((x) => (x.id === twin.id ? twin : x)) } : prev));
      setNote(`A consent link for ${twin.name} is ready. Send it to the person in the footage; it lasts a day.`);
      focusAfterRender(() => listRef.current?.querySelector<HTMLElement>(`[data-twin="${CSS.escape(twin.id)}"] [data-consent-link]`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The consent link could not be made");
    }
  }

  async function copy(t: Twin) {
    if (!t.consentUrl) return;
    const link = new URL(t.consentUrl, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(link);
      setNote(`The consent link for ${t.name} is copied.`);
    } catch {
      setNote(`Copy the consent link for ${t.name} from the field.`);
    }
  }

  async function forget(t: Twin) {
    const kept = t.avatarId ? " The presenter it became stays in your avatars, as does the voice it became in your voices." : " The voice HeyGen cloned from the footage is deleted.";
    if (!window.confirm(`Forget the digital twin “${t.name}”?${kept} HeyGen keeps the trained twin in its account; it is never offered to anyone else.`)) return;
    setErr(null);
    const next = twins[twins.indexOf(t) + 1] ?? twins[twins.indexOf(t) - 1];
    seen.current.delete(t.id);
    try {
      await api(`/api/twins/${t.id}`, { method: "DELETE" });
      setData((prev) => (prev ? { ...prev, twins: prev.twins.filter((x) => x.id !== t.id) } : prev));
      void refetch();
      setNote(`Forgot ${t.name}.`);
      focusAfterRender(() => (next ? listRef.current?.querySelector<HTMLElement>(`[data-twin="${CSS.escape(next.id)}"]`) : null) ?? openButton.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The twin could not be forgotten");
    }
  }

  const ready = name.trim() && /^https:\/\/\S+$/i.test(footageUrl.trim()) && agreed;
  return (
    <section ref={listRef} className="mb-6" data-testid="digital-twins">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Digital twins</h2>
        {canEdit !== false && !open && data?.available && (
          <Button ref={openButton} variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setOpen(true)}>
            <UserRound className="h-3.5 w-3.5" /> New digital twin
          </Button>
        )}
      </div>
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      <ErrorBanner message={error ?? err} />
      {open && (
        <Card className="mb-3 p-5" data-testid="twin-panel" onKeyDown={(e) => e.key === "Escape" && !busy && !e.nativeEvent.isComposing && close()}>
          <div className="flex items-start justify-between gap-3">
            <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-slate-900 outline-none">
              New digital twin
            </h3>
            <button type="button" className="text-xs text-slate-500 hover:underline" onClick={close} disabled={busy}>
              Close
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-500">A presenter trained from video of a real person, who speaks in your videos. HeyGen trains it from the footage, and the person records their consent on HeyGen&apos;s page before it can be used.</p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input className={inputClass} value={name} maxLength={80} onChange={(e) => (setName(e.target.value), changed())} placeholder="Dana Ruiz" />
            </Field>
            <Field label="Footage URL" hint="A public https link to a video of one person speaking to camera, 15 seconds to 10 minutes (about 2 minutes is best), up to 32 MB.">
              <input type="url" inputMode="url" className={inputClass} value={footageUrl} onChange={(e) => (setFootageUrl(e.target.value), changed())} placeholder="https://…/dana-footage.mp4" />
            </Field>
          </div>
          <fieldset className="mt-4">
            <legend className="mb-1.5 text-sm font-medium text-slate-700">Gender (optional)</legend>
            <div className="flex gap-4 text-sm text-slate-700">
              {(["", "female", "male"] as const).map((g) => (
                <label key={g || "none"} className="flex items-center gap-2">
                  <input type="radio" name="twin-gender" className="accent-brand-600" checked={gender === g} onChange={() => (setGender(g), changed())} />
                  {g === "" ? "Not said" : g === "female" ? "Female" : "Male"}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5 accent-brand-600" checked={agreed} onChange={(e) => (setAgreed(e.target.checked), changed())} />
            <span>The person in this footage agreed to be made into a digital twin, and will record their consent on HeyGen&apos;s page.</span>
          </label>
          <Button className="mt-4" onClick={start} loading={busy} disabled={!ready}>
            <UserRound className="h-4 w-4" /> Train the twin
          </Button>
        </Card>
      )}
      {twins.length > 0 && (
        <div className="space-y-2">
          {twins.map((t) => (
            <Card key={t.id} className="p-3 outline-none focus:ring-2 focus:ring-brand-500" data-testid="twin" data-twin={t.id} tabIndex={-1}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900">{t.name}</div>
                  <div className="mt-0.5 text-xs text-slate-500" data-testid="twin-step">
                    {stepOf(t)} · {formatDate(t.createdAt)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={t.status} />
                  {canEdit !== false && (
                    <button type="button" onClick={() => forget(t)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Forget the digital twin ${t.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              {t.status === "processing" && canEdit !== false && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {t.consentUrl && t.consent !== "rejected" ? (
                    <>
                      <input readOnly data-consent-link className={`${inputClass} min-w-0 flex-1 py-1 text-xs`} value={t.consentUrl.startsWith("/") ? `${typeof window !== "undefined" ? window.location.origin : ""}${t.consentUrl}` : t.consentUrl} aria-label={`Consent link for ${t.name}`} onFocus={(e) => e.currentTarget.select()} />
                      <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => copy(t)}>
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </Button>
                      <a href={t.consentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
                        <ExternalLink className="h-3 w-3" aria-hidden /> Open
                      </a>
                    </>
                  ) : (
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => askConsent(t)}>
                      {t.consent === "rejected" || t.consentLinkExpired ? "Get a new consent link" : "Get the consent link"}
                    </Button>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
