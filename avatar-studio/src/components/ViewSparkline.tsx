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
  const days = useMemo(() => viewsPerDay(video, Date.now(), DAYS), [video]);
  const total = days.reduce((n, d) => n + d.count, 0);
  const max = Math.max(1, ...days.map((d) => d.count));
  const barW = (W - GAP * (DAYS - 1)) / DAYS;
  return (
    <span className="inline-flex items-center gap-2" data-testid="views-by-day" data-total={total}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0" role="img" aria-label={`Views per day for the last ${DAYS} days, ${total} in total`}>
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#e2e8f0" strokeWidth="1" />
        {days.map((d, i) => {
          const h = d.count ? Math.max(2, ((H - 4) * d.count) / max) : 0;
          const x = i * (barW + GAP);
          const r = Math.min(2, barW / 2, h);
          return (
            <g key={d.day}>
              <title>{`${label(d.day)}: ${d.count} ${d.count === 1 ? "view" : "views"}`}</title>
              <rect x={x} y={0} width={barW} height={H} fill="transparent" />
              {h > 0 && <path d={`M${x},${H} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`} fill="#4f46e5" />}
            </g>
          );
        })}
      </svg>
      <span className="text-xs text-slate-500">{total} in {DAYS} days</span>
    </span>
  );
}
