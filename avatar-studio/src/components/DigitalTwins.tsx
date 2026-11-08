"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Trash2, Upload, UserRound } from "lucide-react";
import { Button, Card, ErrorBanner, Field, StatusBadge, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { api, formatDate, isRefusal } from "@/lib/client";
import { DEMO_UPLOAD_URL, type TwinJob } from "@/lib/types";

/** A twin as the server lists it: never the renderer, its look, its character, or its voice there. */
type Twin = Omit<TwinJob, "ownerId" | "provider" | "lookId" | "groupId" | "voiceId" | "imageUrl"> & { consentLinkExpired?: true };
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

/** The largest file HeyGen takes as twin footage uploaded here (its direct upload, 200 MiB for video). */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** The video types an upload may be, by the file's own type or, where the browser gives none, its extension. */
const UPLOAD_TYPES: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
function uploadTypeOf(file: File): string | undefined {
  if (Object.values(UPLOAD_TYPES).includes(file.type)) return file.type;
  return UPLOAD_TYPES[file.name.split(".").pop()?.toLowerCase() ?? ""];
}
/** A file's size in words: "84.2 MB". */
const sizeOf = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
/** What is wrong with a file as footage, if anything. */
function fileProblem(file: File): string | null {
  if (!uploadTypeOf(file)) return "Choose an MP4, MOV, or WebM video";
  if (file.size === 0) return "That file is empty";
  if (file.size > MAX_UPLOAD_BYTES) return `That file is ${sizeOf(file.size)}; HeyGen takes up to 200 MB, so trim or compress it first`;
  return null;
}

/**
 * Sends a file to the renderer's upload link with the headers it must carry, reporting progress; `signal` stops it.
 * Rejects with a message the page can show.
 */
function putFile(url: string, headers: Record<string, string>, file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
  // The demo renderer keeps nothing: its link is not sent the file, and the progress is stood in for, at about 2 MB a
  // second (one to ten seconds in all), so a larger file takes longer as it would.
  if (url === DEMO_UPLOAD_URL) {
    const stepMs = Math.min(1000, Math.max(100, (file.size / (2 * 1024 * 1024)) * 100));
    return new Promise((resolve, reject) => {
      let step = 0;
      const timer = setInterval(() => {
        onProgress(++step / 10);
        if (step === 10) (clearInterval(timer), resolve());
      }, stepMs);
      signal.addEventListener("abort", () => (clearInterval(timer), reject(new DOMException("The upload was stopped", "AbortError"))), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`The upload was refused (${xhr.status}); try again`)));
    xhr.onerror = () => reject(new Error("The upload stopped; check the connection and try again"));
    xhr.onabort = () => reject(new DOMException("The upload was stopped", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** What a twin is waiting for, in words. */
function stepOf(t: Twin): string {
  if (t.status === "completed") return "Ready: it is in your avatars";
  if (t.status === "failed") return t.error ?? "It could not be trained";
  const training = t.training === "completed" ? "Trained" : "Training from the footage (usually a few minutes)";
  const what = t.consentVideo ? "consent video" : "consent";
  const consent =
    t.consent === "accepted"
      ? "consent given"
      : t.consent === "rejected"
        ? `${what} not accepted${t.error ? `: ${t.error}` : ""}`
        : t.consent === "pending"
          ? t.consentVideo
            ? "consent video being reviewed"
            : "waiting for the person's consent"
          : "consent not asked for yet";
  return `${training} · ${consent}`;
}

/**
 * Digital twins: a presenter trained from footage of a real person (HeyGen digital twin). The footage is a public link to
 * one person speaking to camera; HeyGen trains a look from it, and the person records their consent on HeyGen's page,
 * from a link the account sends them. Once both are done the twin is in the avatars, like a photo avatar.
 */
export function DigitalTwins({ canEdit, onReady }: { canEdit: boolean | null; onReady: () => void }) {
  const { data, error, setData, refetch } = useApi<{ twins: Twin[]; available: boolean; uploads?: boolean; consentUploads?: boolean }>("/api/twins");
  const twins = data?.twins ?? [];
  // While a twin is trained or waits for consent the list is asked again, only while the tab is visible. A consent whose
  // link is past its day may still be under review, so it is asked about too, once a minute.
  const following = twins.some((t) => t.status === "processing" && (t.training === "processing" || (t.consent === "pending" && !t.consentLinkExpired)));
  const reviewing = twins.some((t) => t.status === "processing" && t.consent === "pending");
  useEffect(() => {
    if (!following && !reviewing) return;
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") void refetch();
      },
      following ? 10_000 : 60_000,
    );
    return () => clearInterval(timer);
  }, [following, reviewing, refetch]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [footageUrl, setFootageUrl] = useState("");
  /** Where the footage comes from: a public link, or a file from this computer (where the renderer takes uploads). */
  const [source, setSource] = useState<"link" | "file">("link");
  const [file, setFile] = useState<File | null>(null);
  /** The file already sent to the renderer, with its token, so a start that fails after it does not send it again. */
  const [sent, setSent] = useState<{ file: File; token: string; expiresAt: string } | null>(null);
  /** How much of the file is sent (0 to 1) while it uploads. */
  const [progress, setProgress] = useState<number | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  /** The twin whose recorded consent video is being sent, and how much of it is sent (null before the file goes). */
  const [consentSend, setConsentSend] = useState<{ twin: string; progress: number | null } | null>(null);
  const consentAbort = useRef<AbortController | null>(null);
  const [uploadKey, setUploadKey] = useState(() => newKey());
  const trainButton = useRef<HTMLButtonElement>(null);
  // An upload still running when the panel goes (another page opened, say) is stopped, and no twin is started from it.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      uploadAbort.current?.abort();
      consentAbort.current?.abort();
    };
  }, []);
  const [gender, setGender] = useState<"" | "female" | "male">("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  /** Where the keyboard last was in the section, and in which twin's card, to put it back when that row goes. */
  const lastFocus = useRef<{ el: Element; twin: string | null } | null>(null);
  /** Says `text`, even when it is what was said last (a second copy, say): cleared first, then set. */
  const say = (text: string) => {
    setNote(null);
    requestAnimationFrame(() => setNote(text));
  };
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
    const settled: string[] = [];
    for (const t of data.twins) {
      const before = seen.current.get(t.id);
      if (before?.status === "processing" && t.status !== "processing") {
        parts.push(t.status === "completed" ? `${t.name} is ready in your avatars.` : `${t.name} could not be trained: ${t.error ?? "the renderer failed"}.`);
        ready ||= t.status === "completed";
        settled.push(t.id);
      } else if (before && before.consent !== "rejected" && t.consent === "rejected" && t.status === "processing") {
        parts.push(`The consent for ${t.name} was not accepted${t.error ? `: ${t.error}` : ""}. Get a new consent link to record it again.`);
      }
      seen.current.set(t.id, { status: t.status, consent: t.consent });
    }
    if (ready) onReady();
    if (parts.length) setNote(parts.join(" "));
    // Its consent row is gone with it: a keyboard user who was in that row is taken to the twin rather than to the
    // page. Anyone whose focus was elsewhere, or nowhere (scrolling with the mouse, say), is left where they are.
    const last = lastFocus.current;
    if (last?.twin && settled.includes(last.twin) && !last.el.isConnected && (document.activeElement === document.body || !document.activeElement)) {
      const id = last.twin;
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-twin="${CSS.escape(id)}"]`)?.focus());
    }
  }, [data, onReady]);
  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open]);
  const changed = () => {
    setErr(null);
    setRequestKey(newKey());
  };
  /** Another file, or none: a new upload, under a new key. */
  const chooseFile = (f: File | null) => {
    setFile(f);
    setUploadKey(newKey());
    changed();
  };
  if (!data?.available && !error) return null;

  function close() {
    // The file input is empty when the panel opens again, so the file chosen goes with it.
    setFile(null);
    setSent(null);
    setOpen(false);
    focusAfterRender(() => openButton.current);
  }

  /** Sends the chosen file to the renderer (once: a file already sent is not sent again) and returns its token. */
  async function upload(f: File): Promise<string> {
    if (sent?.file === f && Date.parse(sent.expiresAt) - Date.now() > 60_000) return sent.token;
    const { upload: u } = await api<{ upload: { token: string; url: string; headers: Record<string, string>; expiresAt: string } }>("/api/twins/uploads", {
      method: "POST",
      body: JSON.stringify({ fileName: f.name.slice(0, 200), contentType: uploadTypeOf(f), sizeBytes: f.size }),
      headers: { "Idempotency-Key": uploadKey },
    });
    // The key only replays a lost answer: once answered, the next upload (another file, or this one again) is new.
    setUploadKey(newKey());
    if (!alive.current) throw new DOMException("The upload was stopped", "AbortError");
    const abort = new AbortController();
    uploadAbort.current = abort;
    setProgress(0);
    try {
      await putFile(u.url, u.headers, f, setProgress, abort.signal);
    } finally {
      uploadAbort.current = null;
      setProgress(null);
    }
    setSent({ file: f, token: u.token, expiresAt: u.expiresAt });
    return u.token;
  }

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const footage = source === "file" && file ? { upload: await upload(file) } : { footageUrl: footageUrl.trim() };
      const { twin } = await api<{ twin: Twin }>("/api/twins", { method: "POST", body: JSON.stringify({ name: name.trim(), ...footage, ...(gender ? { gender } : {}), agreed }), headers: { "Idempotency-Key": requestKey } });
      setData((prev) => ({ available: prev?.available ?? true, twins: [twin, ...(prev?.twins ?? []).filter((t) => t.id !== twin.id)] }));
      void refetch();
      setOpen(false);
      setName("");
      setFootageUrl("");
      setFile(null);
      setSent(null);
      setGender("");
      setAgreed(false);
      setRequestKey(newKey());
      setNote(`Training ${twin.name}. Ask the person in the footage for their consent while it trains.`);
      focusAfterRender(() => listRef.current?.querySelector<HTMLElement>(`[data-twin="${CSS.escape(twin.id)}"]`) ?? openButton.current);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        say("The upload was stopped.");
        focusAfterRender(() => trainButton.current);
        return;
      }
      setErr(e instanceof Error ? e.message : "The twin could not be started");
      // The server asks for the file again when the upload it was sent is not usable (not received, gone, expired).
      if (isRefusal(e) && e instanceof Error && /upload/i.test(e.message)) setSent(null);
      // A refusal is an answer: trying again is a new start. A lost answer keeps its key, so a retry returns the same twin.
      if (isRefusal(e)) setRequestKey(newKey());
    } finally {
      setBusy(false);
    }
  }

  async function askConsent(t: Twin) {
    if (asking === t.id) return;
    setAsking(t.id);
    setErr(null);
    try {
      const { twin } = await api<{ twin: Twin }>(`/api/twins/${t.id}/consent`, { method: "POST" });
      setData((prev) => (prev ? { ...prev, twins: prev.twins.map((x) => (x.id === twin.id ? twin : x)) } : prev));
      setNote(`A consent link for ${twin.name} is ready. Send it to the person in the footage; it lasts a day.`);
      focusAfterRender(() => listRef.current?.querySelector<HTMLElement>(`[data-twin="${CSS.escape(twin.id)}"] [data-consent-link]`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The consent link could not be made");
    } finally {
      setAsking(null);
    }
  }

  /**
   * Sends a recorded consent video for a twin in place of the link (where the operator turned it on): the file goes to
   * the renderer as footage does, then is submitted for review. The row says when it is accepted or refused.
   */
  async function sendConsentVideo(t: Twin, f: File) {
    if (consentSend) return;
    const wrong = fileProblem(f);
    if (wrong) {
      setErr(`Consent video: ${wrong.charAt(0).toLowerCase()}${wrong.slice(1)}.`);
      return;
    }
    setErr(null);
    setConsentSend({ twin: t.id, progress: null });
    // The chosen file's input goes with the choice, so the keyboard is kept on the twin rather than dropped on the page.
    focusAfterRender(() => rowOf(t.id));
    const abort = new AbortController();
    consentAbort.current = abort;
    try {
      const { upload: u } = await api<{ upload: { token: string; url: string; headers: Record<string, string> } }>("/api/twins/uploads", {
        method: "POST",
        body: JSON.stringify({ fileName: f.name.slice(0, 200), contentType: uploadTypeOf(f), sizeBytes: f.size, purpose: "consent", twinId: t.id }),
        headers: { "Idempotency-Key": newKey() },
      });
      if (abort.signal.aborted || !alive.current) throw new DOMException("The upload was stopped", "AbortError");
      setConsentSend({ twin: t.id, progress: 0 });
      // The file input went with the choice; the keyboard waits on Stop upload while the file is sent.
      focusAfterRender(() => rowOf(t.id)?.querySelector<HTMLElement>("[data-consent-stop]") ?? rowOf(t.id));
      await putFile(u.url, u.headers, f, (p) => setConsentSend({ twin: t.id, progress: p }), abort.signal);
      setConsentSend({ twin: t.id, progress: null });
      focusAfterRender(() => rowOf(t.id));
      const { twin } = await api<{ twin: Twin }>(`/api/twins/${t.id}/consent`, { method: "POST", body: JSON.stringify({ upload: u.token }) });
      setData((prev) => (prev ? { ...prev, twins: prev.twins.map((x) => (x.id === twin.id ? twin : x)) } : prev));
      void refetch();
      say(`The consent video for ${twin.name} is sent. HeyGen reviews it; this row says when it is accepted.`);
      focusAfterRender(() => rowOf(twin.id));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        if (alive.current) say("The consent video upload was stopped.");
      } else {
        setErr(e instanceof Error ? e.message : "The consent video could not be sent");
        // A twin that changed meanwhile (a video sent from another tab, say) is shown as it is now, before the keyboard
        // is placed, so it is not left on a control the new state takes away.
        if (isRefusal(e)) await refetch().catch(() => undefined);
      }
      // Back on the file input to choose again, or on the twin when the input is gone (a video now under review, say).
      focusAfterRender(() => rowOf(t.id)?.querySelector<HTMLElement>("[data-consent-file]") ?? rowOf(t.id));
    } finally {
      if (consentAbort.current === abort) consentAbort.current = null;
      if (alive.current) setConsentSend(null);
    }
  }

  /** A twin's row in the list, if it is still shown. */
  function rowOf(id: string): HTMLElement | null {
    return listRef.current?.querySelector<HTMLElement>(`[data-twin="${CSS.escape(id)}"]`) ?? null;
  }

  async function copy(t: Twin) {
    if (!t.consentUrl) return;
    const link = new URL(t.consentUrl, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(link);
      say(`The consent link for ${t.name} is copied.`);
    } catch {
      say(`Copy the consent link for ${t.name} from the field.`);
    }
  }

  async function forget(t: Twin) {
    const kept = t.avatarId ? " The presenter it became stays in your avatars, and a voice it became stays in your voices." : "";
    if (!window.confirm(`Forget the digital twin “${t.name}”?${kept} A voice HeyGen cloned from the footage that is not one of your voices is deleted. HeyGen keeps the trained twin in its account; it is never offered to anyone else.`)) return;
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

  const problem = source === "file" ? (file ? fileProblem(file) : "Choose a video file of the footage to train it") : /^https:\/\/\S+$/i.test(footageUrl.trim()) ? null : "Paste a public https link to the footage to train it";
  const ready = name.trim() && !problem && agreed;
  return (
    <section
      ref={listRef}
      className="mb-6"
      data-testid="digital-twins"
      onFocusCapture={(e) => {
        lastFocus.current = { el: e.target, twin: e.target.closest("[data-twin]")?.getAttribute("data-twin") ?? null };
      }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Digital twins</h2>
        {canEdit === true && !open && data?.available && (
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
              <input className={inputClass} value={name} maxLength={80} disabled={busy} onChange={(e) => (setName(e.target.value), changed())} placeholder="Dana Ruiz" />
            </Field>
          </div>
          {data?.uploads && (
            <fieldset className="mt-4">
              <legend className="mb-1.5 text-sm font-medium text-slate-700">Footage from</legend>
              <div className="flex flex-wrap gap-4 text-sm text-slate-700">
                {(["link", "file"] as const).map((v) => (
                  <label key={v} className="flex items-center gap-2">
                    <input type="radio" name="twin-source" className="accent-brand-600" checked={source === v} disabled={busy} onChange={() => (setSource(v), chooseFile(null))} />
                    {v === "link" ? "A public link" : "A file from this computer"}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="mt-4">
            {source === "link" ? (
              <Field label="Footage URL" hint="A public https link to a video of one person speaking to camera, 15 seconds to 10 minutes (about 2 minutes is best), up to 32 MB.">
                <input type="url" inputMode="url" className={inputClass} value={footageUrl} disabled={busy} onChange={(e) => (setFootageUrl(e.target.value), changed())} placeholder="https://…/dana-footage.mp4" />
              </Field>
            ) : (
              <Field label="Footage file" hint="An MP4, MOV, or WebM video of one person speaking to camera, 15 seconds to 10 minutes (about 2 minutes is best), up to 200 MB. It goes straight to HeyGen, not through the studio.">
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm"
                  className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                  disabled={busy}
                  onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                />
              </Field>
            )}
          </div>
          {source === "file" && file && (
            <p className="mt-2 text-xs text-slate-500" data-testid="twin-file">
              {file.name} · {sizeOf(file.size)}
              {sent?.file === file ? " · uploaded" : ""}
            </p>
          )}
          {progress !== null && (
            <div className="mt-3 flex items-center gap-3">
              <div role="progressbar" aria-label="Uploading the footage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span className="w-10 text-right text-xs tabular-nums text-slate-600">{Math.round(progress * 100)}%</span>
              <button type="button" className="text-xs font-medium text-slate-600 hover:underline" onClick={() => uploadAbort.current?.abort()}>
                Stop upload
              </button>
            </div>
          )}
          <fieldset className="mt-4">
            <legend className="mb-1.5 text-sm font-medium text-slate-700">Gender (optional)</legend>
            <div className="flex gap-4 text-sm text-slate-700">
              {(["", "female", "male"] as const).map((g) => (
                <label key={g || "none"} className="flex items-center gap-2">
                  <input type="radio" name="twin-gender" className="accent-brand-600" checked={gender === g} disabled={busy} onChange={() => (setGender(g), changed())} />
                  {g === "" ? "Not said" : g === "female" ? "Female" : "Male"}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5 accent-brand-600" checked={agreed} disabled={busy} onChange={(e) => (setAgreed(e.target.checked), changed())} />
            <span>The person in this footage agreed to be made into a digital twin, and will record their consent on HeyGen&apos;s page.</span>
          </label>
          <Button ref={trainButton} className="mt-4" onClick={start} loading={busy} disabled={!ready} aria-describedby={ready ? undefined : "twin-missing"}>
            {source === "file" && sent?.file !== file ? <Upload className="h-4 w-4" /> : <UserRound className="h-4 w-4" />} {source === "file" && sent?.file !== file ? "Upload and train the twin" : "Train the twin"}
          </Button>
          {!ready && (
            <p id="twin-missing" className="mt-2 text-xs text-slate-500">
              {!name.trim() ? "Give the twin a name to train it." : problem ? `${problem}.` : "Confirm that the person in the footage agreed to train it."}
            </p>
          )}
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
                  {canEdit === true && (
                    <button type="button" onClick={() => forget(t)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Forget the digital twin ${t.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              {t.status === "processing" && canEdit === true && t.consentVideo && t.consent === "pending" && (
                <p className="mt-2 text-xs text-slate-600" data-testid="twin-consent-video">
                  Consent video sent: {t.consentVideo.name} · {sizeOf(t.consentVideo.sizeBytes)} · {formatDate(t.consentVideo.at)}. HeyGen reviews it, usually within a day.
                </p>
              )}
              {t.status === "processing" && canEdit === true && !(t.consentVideo && t.consent === "pending") && t.consent !== "accepted" && (
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
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => askConsent(t)} loading={asking === t.id} disabled={consentSend?.twin === t.id}>
                      {t.consent === "rejected" || t.consentLinkExpired ? "Get a new consent link" : "Get the consent link"}
                    </Button>
                  )}
                  {data?.consentUploads && consentSend?.twin !== t.id && (
                    <label
                      className={`inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 focus-within:ring-2 focus-within:ring-brand-500 hover:bg-slate-50 ${consentSend || asking === t.id ? "pointer-events-none opacity-60" : ""}`}
                    >
                      <Upload className="h-3.5 w-3.5" aria-hidden /> {t.consent === "rejected" && t.consentVideo ? "Upload another consent video" : "Upload a consent video"}
                      <input
                        type="file"
                        data-consent-file
                        accept="video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm"
                        className="sr-only"
                        disabled={!!consentSend || asking === t.id}
                        aria-label={`Upload a recorded consent video for ${t.name}`}
                        aria-describedby={`consent-hint-${t.id}`}
                        onChange={(e) => {
                          const f = e.currentTarget.files?.[0];
                          e.currentTarget.value = "";
                          if (f) void sendConsentVideo(t, f);
                        }}
                      />
                    </label>
                  )}
                  {consentSend?.twin === t.id && (
                    <div className="flex min-w-48 flex-1 items-center gap-3" data-testid="twin-consent-sending">
                      {consentSend.progress === null ? (
                        <span className="text-xs text-slate-600" role="status">
                          Sending the consent video…
                        </span>
                      ) : (
                        <>
                          <div role="progressbar" aria-label={`Uploading the consent video for ${t.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(consentSend.progress * 100)} className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${Math.round(consentSend.progress * 100)}%` }} />
                          </div>
                          <span className="w-10 text-right text-xs tabular-nums text-slate-600">{Math.round(consentSend.progress * 100)}%</span>
                          <button type="button" data-consent-stop className="text-xs font-medium text-slate-600 hover:underline" onClick={() => consentAbort.current?.abort()}>
                            Stop upload
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {t.status === "processing" && canEdit === true && data?.consentUploads && !(t.consentVideo && t.consent === "pending") && t.consent !== "accepted" && (
                <p id={`consent-hint-${t.id}`} className="mt-1 text-xs text-slate-500">Or upload a video of the person reading HeyGen&apos;s consent statement to camera, in place of the link (MP4, MOV, or WebM, up to 200 MB).</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
