"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Eye } from "lucide-react";
import { Card } from "@/components/ui";
import { computeInsights } from "@/lib/insights";
import type { Video } from "@/lib/types";

const W = 800;
const H = 96;
const PAD_TOP = 18;
const GAP = 2;

/** Renders per day (14 days), completion rate, views, and most viewed videos. */
export function Insights({ videos }: { videos: Video[] }) {
  const data = useMemo(() => computeInsights(videos), [videos]);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.perDay.map((d) => d.count));
  const barW = (W - GAP * (data.perDay.length - 1)) / data.perDay.length;
  const peak = data.perDay.reduce((best, d, i) => (d.count > data.perDay[best].count ? i : best), 0);
  const delta = data.totalPrevious ? Math.round(((data.totalLast - data.totalPrevious) / data.totalPrevious) * 100) : null;
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]" data-testid="insights">
      <Card className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Renders, last 14 days</h3>
          <div className="text-xs text-slate-500">
            <span className="text-base font-semibold text-slate-900">{data.totalLast}</span>
            {delta !== null && (
              <span className={`ml-2 ${delta >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                {delta >= 0 ? "+" : ""}
                {delta}% vs previous 14 days
              </span>
            )}
          </div>
        </div>
        <div className="relative mt-3">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Renders per day for the last 14 days, ${data.totalLast} in total`} onMouseLeave={() => setHover(null)}>
            <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#e2e8f0" strokeWidth="1" />
            {data.perDay.map((d, i) => {
              const h = d.count ? Math.max(3, ((H - PAD_TOP) * d.count) / max) : 0;
              const x = i * (barW + GAP);
              const y = H - h;
              const r = Math.min(4, barW / 2, h);
              const active = hover === i;
              return (
                <g key={d.day} onMouseEnter={() => setHover(i)}>
                  {/* Hit target taller than the mark */}
                  <rect x={x} y={0} width={barW} height={H} fill="transparent" />
                  {h > 0 && (
                    <path
                      d={`M${x},${H} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`}
                      fill={active ? "#4338ca" : "#4f46e5"}
                    />
                  )}
                  {(i === peak && d.count > 0 && hover === null) || active ? (
                    <text x={x + barW / 2} y={Math.max(10, y - 5)} textAnchor="middle" fontSize="10" fill="#334155">
                      {d.count}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          <div className="mt-1 flex justify-between text-[10px] text-slate-500">
            <span>{label(data.perDay[0].day)}</span>
            <span>{hover !== null ? `${label(data.perDay[hover].day)}: ${data.perDay[hover].count} ${data.perDay[hover].count === 1 ? "render" : "renders"}` : "Today"}</span>
          </div>
        </div>
        <details className="mt-3 text-xs text-slate-600">
          <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-800">Show as table</summary>
          <table className="mt-2 w-full text-left">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1 font-medium">Day (UTC)</th>
                <th className="py-1 text-right font-medium">Renders</th>
              </tr>
            </thead>
            <tbody>
              {data.perDay.map((d) => (
                <tr key={d.day} className="border-t border-slate-100">
                  <td className="py-1">{d.day}</td>
                  <td className="py-1 text-right tabular-nums">{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <Card className="p-5">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Completion rate</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{data.completionRate === null ? "—" : `${Math.round(data.completionRate * 100)}%`}</div>
          <div className="mt-1 text-xs text-slate-500">{data.completionRate === null ? "No finished renders yet" : "completed out of completed + failed"}</div>
        </Card>
        <Card className="p-5">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Share views</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{data.totalViews}</div>
          {data.topViewed.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs">
              {data.topViewed.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2">
                  <Link href={`/videos/${v.id}`} className="truncate text-slate-700 hover:underline">
                    {v.title}
                  </Link>
                  <span className="inline-flex shrink-0 items-center gap-1 text-slate-500">
                    <Eye className="h-3 w-3" /> {v.views}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-1 text-xs text-slate-500">Share a finished video to start counting</div>
          )}
        </Card>
      </div>
    </div>
  );
}
