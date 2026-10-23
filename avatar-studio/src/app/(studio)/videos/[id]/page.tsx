"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Download, Languages, Trash2 } from "lucide-react";
import { Button, Card, ErrorBanner, SectionTitle, Skeleton, StatusBadge } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate, formatSeconds } from "@/lib/client";
import type { Video } from "@/lib/types";

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const { data, loading, error } = useApi<{ video: Video }>(`/api/videos/${id}`, {
    pollMs: 5000,
    pollWhile: (d) => d.video.status === "processing" || d.video.status === "queued",
  });
  const video = data?.video;

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
                {video.videoUrl && (
                  <Link href={`/translate?source=${encodeURIComponent(video.videoUrl)}&title=${encodeURIComponent(video.title)}`} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
                    <Languages className="h-4 w-4" /> Translate
                  </Link>
                )}
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
                <h3 className="text-sm font-semibold text-slate-900">Script</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{video.script}</p>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="truncate text-right text-slate-900">{children}</dd>
    </div>
  );
}
