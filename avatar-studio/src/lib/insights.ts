// Library analytics computed client-side from the owner's videos. Pure, so it is unit-tested directly.
import type { Video } from "./types";

export interface DayCount {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  count: number;
}

export interface Insights {
  /** Renders started per UTC day, oldest first, always `days` entries. */
  perDay: DayCount[];
  totalLast: number;
  totalPrevious: number;
  completionRate: number | null;
  totalViews: number;
  /** Clicks on share-page call-to-action buttons across the library. */
  totalClicks: number;
  /** Clicks per view across the library, null until something has been viewed. */
  clickRate: number | null;
  /** Viewers who played a shared video to the end, as a share of views (0..1); null until something has been viewed. */
  finishRate: number | null;
  topViewed: Video[];
  folders: Array<{ name: string; count: number }>;
}

/** Share of a video's views that played to the end (0..1), or null before any view; never above 1 even if the counters disagree. */
export function finishRateOf(video: Pick<Video, "views" | "watch">): number | null {
  if (!video.views) return null;
  return Math.min(1, (video.watch?.q100 ?? 0) / video.views);
}

const DAY_MS = 86_400_000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function computeInsights(videos: Video[], now = Date.now(), days = 14): Insights {
  const start = Math.floor(now / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
  const perDay: DayCount[] = Array.from({ length: days }, (_, i) => ({ day: dayKey(start + i * DAY_MS), count: 0 }));
  const index = new Map(perDay.map((d, i) => [d.day, i]));
  let totalPrevious = 0;
  for (const v of videos) {
    const t = Date.parse(v.createdAt);
    if (Number.isNaN(t)) continue;
    const i = index.get(dayKey(t));
    if (i !== undefined && t >= start) perDay[i].count += 1;
    else if (t >= start - days * DAY_MS && t < start) totalPrevious += 1;
  }
  const completed = videos.filter((v) => v.status === "completed").length;
  const failed = videos.filter((v) => v.status === "failed").length;
  const totalViews = videos.reduce((n, v) => n + (v.views ?? 0), 0);
  const totalClicks = videos.reduce((n, v) => n + (v.ctaClicks ?? 0), 0);
  const totalFinished = videos.reduce((n, v) => n + (v.watch?.q100 ?? 0), 0);
  const folderCounts = new Map<string, number>();
  for (const v of videos) if (v.folder) folderCounts.set(v.folder, (folderCounts.get(v.folder) ?? 0) + 1);
  return {
    perDay,
    totalLast: perDay.reduce((n, d) => n + d.count, 0),
    totalPrevious,
    completionRate: completed + failed ? completed / (completed + failed) : null,
    totalViews,
    totalClicks,
    clickRate: totalViews ? totalClicks / totalViews : null,
    finishRate: totalViews ? Math.min(1, totalFinished / totalViews) : null,
    topViewed: videos
      .filter((v) => (v.views ?? 0) > 0)
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, 3),
    folders: Array.from(folderCounts, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
