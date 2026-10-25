"use client";
import { useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import type { VideoComment, WorkspaceRole } from "@/lib/types";

interface WorkspaceSummary {
  personalId: string;
  activeId: string;
  workspaces: Array<{ id: string; members: Array<{ userId: string; email?: string; role: WorkspaceRole; you?: boolean }> }>;
}

/** Review notes on a video for the owner and workspace members; each author can remove their own. */
export function VideoComments({ videoId }: { videoId: string }) {
  const { data, refetch } = useApi<{ comments: VideoComment[] }>(`/api/videos/${videoId}/comments`);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const comments = data?.comments ?? [];
  // Teammates who can be mentioned: the open workspace's other members with an email.
  const { data: summary } = useApi<WorkspaceSummary>("/api/workspaces");
  const teammates = (summary?.workspaces.find((w) => w.id === summary.activeId && w.id !== summary.personalId)?.members ?? []).filter((m) => m.email && !m.you);
  const mention = (email: string) => setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@${email} `);

  async function post() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/videos/${videoId}/comments`, { method: "POST", body: JSON.stringify({ text }) });
      setDraft("");
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not post the comment");
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: VideoComment) {
    setErr(null);
    try {
      await api(`/api/videos/${videoId}/comments/${c.id}`, { method: "DELETE" });
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove the comment");
    }
  }

  return (
    <Card className="p-4" data-testid="comments">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <MessageSquare className="h-4 w-4 text-slate-400" /> Comments{comments.length ? ` · ${comments.length}` : ""}
      </h3>
      <p className="mt-1 text-xs text-slate-500">Notes for you and your workspace; viewers of the share page never see them.</p>
      {comments.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100" data-testid="comment-list">
          {comments.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="text-xs text-slate-500">
                  {c.authorEmail ?? "You"} · {formatDate(c.createdAt)}
                </div>
                <p className="whitespace-pre-wrap text-slate-800">{c.text}</p>
                {c.mentions?.length ? (
                  <div className="mt-0.5 text-xs text-slate-500" data-testid="comment-mentions">
                    Notified {c.mentions.map((m) => m.email).join(", ")}
                  </div>
                ) : null}
              </div>
              <button type="button" onClick={() => remove(c)} aria-label="Delete comment" title="Remove this comment" className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void post();
        }}
      >
        <textarea aria-label="New comment" value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={1000} placeholder={teammates.length ? "Leave a note for the team; type @ and a teammate's email to notify them" : "Leave a note for the team"} className={inputClass} />
        {teammates.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500" data-testid="mention-suggestions">
            <span>Mention:</span>
            {teammates.slice(0, 8).map((m) => (
              <button key={m.userId} type="button" onClick={() => mention(m.email!)} className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-600 hover:bg-slate-50">
                @{m.email}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" className="px-3 py-1.5 text-xs" loading={busy} disabled={!draft.trim()}>
            Post comment
          </Button>
          {err && <span className="text-xs text-rose-600">{err}</span>}
        </div>
      </form>
    </Card>
  );
}
