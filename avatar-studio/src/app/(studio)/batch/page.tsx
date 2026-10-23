"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Layers3, Upload } from "lucide-react";
import { Button, Card, ErrorBanner, Field, SectionTitle, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/client";
import type { AspectRatio, Avatar, Resolution, Voice } from "@/lib/types";

const SAMPLE_CSV = `name,property,move_in
Jordan,12 Elm Street,November 1
Priya,48 Harbor View,November 15`;
const SAMPLE_TEMPLATE = "Hi {name}, welcome to {property}! Your move-in date is {move_in}. Rent is due on the first and you can pay it in the portal. We're glad you're here.";

interface Preview {
  columns: string[];
  rowCount: number;
  missing: string[];
  samples: Array<{ label: string; script: string }>;
}

export default function BatchPage() {
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!avatarId && avatarData?.avatars.length) setAvatarId(avatarData.avatars[0].id);
  }, [avatarData, avatarId]);
  useEffect(() => {
    if (!voiceId && voiceData?.voices.length) setVoiceId(voiceData.voices[0].id);
  }, [voiceData, voiceId]);

  // Live preview, debounced.
  useEffect(() => {
    const t = setTimeout(() => {
      api<Preview>("/api/videos/batch", { method: "PUT", body: JSON.stringify({ scriptTemplate: template, csv }) })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [template, csv]);

  function onFile(file: File | undefined) {
    if (!file) return;
    file.text().then(setCsv);
  }

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      const result = await api<{ batchId: string; videos: unknown[]; skipped: Array<{ row: number; reason: string }>; failed: Array<{ row: number; reason: string }> }>("/api/videos/batch", {
        method: "POST",
        body: JSON.stringify({ title, scriptTemplate: template, csv, avatarId, voiceId, aspect, resolution, captions }),
      });
      const note = `${result.skipped.length ? `&skipped=${result.skipped.length}` : ""}${result.failed.length ? `&failed=${result.failed.length}` : ""}`;
      router.push(`/videos?batch=${result.batchId}${note}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the batch");
      setBusy(false);
    }
  }

  const ready = !!preview && preview.rowCount > 0 && preview.missing.length === 0 && !!avatarId && !!voiceId && title.trim().length > 0;

  return (
    <>
      <SectionTitle
        title="Personalize at scale"
        subtitle="One script, many recipients. Each CSV row becomes its own video with {column} placeholders filled in."
        action={
          <Button onClick={generate} disabled={!ready || busy} loading={busy}>
            <Layers3 className="h-4 w-4" /> Generate {preview?.rowCount ? `${preview.rowCount} videos` : "videos"}
          </Button>
        }
      />
      <ErrorBanner message={err} />
      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        <div className="space-y-5">
          <Card className="space-y-4 p-4">
            <Field label="Batch title" hint="Each video is titled with this plus the first column of its row.">
              <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Script template" hint={preview?.columns.length ? `Available placeholders: ${preview.columns.map((c) => `{${c}}`).join(" ")}` : "Use {column} placeholders that match your CSV header."}>
              <textarea className={`${inputClass} min-h-[140px] resize-y leading-relaxed`} value={template} onChange={(e) => setTemplate(e.target.value)} maxLength={5000} />
            </Field>
            <Field label="Recipients (CSV)" hint="First row is the header. Up to 100 rows per batch.">
              <textarea className={`${inputClass} min-h-[140px] resize-y font-mono text-xs`} value={csv} onChange={(e) => setCsv(e.target.value)} />
              <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-brand-600 hover:underline">
                <Upload className="h-3.5 w-3.5" /> Upload a .csv file
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
            </Field>
          </Card>
          <Card className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Avatar">
              <select className={inputClass} value={avatarId} onChange={(e) => setAvatarId(e.target.value)}>
                {(avatarData?.avatars ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Voice">
              <select className={inputClass} value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                {(voiceData?.voices ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.language ? ` · ${v.language}` : ""}</option>)}
              </select>
            </Field>
            <Field label="Aspect ratio">
              <select className={inputClass} value={aspect} onChange={(e) => setAspect(e.target.value as AspectRatio)}>
                <option value="16:9">16:9 Landscape</option>
                <option value="9:16">9:16 Portrait</option>
                <option value="1:1">1:1 Square</option>
              </select>
            </Field>
            <Field label="Output quality">
              <select className={inputClass} value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>
                <option value="1080p">1080p Full HD</option>
                <option value="720p">720p HD</option>
              </select>
            </Field>
            <label className="flex items-center justify-between self-end rounded-lg border border-slate-200 px-3 py-2.5">
              <span className="text-sm font-medium text-slate-800">Captions</span>
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} className="h-5 w-5 accent-brand-600" />
            </label>
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
