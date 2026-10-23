// Library analytics computed client-side from the owner's videos. Pure, so it is unit-tested directly.
import type { Video } from "./types";

const DAY_MS = 86_400_000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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
  /** Viewers who played a shared video to the end, as a share of views (0..1); null until the player has reported anything. */
  finishRate: number | null;
  topViewed: Video[];
  folders: Array<{ name: string; count: number }>;
}

/** Share of a video's views that played to the end (0..1), or null before any view; never above 1 even if the counters disagree. */
export function finishRateOf(video: Pick<Video, "views" | "watch">): number | null {
  if (!video.views) return null;
  return Math.min(1, (video.watch?.q100 ?? 0) / video.views);
}

/** How many days of per-day views a video keeps; older days are dropped when a view lands. */
export const VIEW_HISTORY_DAYS = 90;

/** Returns the per-day view map with one more view on `now`'s UTC day and days older than the history window dropped. */
export function bumpViewsByDay(existing: Record<string, number> | undefined, now = Date.now()): Record<string, number> {
  const today = dayKey(now);
  const oldest = dayKey(now - (VIEW_HISTORY_DAYS - 1) * DAY_MS);
  const next: Record<string, number> = {};
  for (const [day, n] of Object.entries(existing ?? {})) if (day >= oldest && day !== today && n > 0) next[day] = n;
  next[today] = (existing?.[today] ?? 0) + 1;
  return next;
}

/** A video's views per UTC day for the last `days` days, oldest first, always `days` entries. */
export function viewsPerDay(video: Pick<Video, "viewsByDay">, now = Date.now(), days = 14): DayCount[] {
  const start = Math.floor(now / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
  return Array.from({ length: days }, (_, i) => {
    const day = dayKey(start + i * DAY_MS);
    return { day, count: video.viewsByDay?.[day] ?? 0 };
  });
}

/** Views in the last `days` UTC days including today. */
export function viewsInLast(video: Pick<Video, "viewsByDay">, days: number, now = Date.now()): number {
  return viewsPerDay(video, now, days).reduce((n, d) => n + d.count, 0);
}

export const ANALYTICS_COLUMNS = ["id", "title", "status", "created", "folder", "duration_sec", "views", "views_7d", "last_viewed", "watched_25", "watched_50", "watched_75", "watched_100", "finish_rate", "cta_clicks", "share_link"] as const;

/** One spreadsheet row per video: what the owner sees on the video page, in a form that sorts and sums. */
export function analyticsRows(videos: Video[], base: string, now = Date.now()): Array<Record<(typeof ANALYTICS_COLUMNS)[number], string | number | undefined>> {
  const origin = base.replace(/\/$/, "");
  return videos.map((v) => {
    const rate = finishRateOf(v);
    return {
      id: v.id,
      title: v.title,
      status: v.status,
      created: v.createdAt,
      folder: v.folder,
      duration_sec: v.durationSec,
      views: v.views ?? 0,
      views_7d: viewsInLast(v, 7, now),
      last_viewed: v.lastViewedAt,
      watched_25: v.watch?.q25 ?? 0,
      watched_50: v.watch?.q50 ?? 0,
      watched_75: v.watch?.q75 ?? 0,
      watched_100: v.watch?.q100 ?? 0,
      finish_rate: rate === null ? undefined : Math.round(rate * 100),
      cta_clicks: v.ctaClicks ?? 0,
      share_link: `${origin}/share/${v.id}`,
    };
  });
}

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
  // Views predate watch marks, so a library with views but no marks at all is "no data", not 0%.
  const anyWatch = videos.some((v) => v.watch && Object.values(v.watch).some((n) => n > 0));
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
    finishRate: totalViews && anyWatch ? Math.min(1, totalFinished / totalViews) : null,
    topViewed: videos
      .filter((v) => (v.views ?? 0) > 0)
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, 3),
    folders: Array.from(folderCounts, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
