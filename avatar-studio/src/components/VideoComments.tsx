"use client";
import { useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import type { VideoComment } from "@/lib/types";

/** Review notes on a video for the owner and workspace members; each author can remove their own. */
export function VideoComments({ videoId }: { videoId: string }) {
  const { data, refetch } = useApi<{ comments: VideoComment[] }>(`/api/videos/${videoId}/comments`);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const comments = data?.comments ?? [];

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
        <textarea aria-label="New comment" value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={1000} placeholder="Leave a note for the team" className={inputClass} />
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
