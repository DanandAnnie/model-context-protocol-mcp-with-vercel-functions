"use client";
import { useMemo } from "react";
import { viewsPerDay } from "@/lib/insights";
import type { Video } from "@/lib/types";

const W = 140;
const H = 28;
const GAP = 2;
const DAYS = 14;

const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** Fourteen thin bars of a video's share views per UTC day; each bar names its day and count on hover. */
export function ViewSparkline({ video }: { video: Pick<Video, "viewsByDay"> }) {
  return <DaySparkline byDay={video.viewsByDay} one="view" many="views" testId="views-by-day" />;
}

/** Fourteen thin bars of counts per UTC day (`byDay`, "YYYY-MM-DD" → count), each naming its day and count on hover. */
export function DaySparkline({ byDay, one, many, testId }: { byDay: Record<string, number> | undefined; one: string; many: string; testId: string }) {
  const days = useMemo(() => viewsPerDay({ viewsByDay: byDay }, Date.now(), DAYS), [byDay]);
  const total = days.reduce((n, d) => n + d.count, 0);
  const max = Math.max(1, ...days.map((d) => d.count));
  const barW = (W - GAP * (DAYS - 1)) / DAYS;
  const Many = many.charAt(0).toUpperCase() + many.slice(1);
  return (
    <span className="inline-flex items-center gap-2" data-testid={testId} data-total={total}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0" role="img" aria-label={`${Many} per day for the last ${DAYS} days, ${total} in total`}>
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#e2e8f0" strokeWidth="1" />
        {days.map((d, i) => {
          const h = d.count ? Math.max(2, ((H - 4) * d.count) / max) : 0;
          const x = i * (barW + GAP);
          const r = Math.min(2, barW / 2, h);
          return (
            <g key={d.day}>
              <title>{`${label(d.day)}: ${d.count} ${d.count === 1 ? one : many}`}</title>
              <rect x={x} y={0} width={barW} height={H} fill="transparent" />
              {h > 0 && <path d={`M${x},${H} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`} fill="#4f46e5" />}
            </g>
          );
        })}
      </svg>
      {/* The picture's name already says the total, so a screen reader hears it once. */}
      <span className="text-xs text-slate-500" aria-hidden="true">
        {total} in {DAYS} days
      </span>
    </span>
  );
}
