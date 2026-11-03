"use client";
import { describeOtherUses, nameOtherUses, type OtherUse } from "@/lib/presenters";

/**
 * "Used by …" under a presenter or voice: the interactive presenters, templates, brand kit, and photo avatars that name
 * it (see services/usage.ts). One of each kind is named in the line itself; when a kind is counted ("2 templates"), the
 * line opens to list every name, so they are reachable by keyboard, touch, and screen reader alike. Nothing when unused.
 */
export function OtherUsesLine({ uses, marker }: { uses: OtherUse[] | undefined; marker: Record<`data-${string}`, string> }) {
  if (!uses?.length) return null;
  const line = `Used by ${describeOtherUses(uses)}`;
  const counted = new Set(uses.map((u) => u.kind)).size < uses.length;
  if (!counted) {
    return (
      <p className="mt-1 break-words text-xs text-slate-500" {...marker}>
        {line}
      </p>
    );
  }
  return (
    <details className="mt-1 text-xs text-slate-500" {...marker}>
      <summary className="cursor-pointer break-words hover:text-slate-700">{line}</summary>
      <ul className="mt-0.5 list-disc break-words pl-4">
        {nameOtherUses(uses).map((name, i) => (
          <li key={i}>{name}</li>
        ))}
      </ul>
    </details>
  );
}
