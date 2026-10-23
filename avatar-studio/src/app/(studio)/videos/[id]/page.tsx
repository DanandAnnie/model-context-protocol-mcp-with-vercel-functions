"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Captions, Check, Copy, Download, Languages, Link2, Trash2 } from "lucide-react";
import { Button, Card, ErrorBanner, SectionTitle, Skeleton, StatusBadge } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate, formatSeconds } from "@/lib/client";
import type { Video } from "@/lib/types";

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const { data, loading, error } = useApi<{ video: Video }>(`/api/videos/${id}`, {
    pollMs: 5000,
    pollWhile: (d) => d.video.status === "processing" || d.video.status === "queued",
  });
  const video = data?.video;

  async function copyShareLink() {
    if (!video) return;
    const url = `${window.location.origin}/share/${video.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  async function remove() {
    if (!video || !confirm("Delete this video? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await api(`/api/videos/${video.id}`, { method: "DELETE" });
      router.push("/videos");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Link href="/videos" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" /> All videos
      </Link>
      <ErrorBanner message={error} />
      {loading || !video ? (
        <Skeleton className="aspect-video w-full" />
      ) : (
        <>
          <SectionTitle
            title={video.title}
            subtitle={`Created ${formatDate(video.createdAt)} · ${video.aspect} · ${video.provider}`}
            action={
              <div className="flex items-center gap-2">
                {video.videoUrl && (
                  <a href={video.videoUrl} download target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
                    <Download className="h-4 w-4" /> Download
                  </a>
                )}
                {video.status === "completed" && (
                  <>
                    <a href={`/api/videos/${video.id}/captions`} download className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
                      <Captions className="h-4 w-4" /> Captions (.srt)
                    </a>
                    <Button variant="secondary" onClick={copyShareLink}>
                      {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Link2 className="h-4 w-4" />} {copied ? "Link copied" : "Share"}
                    </Button>
                  </>
                )}
                {video.videoUrl && (
                  <Link href={`/translate?source=${encodeURIComponent(video.videoUrl)}&title=${encodeURIComponent(video.title)}`} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
                    <Languages className="h-4 w-4" /> Translate
                  </Link>
                )}
                <Link href={`/create?from=${video.id}`} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
                  <Copy className="h-4 w-4" /> Edit a copy
                </Link>
                <Button variant="danger" onClick={remove} loading={deleting}>
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
              </div>
            }
          />

          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-center bg-slate-950 p-0">
               <div className={`relative flex items-center justify-center ${video.aspect === "9:16" ? "aspect-[9/16] h-[70vh]" : video.aspect === "1:1" ? "aspect-square w-full max-w-[560px]" : "aspect-video w-full"}`}>
                {video.status === "completed" && video.videoUrl ? (
                  <video src={video.videoUrl} poster={video.thumbnailUrl} controls className="h-full w-full" />
                ) : video.status === "failed" ? (
                  <div className="p-8 text-center text-sm text-rose-200">
                    <p className="font-medium">Render failed</p>
                    <p className="mt-1 text-rose-300/80">{video.error}</p>
                  </div>
                ) : (
                  <div className="p-8 text-center text-slate-300">
                    <StatusBadge status={video.status} />
                    <p className="mt-3 text-sm">Rendering your video. This page refreshes automatically.</p>
                  </div>
                )}
               </div>
              </div>
            </Card>

            <div className="space-y-4">
              <Card className="p-4">
                <h3 className="text-sm font-semibold text-slate-900">Details</h3>
                <dl className="mt-3 space-y-2 text-sm">
                  <Row label="Status"><StatusBadge status={video.status} /></Row>
                  <Row label="Duration">{video.durationSec != null ? formatSeconds(video.durationSec) : "—"}</Row>
                  <Row label="Avatar">{video.avatarName ?? video.avatarId}</Row>
                  <Row label="Voice">{video.voiceName ?? video.voiceId}</Row>
                  <Row label="Speed">{video.speed}x</Row>
                  <Row label="Captions">{video.captions ? "On" : "Off"}</Row>
                  <Row label="Background">
                    {video.background.type === "color" ? (
                      <span className="inline-flex items-center gap-2"><span className="h-4 w-4 rounded border border-slate-200" style={{ background: video.background.value }} />{video.background.value}</span>
                    ) : (
                      "Image"
                    )}
                  </Row>
                </dl>
              </Card>
              <Card className="p-4">
                <h3 className="text-sm font-semibold text-slate-900">{video.scenes && video.scenes.length > 1 ? `Script · ${video.scenes.length} scenes` : "Script"}</h3>
                {video.scenes && video.scenes.length > 1 ? (
                  <ol className="mt-2 space-y-3">
                    {video.scenes.map((sc, i) => (
                      <li key={i} className="flex gap-3 text-sm">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-black/10 text-[10px] font-semibold text-slate-700" style={sc.background.type === "color" ? { background: sc.background.value, color: isDarkHex(sc.background.value) ? "#fff" : undefined } : undefined}>
                          {i + 1}
                        </span>
                        <p className="whitespace-pre-wrap leading-relaxed text-slate-700">{sc.script}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{video.script}</p>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function isDarkHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.5;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="truncate text-right text-slate-900">{children}</dd>
    </div>
  );
}
