"use client";
import { biggestDrop, retentionShares } from "@/lib/retention";
import type { Video } from "@/lib/types";

const W = 200;
const H = 40;
const GAP = 2;
const BARS = 10;

const at = (point: number) => (point === 0 ? "the start" : point === 10 ? "the end" : `${point * 10}%`);

/**
 * Audience retention on the video page: of the share-page viewers who started playing, the share who reached each tenth
 * of the video, as ten thin bars (each naming its point, share, and count on hover), a line saying how many started,
 * how many reached the end, and where most left, and the same figures as a table for anyone who would rather read them.
 */
export function RetentionChart({ video }: { video: Pick<Video, "retention"> }) {
  const r = retentionShares(video.retention);
  if (!r) {
    return (
      <span className="text-xs text-slate-500" data-testid="retention">
        No plays on the share page yet
      </span>
    );
  }
  // Viewers at each tenth, from the share shown, so a count and its share always agree.
  const viewers = (share: number) => Math.round((share * r.started) / 100);
  const drop = biggestDrop(r.shares);
  const barW = (W - GAP * (BARS - 1)) / BARS;
  const end = r.shares[BARS - 1];
  return (
    // Right-aligned as a whole, as the other values on the video page are, so the bars, the lines under them, and the
    // table share one edge at every width.
    <span className="inline-flex flex-col items-end gap-1 text-right" data-testid="retention" data-started={r.started}>
      <span className="inline-flex flex-wrap items-center justify-end gap-2">
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0" role="img" aria-label={`Retention: of ${r.started} viewers who started, ${end}% reached the end`}>
          <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#e2e8f0" strokeWidth="1" />
          {r.shares.map((share, i) => {
            const h = share ? Math.max(2, ((H - 2) * share) / 100) : 0;
            const x = i * (barW + GAP);
            const rad = Math.min(2, barW / 2, h);
            return (
              <g key={i} data-share={share}>
                <title>{`${(i + 1) * 10}%: ${share}% of viewers (${viewers(share)})`}</title>
                <rect x={x} y={0} width={barW} height={H} fill="transparent" />
                {h > 0 && <path d={`M${x},${H} v${-(h - rad)} a${rad},${rad} 0 0 1 ${rad},${-rad} h${barW - 2 * rad} a${rad},${rad} 0 0 1 ${rad},${rad} v${h - rad} z`} fill="#4f46e5" />}
              </g>
            );
          })}
        </svg>
        <span className="text-xs text-slate-500" aria-hidden="true">
          {r.started} started · {end}% to the end
        </span>
      </span>
      {drop && (
        <span className="text-xs text-slate-600" data-testid="retention-drop">
          Most left between {at(drop.from)} and {at(drop.to)} ({drop.points} points)
        </span>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Retention table</summary>
        <table className="ml-auto mt-1 text-left text-slate-600" data-testid="retention-table">
          <thead>
            <tr>
              <th scope="col" className="pr-4 font-medium">Reached</th>
              <th scope="col" className="pr-4 font-medium">Viewers</th>
              <th scope="col" className="font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="pr-4 font-normal">Started</th>
              <td className="pr-4">{r.started}</td>
              <td>100%</td>
            </tr>
            {r.shares.map((share, i) => (
              <tr key={i}>
                <th scope="row" className="pr-4 font-normal">{i === BARS - 1 ? "The end" : `${(i + 1) * 10}%`}</th>
                <td className="pr-4">{viewers(share)}</td>
                <td>{share}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </span>
  );
}
