"use client";
import Link from "next/link";
import { Film } from "lucide-react";
import { StatusBadge } from "./ui";
import { formatDate, formatSeconds } from "@/lib/client";
import type { Video } from "@/lib/types";

export function VideoCard({ video }: { video: Video }) {
  const portrait = video.aspect === "9:16";
  return (
    <Link href={`/videos/${video.id}`} className="group overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-slate-300 hover:shadow-sm">
      <div className={`relative w-full overflow-hidden bg-slate-900 ${portrait ? "aspect-video" : "aspect-video"}`}>
        {video.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-500">
            <Film className="h-8 w-8" />
          </div>
        )}
        <span className="absolute left-2 top-2">
          <StatusBadge status={video.status} />
        </span>
        {video.durationSec != null && (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">{formatSeconds(video.durationSec)}</span>
        )}
      </div>
      <div className="p-3">
        <div className="truncate text-sm font-medium text-slate-900">{video.title}</div>
        <div className="mt-0.5 text-xs text-slate-500">
          {video.aspect} · {formatDate(video.createdAt)}
        </div>
      </div>
    </Link>
  );
}
