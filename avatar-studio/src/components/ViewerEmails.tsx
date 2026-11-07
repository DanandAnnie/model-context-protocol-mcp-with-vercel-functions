"use client";
import { Download, Mail } from "lucide-react";
import { Card } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { formatDate } from "@/lib/client";
import type { VideoLead } from "@/lib/types";

/** The emails the share page's gate collected for one video, newest first, with a CSV download. */
export function ViewerEmails({ videoId, gateOn }: { videoId: string; gateOn: boolean }) {
  // New emails only arrive while the gate is on, so the list is only kept fresh then.
  const { data } = useApi<{ leads: VideoLead[] }>(`/api/videos/${videoId}/leads`, gateOn ? { pollMs: 15_000 } : {});
  const leads = data?.leads ?? [];
  if (!gateOn && leads.length === 0) return null;
  return (
    <Card className="p-4" data-testid="viewer-emails">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Mail className="h-4 w-4 text-slate-400" /> Viewer emails <span className="font-normal text-slate-500" data-testid="viewer-email-count">· {leads.length}</span>
        </h3>
        {leads.length > 0 && (
          <a href={`/api/videos/${videoId}/leads?format=csv`} download className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
            <Download className="h-3.5 w-3.5" /> Download CSV
          </a>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {gateOn ? "The share page asks each viewer for an email before the video plays." : "The share page no longer asks; these are the emails it collected."}
      </p>
      {leads.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-sm" data-testid="viewer-email-list">
          {leads.slice(0, 10).map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate text-slate-800">
                {l.email}
                {l.name ? <span className="text-slate-500"> · {l.name}</span> : null}
              </span>
              <span className="shrink-0 text-xs text-slate-500">
                {formatDate(l.createdAt)}
                {l.visits > 1 ? ` · ${l.visits} visits` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {leads.length > 10 && <p className="mt-2 text-xs text-slate-500">And {leads.length - 10} more in the CSV.</p>}
    </Card>
  );
}
