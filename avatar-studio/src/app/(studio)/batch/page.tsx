"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Layers3, Upload } from "lucide-react";
import { Button, Card, ErrorBanner, Field, SectionTitle, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { api } from "@/lib/client";
import { decodeScript, legacyEncodingFor } from "@/lib/script-import";
import { VOICE_EMOTIONS, type AspectRatio, type Avatar, type Background, type BrandKit, type CaptionStyle, type PhotoExpressiveness, type Resolution, type Voice, type VideoTemplate, type VoiceEmotion } from "@/lib/types";

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
  // Set only by a saved template: the batch API takes them, the page has no controls of its own for them.
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle | undefined>();
  const [background, setBackground] = useState<Background | undefined>();
  const [motion, setMotion] = useState<{ expressiveness?: PhotoExpressiveness; motionPrompt?: string }>({});
  const [startedFrom, setStartedFrom] = useState("");
  // A template's presenter and voice, held until both lists have loaded (a template can be picked first).
  // Each holds the ids to try in order: the first scene's own, then the template's.
  const [cast, setCast] = useState<{ avatarIds: string[]; voiceIds: string[] } | null>(null);
  const { data: templateData } = useApi<{ templates: VideoTemplate[] }>("/api/templates");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A fresh batch starts from the brand kit, as the editor does: its presenter and voice (or the presenter's own
  // voice), format, quality, and captions; the server gives the rows the kit's background. A saved template wins.
  // Without a kit (or when it cannot be read) the first presenter and voice in the lists.
  const { data: brandData, error: brandError } = useApi<{ brand: BrandKit | null }>("/api/brand");
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
  }, [brandData, brandError, avatarData, voiceData, startedFrom]);
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
    const t = templateData?.templates.find((x) => x.id === id);
    if (!t) {
      // "None": drop the settings the page has no controls for, so they do not ride along unseen.
      setCaptionStyle(undefined);
      setBackground(undefined);
      setMotion({});
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
    setMotion({ ...(t.expressiveness ? { expressiveness: t.expressiveness } : {}), ...(t.motionPrompt ? { motionPrompt: t.motionPrompt } : {}) });
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
        body: JSON.stringify({ title, scriptTemplate: template, csv, avatarId, voiceId, aspect, resolution, captions, ...(captions && captionStyle ? { captionStyle } : {}), speed, ...(pitch ? { pitch } : {}), ...(emotion ? { emotion } : {}), ...(background ? { background } : {}), ...motion }),
      });
      const note = `${result.skipped.length ? `&skipped=${result.skipped.length}` : ""}${result.failed.length ? `&failed=${result.failed.length}` : ""}`;
      router.push(`/videos?batch=${result.batchId}${note}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the batch");
      setBusy(false);
    }
  }

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
                <select className={inputClass} value={startedFrom} onChange={(e) => startFrom(e.target.value)} aria-label="Start from a saved template">
                  <option value="">None</option>
                  {templateData.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </Field>
            )}
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
    </>
  );
}
