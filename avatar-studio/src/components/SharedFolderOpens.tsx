"use client";
import Link from "next/link";
import { useMemo } from "react";
import { FolderOpen } from "lucide-react";
import { Card } from "@/components/ui";
import { folderOpens, type FolderOpensInput } from "@/lib/insights";

const DAYS = 14;

/**
 * Home's shared folders card: how often the account's shared folder pages were opened in the last two weeks, and the
 * three opened most, each opening the library at that folder. Shown once a folder is shared.
 */
export function SharedFolderOpens({ collections }: { collections: FolderOpensInput[] }) {
  const data = useMemo(() => folderOpens(collections, Date.now(), DAYS), [collections]);
  if (!data.shared) return null;
  return (
    <Card className="p-5" data-testid="shared-folder-opens">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Shared folders</h3>
        <span className="text-xs text-slate-500">
          {data.shared} shared
        </span>
      </div>
      <div className="mt-1 text-2xl font-semibold text-slate-900" data-testid="shared-folder-opens-total">
        {data.total}
      </div>
      <div className="text-xs text-slate-500">{data.total === 1 ? "open" : "opens"} of their pages in the last {DAYS} days</div>
      {data.top.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs" aria-label={`Shared folders opened most in the last ${DAYS} days`}>
          {data.top.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2">
              <Link href={`/videos?folder=${encodeURIComponent(f.folder)}`} className="inline-flex min-w-0 items-center gap-1 text-slate-700 hover:underline" data-testid="shared-folder-opens-link">
                <FolderOpen className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
                <span className="truncate" title={f.label}>
                  {f.label}
                </span>
              </Link>
              <span className="shrink-0 tabular-nums text-slate-500">
                {f.opens} {f.opens === 1 ? "open" : "opens"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 text-xs text-slate-500">No folder page was opened in the last {DAYS} days.</div>
      )}
    </Card>
  );
}
