"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Languages } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, StatusBadge, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import type { Translation } from "@/lib/types";

export default function TranslatePage() {
  return (
    <Suspense>
      <TranslateInner />
    </Suspense>
  );
}

function TranslateInner() {
  const params = useSearchParams();
  const { data, error, refetch } = useApi<{ translations: Translation[]; languages: string[] }>("/api/translate", {
    pollMs: 6000,
    pollWhile: (d) => d.translations.some((t) => t.status === "processing" || t.status === "queued"),
  });
  const [title, setTitle] = useState(params.get("title") ?? "");
  const [sourceVideoUrl, setSource] = useState(params.get("source") ?? "");
  const [targetLanguage, setLang] = useState("Spanish");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      await api("/api/translate", { method: "POST", body: JSON.stringify({ title: title || `Translation to ${targetLanguage}`, sourceVideoUrl, targetLanguage }) });
      setSource("");
      setTitle("");
      refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Translation failed");
      refetch();
    } finally {
      setSubmitting(false);
    }
  }

  const items = data?.translations ?? [];

  return (
    <>
      <SectionTitle title="Video translate" subtitle="Dub an existing video into another language. Lip-sync depends on your provider." />
      <ErrorBanner message={error ?? err} />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card className="p-5">
          <div className="space-y-4">
            <Field label="Video URL" hint="A direct link to an MP4 the provider can download.">
              <input className={inputClass} value={sourceVideoUrl} onChange={(e) => setSource(e.target.value)} placeholder="https://…/video.mp4" />
            </Field>
            <Field label="Target language">
              <select className={inputClass} value={targetLanguage} onChange={(e) => setLang(e.target.value)}>
                {(data?.languages ?? ["Spanish"]).map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </Field>
            <Field label="Title (optional)">
              <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Product walkthrough – Spanish" />
            </Field>
            <Button onClick={submit} loading={submitting} disabled={!/^https?:\/\//.test(sourceVideoUrl)} className="w-full">
              <Languages className="h-4 w-4" /> Translate video
            </Button>
          </div>
        </Card>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Translations</h2>
          {items.length === 0 ? (
            <EmptyState icon={<Languages className="h-8 w-8" />} title="No translations yet" body="Submit a video on the left to get started." />
          ) : (
            <div className="space-y-3">
              {items.map((t) => (
                <Card key={t.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900">{t.title}</div>
                      <div className="mt-0.5 text-xs text-slate-500">→ {t.targetLanguage} · {formatDate(t.createdAt)}</div>
                      {t.error && <div className="mt-1 text-xs text-rose-600">{t.error}</div>}
                    </div>
                    <StatusBadge status={t.status} />
                  </div>
                  {t.status === "completed" && t.videoUrl && <video src={t.videoUrl} controls className="mt-3 w-full rounded-lg bg-black" />}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
