"use client";
import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { VideoCard } from "@/components/VideoCard";
import { EmptyState, ErrorBanner, SectionTitle, Skeleton } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import type { Video } from "@/lib/types";

export default function VideosPage() {
  const { data, loading, error } = useApi<{ videos: Video[] }>("/api/videos", {
    pollMs: 6000,
    pollWhile: (d) => d.videos.some((v) => v.status === "processing" || v.status === "queued"),
  });
  const videos = data?.videos ?? [];

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
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-[16/11]" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <EmptyState icon={<Clapperboard className="h-8 w-8" />} title="No videos yet" body="Your rendered videos will show up here." />
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
