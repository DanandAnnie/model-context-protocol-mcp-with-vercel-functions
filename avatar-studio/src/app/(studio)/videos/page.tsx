"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Clapperboard } from "lucide-react";
import { VideoCard } from "@/components/VideoCard";
import { EmptyState, ErrorBanner, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import type { Video, VideoStatus } from "@/lib/types";

const STATUSES: Array<"all" | VideoStatus> = ["all", "processing", "completed", "failed"];

export default function VideosPage() {
  const { data, loading, error } = useApi<{ videos: Video[] }>("/api/videos", {
    pollMs: 6000,
    pollWhile: (d) => d.videos.some((v) => v.status === "processing" || v.status === "queued"),
  });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | VideoStatus>("all");
  const videos = useMemo(() => {
    const all = data?.videos ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((v) => {
      const statusOk = status === "all" ? true : status === "processing" ? v.status === "processing" || v.status === "queued" : v.status === status;
      const textOk = !needle || `${v.title} ${v.script} ${v.avatarName ?? ""} ${v.voiceName ?? ""}`.toLowerCase().includes(needle);
      return statusOk && textOk;
    });
  }, [data, q, status]);
  const hasAny = (data?.videos.length ?? 0) > 0;

  return (
    <>
      <SectionTitle
        title="My videos"
        subtitle="Everything you have rendered. Processing videos update automatically."
        action={
          <Link href="/create" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            New video
          </Link>
        }
      />
      <ErrorBanner message={error} />
      {hasAny && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <input className={`${inputClass} max-w-xs`} placeholder="Search title, script, avatar, voice" value={q} onChange={(e) => setQ(e.target.value)} />
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${status === s ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-[16/11]" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <EmptyState
          icon={<Clapperboard className="h-8 w-8" />}
          title={hasAny ? "No videos match" : "No videos yet"}
          body={hasAny ? "Try a different search or status filter." : "Your rendered videos will show up here."}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((v) => (
            <VideoCard key={v.id} video={v} />
          ))}
        </div>
      )}
    </>
  );
}
