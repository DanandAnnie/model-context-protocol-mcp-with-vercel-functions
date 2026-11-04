"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Copy, Layers3, QrCode, RotateCcw, Upload } from "lucide-react";
import { Button, Card, ErrorBanner, Field, SectionTitle, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { BATCH_NOTHING_TO_SEND, api, formatDate } from "@/lib/client";
import type { BatchSummary } from "@/lib/services/batches";
import { decodeScript, legacyEncodingFor } from "@/lib/script-import";
import { restoredCaptionStyle } from "@/lib/caption-style";
import { MAX_RETRY_AT_ONCE, VOICE_EMOTIONS, isDefaultCaptionStyle, rendersOnAvatarV, type AspectRatio, type Avatar, type Background, type BrandKit, type CaptionStyle, type PhotoExpressiveness, type VoiceAccent, type AvatarEngine, type Resolution, type Voice, type VideoTemplate, type VoiceEmotion } from "@/lib/types";

const MAX_BATCH_SCRIPT = 5000;

const SAMPLE_CSV = `name,property,move_in
Jordan,12 Elm Street,November 1
Priya,48 Harbor View,November 15`;
const SAMPLE_TEMPLATE = "Hi {name}, welcome to {property}! Your move-in date is {move_in}. Rent is due on the first and you can pay it in the portal. We're glad you're here.";

interface Preview {
  columns: string[];
  rowCount: number;
  missing: string[];
  /** Rows whose filled-in script is empty or too long, in words. */
  problem?: string | null;
  samples: Array<{ label: string; script: string }>;
}

/** The brand kit's caption style as this build reads it, or none when the kit has none (or only the default). */
function kitCaptionStyle(kit: BrandKit | null | undefined): CaptionStyle | undefined {
  if (!kit?.captionStyle) return undefined;
  const style = restoredCaptionStyle(kit.captionStyle);
  return isDefaultCaptionStyle(style) ? undefined : style;
}

export default function BatchPage() {
  const canEdit = useCanEdit();
  const router = useRouter();
  const { data: avatarData } = useApi<{ avatars: Avatar[] }>("/api/avatars");
  const { data: voiceData } = useApi<{ voices: Voice[] }>("/api/voices");
  const [title, setTitle] = useState("Welcome video");
  const [template, setTemplate] = useState(SAMPLE_TEMPLATE);
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [avatarId, setAvatarId] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [captions, setCaptions] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pitch, setPitch] = useState(0);
  const [emotion, setEmotion] = useState<VoiceEmotion | "">("");
  // Set by a saved template (and the caption style by the brand kit too): the batch API takes them, the page has no
  // controls of its own for them.
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle | undefined>();
  const [background, setBackground] = useState<Background | undefined>();
  const [carried, setCarried] = useState<{ expressiveness?: PhotoExpressiveness; motionPrompt?: string; accent?: VoiceAccent; avatarEngine?: AvatarEngine; moreBlinking?: true; transparent?: true }>({});
  const [startedFrom, setStartedFrom] = useState("");
  // A template's presenter and voice, held until both lists have loaded (a template can be picked first).
  // Each holds the ids to try in order: the first scene's own, then the template's.
  const [cast, setCast] = useState<{ avatarIds: string[]; voiceIds: string[] } | null>(null);
  const { data: templateData } = useApi<{ templates: VideoTemplate[] }>("/api/templates");
  // Where the focus goes when a carried setting's notice (and the button on it) is taken away.
  const templateSelect = useRef<HTMLSelectElement>(null);
  const [carriedNote, setCarriedNote] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A fresh batch starts from the brand kit, as the editor does: its presenter and voice (or the presenter's own
  // voice), format, quality, and captions; the server gives the rows the kit's background. A saved template wins.
  // Without a kit (or when it cannot be read) the first presenter and voice in the lists.
  const { data: brandData, error: brandError } = useApi<{ brand: BrandKit | null }>("/api/brand");
  // Batches made before, newest first, to find one's videos again or send its links; asked again while renders are
  // being made, so the counts move as they finish.
  const { data: batchData, refetch: refetchBatches } = useApi<{ batches: BatchSummary[] }>("/api/videos/batch", { pollMs: 8000, pollWhile: (d) => d.batches.some((b) => b.making > 0) });
  // One action at a time across the list (Retry failed, Copy links, QR codes), since they share the note under a batch.
  const [batchBusy, setBatchBusy] = useState<{ batchId: string; action: "retry" | "copy" | "qr" } | null>(null);
  const retrying = batchBusy?.action === "retry" ? batchBusy.batchId : null;
  const busyWith = (batchId: string, action: "retry" | "copy" | "qr") => batchBusy?.batchId === batchId && batchBusy.action === action;
  /** What the last Retry failed, Copy links, or QR codes did, said under that batch. */
  const [batchNote, setBatchNote] = useState<{ batchId: string; text: string; error?: boolean } | null>(null);
  const focusNote = useRef<string | null>(null);
  const brandApplied = useRef(false);
  // Settings changed by hand before the kit arrived keep the hand's choice.
  const touched = useRef(new Set<"aspect" | "resolution" | "captions">());
  useEffect(() => {
    if (brandApplied.current || !avatarData || !voiceData || (!brandData && !brandError)) return;
    brandApplied.current = true;
    const b = brandData?.brand ?? null;
    const a = (b?.defaultAvatarId ? avatarData.avatars.find((x) => x.id === b.defaultAvatarId) : undefined) ?? avatarData.avatars[0];
    const v = [b?.defaultVoiceId, a?.defaultVoiceId].map((id) => (id ? voiceData.voices.find((x) => x.id === id) : undefined)).find(Boolean) ?? voiceData.voices[0];
    // A saved template picked before the lists loaded applies its own cast right after this (the kit's presenter
    // and voice stay as the fallback for a template whose own are gone), and brings its own format and quality.
    setAvatarId((prev) => prev || a?.id || "");
    setVoiceId((prev) => prev || v?.id || "");
    if (!b || startedFrom) return;
    if (b.defaultAspect && !touched.current.has("aspect")) setAspect(b.defaultAspect);
    if (b.defaultResolution && !touched.current.has("resolution")) setResolution(b.defaultResolution);
    if (b.captionsByDefault != null && !touched.current.has("captions")) setCaptions(b.captionsByDefault);
    // A template brings its own caption style; otherwise the rows are captioned in the kit's.
    setCaptionStyle((prev) => prev ?? kitCaptionStyle(b));
  }, [brandData, brandError, avatarData, voiceData, startedFrom]);
  /** Start a batch's failed renders again with the same settings, up to the most one request takes, and say what happened. */
  async function retryBatch(b: BatchSummary) {
    const ids = b.failedIds.slice(0, MAX_RETRY_AT_ONCE);
    if (!ids.length || batchBusy) return;
    const over = b.failedIds.length - ids.length;
    const what = ids.length === 1 ? "1 failed render" : `${ids.length} failed renders`;
    if (!window.confirm(`Start ${what} of “${b.title}” again with the same settings?${over ? ` Only the first ${MAX_RETRY_AT_ONCE} are started now; retry again for the other ${over}.` : ""} Each counts toward this month's renders.`)) return;
    setBatchBusy({ batchId: b.batchId, action: "retry" });
    setBatchNote(null);
    try {
      const r = await api<{ started: Array<{ from: string; id: string }>; failedAgain: Array<{ from: string; id?: string; reason: string }>; skipped: Array<{ id: string; code: string }>; missing: string[] }>("/api/videos/retry", { method: "POST", body: JSON.stringify({ ids }) });
      const n = (k: number, one: string, many: string) => (k === 1 ? one : many.replace("#", String(k)));
      const allowance = r.skipped.filter((x) => x.code === "allowance").length;
      const notes: string[] = [];
      notes.push(r.started.length ? `${n(r.started.length, "1 render was", "# renders were")} started again.` : "No render was started again.");
      if (allowance) notes.push(`${n(allowance, "1 was", "# were")} not started: this month's render allowance is used up.`);
      if (r.failedAgain.length) {
        const reason = r.failedAgain[0].reason.replace(/\.$/, "");
        notes.push(r.failedAgain.length === 1 ? `1 could not be started again: ${reason}.` : `${r.failedAgain.length} could not be started again (the first: ${reason}).`);
      }
      // Started again (by a teammate, say), trashed, or deleted since the list was read: the refreshed counts say where they are.
      const gone = r.skipped.length - allowance + r.missing.length;
      if (gone) notes.push(`${n(gone, "1 render was", "# renders were")} already started again or no longer failed.`);
      // Past the allowance a second click starts nothing either, so only the cap's leftovers are pointed at.
      if (over && !allowance) notes.push(`${over} more failed ${over === 1 ? "render was" : "renders were"} left for the next retry, as one retry starts up to ${MAX_RETRY_AT_ONCE}.`);
      // Nothing started only reads as a problem when something stood in the way; renders already restarted are not one.
      setBatchNote({ batchId: b.batchId, text: notes.join(" "), error: !r.started.length && (allowance > 0 || r.failedAgain.length > 0) });
    } catch (e) {
      setBatchNote({ batchId: b.batchId, text: e instanceof Error ? e.message : "Could not start the renders again", error: true });
    } finally {
      // Some may have started before a request failed; the list shows them, so the next click does not start them twice.
      // The button goes once the batch has no failed render left, so focus is held for the note (moved there below).
      focusNote.current = b.batchId;
      await refetchBatches();
      setBatchBusy(null);
    }
  }
  // After a retry, a batch left with no failed render has lost its button; its note, which says what happened, takes focus.
  useEffect(() => {
    const id = focusNote.current;
    if (!id || retrying) return;
    focusNote.current = null;
    if (batchData?.batches.find((x) => x.batchId === id)?.failed) return;
    document.getElementById(`batch-note-${id}`)?.focus();
  }, [batchData, retrying]);
  /** Put a batch's links that can be sent now on the clipboard, one a line in the CSV's order, and say how many were left out. */
  async function copyBatchLinks(b: BatchSummary) {
    if (batchBusy) return;
    setBatchBusy({ batchId: b.batchId, action: "copy" });
    setBatchNote(null);
    const counts = { links: 0, unsendable: 0 };
    // Fetched inside the clipboard write rather than before it, so a browser that only lets a click copy at once (Safari)
    // still counts the copy as the click's, as the library's Copy links does.
    const text = fetch(`/api/videos/batch/${encodeURIComponent(b.batchId)}?format=text`)
      .catch(() => {
        throw new Error("Could not reach the server to copy the links");
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not copy the links");
        counts.links = Number(res.headers.get("X-Links") ?? 0);
        counts.unsendable = Number(res.headers.get("X-Unsendable") ?? 0);
        if (!counts.links) throw new Error(BATCH_NOTHING_TO_SEND);
        return res.text();
      });
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
        // The item may be refused before it reads the text; the failure is reported from `text` below.
        blob.catch(() => {});
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      const left = counts.unsendable ? `; left out: ${counts.unsendable} ${counts.unsendable === 1 ? "has" : "have"} no link that can be sent yet` : "";
      setBatchNote({ batchId: b.batchId, text: `Copied ${counts.links} ${counts.links === 1 ? "link" : "links"}${left}.` });
    } catch {
      // The server's answer says what went wrong if it was the problem; otherwise the browser refused the copy.
      const failed = await text.then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : "Could not copy the links"),
      );
      setBatchNote({ batchId: b.batchId, text: failed ?? "The browser did not let the page copy to the clipboard; Download links gives the same links as a file.", error: true });
    } finally {
      setBatchBusy(null);
    }
  }
  /** Save a zip of a QR code for each of a batch's links that can be sent now, for printing, and say how many were left out. */
  async function saveBatchQr(b: BatchSummary) {
    if (batchBusy) return;
    setBatchBusy({ batchId: b.batchId, action: "qr" });
    setBatchNote(null);
    try {
      const res = await fetch(`/api/videos/batch/${encodeURIComponent(b.batchId)}?format=qr`).catch(() => {
        throw new Error("Could not reach the server to save the QR codes");
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save the QR codes");
      const links = Number(res.headers.get("X-Links") ?? 0);
      const unsendable = Number(res.headers.get("X-Unsendable") ?? 0);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "qr-codes.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const left = unsendable ? `; left out: ${unsendable} ${unsendable === 1 ? "has" : "have"} no link that can be sent yet` : "";
      setBatchNote({ batchId: b.batchId, text: `Saved ${links} QR ${links === 1 ? "code" : "codes"}${left}.` });
    } catch (e) {
      setBatchNote({ batchId: b.batchId, text: e instanceof Error ? e.message : "Could not save the QR codes", error: true });
    } finally {
      setBatchBusy(null);
    }
  }
  /** A presenter picked by hand brings its own voice, when it has one. */
  function pickAvatar(id: string) {
    setAvatarId(id);
    const own = avatarData?.avatars.find((x) => x.id === id)?.defaultVoiceId;
    if (own && voiceData?.voices.some((v) => v.id === own)) setVoiceId(own);
  }

  // Apply a template's presenter and voice once both lists are in, like the editor's copy prefill:
  // a voice that is gone gives way to the presenter's own default, a presenter that is gone keeps the choice.
  useEffect(() => {
    if (!cast || !avatarData || !voiceData) return;
    // A scene presenter that is gone gives way to the template's, as the editor does.
    const a = cast.avatarIds.map((id) => avatarData.avatars.find((x) => x.id === id)).find(Boolean);
    const v = cast.voiceIds.map((id) => voiceData.voices.find((x) => x.id === id)).find(Boolean) ?? (a?.defaultVoiceId ? voiceData.voices.find((x) => x.id === a.defaultVoiceId) : undefined);
    if (a) setAvatarId(a.id);
    if (v) setVoiceId(v.id);
    setCast(null);
  }, [cast, avatarData, voiceData]);

  // Live preview, debounced.
  useEffect(() => {
    const t = setTimeout(() => {
      api<Preview>("/api/videos/batch", { method: "PUT", body: JSON.stringify({ scriptTemplate: template, csv }) })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [template, csv]);

  // A saved template brings its script (scenes joined, one paragraph each) and every setting the batch takes.
  function startFrom(id: string) {
    setStartedFrom(id);
    setErr(null);
    setCarriedNote("");
    const t = templateData?.templates.find((x) => x.id === id);
    if (!t) {
      // "None": drop the settings the page has no controls for, so they do not ride along unseen; the brand kit's
      // caption style is where the rows start again.
      setCaptionStyle(kitCaptionStyle(brandData?.brand));
      setBackground(undefined);
      setCarried({});
      setCast(null);
      return;
    }
    const script = t.scenes.map((sc) => sc.script.trim()).filter(Boolean).join("\n\n");
    setTemplate(script);
    // The first scene's own presenter and voice lead, as they do in the editor; every row uses one cast.
    const first = t.scenes[0];
    const ids = (...xs: Array<string | undefined>) => xs.filter((x): x is string => !!x);
    setCast({ avatarIds: ids(first?.avatarId, t.avatarId), voiceIds: ids(first?.voiceId, t.voiceId) });
    setAspect(t.aspect);
    setResolution(t.resolution ?? "1080p");
    setCaptions(t.captions);
    setCaptionStyle(t.captionStyle);
    setSpeed(t.speed);
    setPitch(t.pitch ?? 0);
    setEmotion(t.emotion ?? "");
    setBackground(t.scenes[0]?.background);
    setCarried({ ...(t.expressiveness ? { expressiveness: t.expressiveness } : {}), ...(t.motionPrompt ? { motionPrompt: t.motionPrompt } : {}), ...(t.accent ? { accent: t.accent } : {}), ...(t.avatarEngine ? { avatarEngine: t.avatarEngine } : {}), ...(t.avatarEngine && t.moreBlinking ? { moreBlinking: true as const } : {}), ...(t.transparent ? { transparent: true as const } : {}) });
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    // Spreadsheets often save CSV in the system's legacy encoding (Excel's "CSV" is Windows-1252 in the West).
    file.arrayBuffer().then((buf) => setCsv(decodeScript(new Uint8Array(buf), legacyEncodingFor(navigator.language))));
  }

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      const result = await api<{ batchId: string; videos: unknown[]; skipped: Array<{ row: number; reason: string }>; failed: Array<{ row: number; reason: string }> }>("/api/videos/batch", {
        method: "POST",
        body: JSON.stringify({ title, scriptTemplate: template, csv, avatarId, voiceId, aspect, resolution, captions, ...(captions && captionStyle ? { captionStyle } : {}), speed, ...(pitch ? { pitch } : {}), ...(emotion ? { emotion } : {}), ...(background ? { background } : {}), ...carried }),
      });
      const note = `${result.skipped.length ? `&skipped=${result.skipped.length}` : ""}${result.failed.length ? `&failed=${result.failed.length}` : ""}`;
      router.push(`/videos?batch=${result.batchId}${note}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the batch");
      setBusy(false);
    }
  }

  const chosenAvatar = avatarData?.avatars.find((a) => a.id === avatarId);
  const ready = !!preview && preview.rowCount > 0 && preview.missing.length === 0 && !preview.problem && !!avatarId && !!voiceId && title.trim().length > 0;

  return (
    <>
      <SectionTitle
        title="Personalize at scale"
        subtitle="One script, many recipients. Each CSV row becomes its own video with {column} placeholders filled in."
        action={
          <Button onClick={generate} disabled={!ready || busy || canEdit === false} loading={busy}>
            <Layers3 className="h-4 w-4" /> Generate {preview?.rowCount ? `${preview.rowCount} videos` : "videos"}
          </Button>
        }
      />
      {canEdit === false && <ViewOnlyNotice what="start batches" />}
      <ErrorBanner message={err} />
      {/* Each template scene may hold 5000 characters; one batch script may hold 5000 in all. Shown while it is too long, gone once shortened. */}
      <ErrorBanner message={template.length > MAX_BATCH_SCRIPT ? `The script is ${template.length} characters; a batch script takes at most ${MAX_BATCH_SCRIPT}. Shorten it to generate.` : null} />
      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        <div className="space-y-5">
          <Card className="space-y-4 p-4">
            {!!templateData?.templates.length && (
              <Field label="Start from a saved template" hint="Fills in its script and settings; scenes become paragraphs of one script, spoken by the first scene's presenter and voice over its background at the template's speed; scene layouts, scene speeds, on-screen text, and scenes without the presenter are not used (every row shows the presenter).">
                <select ref={templateSelect} className={inputClass} value={startedFrom} onChange={(e) => startFrom(e.target.value)} aria-label="Start from a saved template">
                  <option value="">None</option>
                  {templateData.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {carried.transparent && (
              // A transparent template changes the output (a WebM of the presenter alone), so the choice is shown and can be dropped.
              <p data-testid="batch-transparent" className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <span>Transparent background, from the template: each video is a WebM of the presenter alone, without the background.</span>
                <button
                  type="button"
                  className="shrink-0 font-medium text-brand-700 hover:underline"
                  onClick={() => {
                    setCarried(({ transparent: _t, ...rest }) => rest);
                    setCarriedNote("Each video now keeps its background.");
                    templateSelect.current?.focus();
                  }}
                >
                  Use the background
                </button>
              </p>
            )}
            {carried.avatarEngine === "avatar_v" && (
              // Like a transparent template's, a template's engine is shown and can be dropped, its blinking with it.
              <p data-testid="batch-engine" className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <span>
                  Avatar V{carried.moreBlinking ? " with more blinking" : ""}, from the template:{" "}
                  {!chosenAvatar || rendersOnAvatarV(chosenAvatar, carried)
                    ? "HeyGen's higher-quality engine, for this presenter's look."
                    : "not used, as this presenter renders on Avatar IV (its look does not support Avatar V, or it is a photo avatar given expressiveness or gestures)."}
                </span>
                <button
                  type="button"
                  className="shrink-0 font-medium text-brand-700 hover:underline"
                  onClick={() => {
                    setCarried(({ avatarEngine: _e, moreBlinking: _b, ...rest }) => rest);
                    setCarriedNote("Each video now uses Avatar IV.");
                    templateSelect.current?.focus();
                  }}
                >
                  Use Avatar IV
                </button>
              </p>
            )}
            <p className="sr-only" aria-live="polite">
              {carriedNote}
            </p>
            <Field label="Batch title" hint="Each video is titled with this plus the first column of its row.">
              <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Script template" hint={preview?.columns.length ? `Available placeholders: ${preview.columns.map((c) => `{${c}}`).join(" ")}` : "Use {column} placeholders that match your CSV header."}>
              <textarea className={`${inputClass} min-h-[140px] resize-y leading-relaxed`} value={template} onChange={(e) => setTemplate(e.target.value)} maxLength={MAX_BATCH_SCRIPT} />
            </Field>
            <Field label="Recipients (CSV)" hint="First row is the header. Up to 100 rows per batch.">
              <textarea className={`${inputClass} min-h-[140px] resize-y font-mono text-xs`} value={csv} onChange={(e) => setCsv(e.target.value)} />
              {/* Visually hidden rather than display:none, so the upload can be reached and opened from the keyboard. */}
              <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded text-xs font-medium text-brand-600 hover:underline has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500">
                <Upload className="h-3.5 w-3.5" /> Upload a .csv file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={(e) => {
                    onFile(e.target.files?.[0]);
                    // The same file can be picked again after the box was edited.
                    e.target.value = "";
                  }}
                />
              </label>
            </Field>
          </Card>
          <Card className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Avatar">
              <select className={inputClass} value={avatarId} onChange={(e) => pickAvatar(e.target.value)}>
                {(avatarData?.avatars ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Voice">
              <select className={inputClass} value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                {(voiceData?.voices ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.language ? ` · ${v.language}` : ""}</option>)}
              </select>
            </Field>
            <Field label="Aspect ratio">
              <select className={inputClass} value={aspect} onChange={(e) => (touched.current.add("aspect"), setAspect(e.target.value as AspectRatio))}>
                <option value="16:9">16:9 Landscape</option>
                <option value="9:16">9:16 Portrait</option>
                <option value="1:1">1:1 Square</option>
              </select>
            </Field>
            <Field label="Output quality">
              <select className={inputClass} value={resolution} onChange={(e) => (touched.current.add("resolution"), setResolution(e.target.value as Resolution))}>
                <option value="1080p">1080p Full HD</option>
                <option value="720p">720p HD</option>
              </select>
            </Field>
            <label className="flex items-center justify-between self-end rounded-lg border border-slate-200 px-3 py-2.5">
              <span className="text-sm font-medium text-slate-800">Captions</span>
              <input type="checkbox" checked={captions} onChange={(e) => (touched.current.add("captions"), setCaptions(e.target.checked))} className="h-5 w-5 accent-brand-600" />
            </label>
            <Field label={`Speaking speed · ${speed.toFixed(2)}x`}>
              <input type="range" min={0.5} max={1.5} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speaking speed" className="w-full accent-brand-600" />
            </Field>
            <Field label={`Voice pitch · ${pitch > 0 ? `+${pitch}` : pitch === 0 ? "natural" : pitch}`} hint="HeyGen shifts the voice; other renderers keep its natural pitch.">
              <input type="range" min={-50} max={50} step={5} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} aria-label="Voice pitch" className="w-full accent-brand-600" />
            </Field>
            <Field label="Voice emotion" hint="Kept with each video. HeyGen's current API takes no emotion, so voices speak naturally.">
              <select className={inputClass} value={emotion} onChange={(e) => setEmotion((VOICE_EMOTIONS as readonly string[]).includes(e.target.value) ? (e.target.value as VoiceEmotion) : "")} aria-label="Voice emotion">
                <option value="">Natural</option>
                {VOICE_EMOTIONS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </Field>
          </Card>
        </div>

        <Card className="p-4">
          <h3 className="text-sm font-semibold text-slate-900">Preview</h3>
          {!preview ? (
            <p className="mt-2 text-sm text-slate-500">Paste a CSV with a header row to see the personalized scripts.</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-slate-500">
                {preview.rowCount} {preview.rowCount === 1 ? "row" : "rows"} · columns: {preview.columns.join(", ") || "none"}
              </p>
              {preview.missing.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  The script uses placeholders the CSV does not have: {preview.missing.map((m) => `{${m}}`).join(", ")}
                </div>
              )}
              {preview.problem && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="batch-row-problem">
                  {preview.problem}
                </div>
              )}
              <ol className="mt-3 space-y-3">
                {preview.samples.map((s, i) => (
                  <li key={i} className="rounded-lg border border-slate-200 p-3">
                    <div className="text-xs font-semibold text-slate-700">{s.label || `Row ${i + 1}`}</div>
                    <p className="mt-1 text-sm leading-relaxed text-slate-700">{s.script}</p>
                  </li>
                ))}
              </ol>
              {preview.rowCount > preview.samples.length && <p className="mt-2 text-xs text-slate-500">…and {preview.rowCount - preview.samples.length} more.</p>}
            </>
          )}
        </Card>
      </div>
      {!!batchData?.batches.length && (
        <Card className="mt-6 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Recent batches</h2>
          <p className="mt-1 text-xs text-slate-500">Counted one video per recipient (a retried row once): open a batch&apos;s videos in the library, copy the links that can be sent now or save their QR codes for print, or download them all for a mail merge.</p>
          <ul className="mt-3 divide-y divide-slate-100" data-testid="recent-batches">
            {batchData.batches.map((b) => (
              <li key={b.batchId} className="flex flex-wrap items-center justify-between gap-2 py-2.5" data-testid="recent-batch">
                <div className="min-w-0">
                  <Link href={`/videos?batch=${encodeURIComponent(b.batchId)}`} className="block truncate text-sm font-medium text-slate-900 hover:text-brand-700 hover:underline" aria-label={`${b.title}, started ${formatDate(b.startedAt)}`}>
                    {b.title}
                  </Link>
                  <div className="text-xs text-slate-500" data-testid="recent-batch-counts">
                    {b.videos} {b.videos === 1 ? "video" : "videos"} · {b.ready} ready
                    {b.making ? ` · ${b.making} being made` : ""}
                    {b.failed ? ` · ${b.failed} failed` : ""} · started {formatDate(b.startedAt)}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  {b.failed > 0 && canEdit !== false && (
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void retryBatch(b)} disabled={batchBusy !== null && !busyWith(b.batchId, "retry")} loading={busyWith(b.batchId, "retry")} aria-label={`Retry failed (${b.failed}) in ${b.title}, started ${formatDate(b.startedAt)}`} title={`Start this batch's failed renders again with the same settings, up to ${MAX_RETRY_AT_ONCE} at a time; each counts toward this month's renders`}>
                      <RotateCcw className="h-3.5 w-3.5" /> Retry failed ({b.failed})
                    </Button>
                  )}
                  {b.ready > 0 && (
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void copyBatchLinks(b)} disabled={batchBusy !== null && !busyWith(b.batchId, "copy")} loading={busyWith(b.batchId, "copy")} aria-label={`Copy links of ${b.title}, started ${formatDate(b.startedAt)}`} title="Copy this batch's share links that can be sent now, one a line in the CSV's order">
                      <Copy className="h-3.5 w-3.5" /> Copy links
                    </Button>
                  )}
                  {b.ready > 0 && (
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void saveBatchQr(b)} disabled={batchBusy !== null && !busyWith(b.batchId, "qr")} loading={busyWith(b.batchId, "qr")} aria-label={`QR codes of ${b.title}, started ${formatDate(b.startedAt)}`} title="Save a zip of a QR code for each of this batch's links that can be sent now, for printing">
                      <QrCode className="h-3.5 w-3.5" /> QR codes
                    </Button>
                  )}
                  <a href={`/api/videos/batch/${encodeURIComponent(b.batchId)}`} download className="text-xs font-medium text-brand-700 hover:underline" aria-label={`Download links of ${b.title}, started ${formatDate(b.startedAt)}`}>
                    Download links
                  </a>
                </div>
                <p role="status" id={`batch-note-${b.batchId}`} tabIndex={-1} className={batchNote?.batchId === b.batchId ? `w-full text-xs ${batchNote.error ? "text-red-700" : "text-slate-600"}` : "sr-only"} data-testid="recent-batch-note">
                  {batchNote?.batchId === b.batchId ? batchNote.text : ""}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
