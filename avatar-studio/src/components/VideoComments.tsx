"use client";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import { formatTimestamp } from "@/lib/text";
import { refocusIfLost } from "@/lib/focus";
import { splitComments } from "@/lib/comment-list";
import type { VideoComment, WorkspaceRole } from "@/lib/types";

interface WorkspaceSummary {
  personalId: string;
  activeId: string;
  workspaces: Array<{ id: string; members: Array<{ userId: string; email?: string; role: WorkspaceRole; you?: boolean }> }>;
}

/**
 * Review notes on a video for the owner and workspace members; each author can remove their own. With the
 * page's player, a note can be pinned to the moment the player is at when the box is ticked, and a pinned
 * note's time moves the player there. Anyone who can comment marks a note resolved once it is dealt with;
 * resolved notes fold away under the open ones and can be reopened.
 */
export function VideoComments({ videoId, player }: { videoId: string; player?: RefObject<HTMLVideoElement | null> }) {
  const { data, error: loadErr, refetch } = useApi<{ comments: VideoComment[] }>(`/api/videos/${videoId}/comments`);
  const [draft, setDraft] = useState("");
  // The player's time in whole seconds (null without a player), followed here rather than on the page so
  // playback re-renders only this card; and the moment taken when the box was ticked, which playing on keeps.
  const [playerTime, setPlayerTime] = useState<number | null>(null);
  const [pinAt, setPinAt] = useState<number | null>(null);
  const hasPlayer = !!player;
  useEffect(() => {
    const el = player?.current;
    if (!el) {
      setPlayerTime(null);
      setPinAt(null);
      return;
    }
    const read = () => setPlayerTime(Math.floor(el.currentTime));
    read();
    const events = ["timeupdate", "seeked", "loadedmetadata"] as const;
    for (const e of events) el.addEventListener(e, read);
    return () => {
      for (const e of events) el.removeEventListener(e, read);
    };
  }, [player, hasPlayer]);
  const seek = (sec: number) => {
    const el = player?.current;
    if (!el) return;
    el.currentTime = sec;
    el.focus();
  };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const comments = data?.comments ?? [];
  const { open, resolved } = splitComments(comments);
  const [showResolved, setShowResolved] = useState(false);
  // With nothing resolved the toggle goes, so the next note resolved starts folded again.
  if (showResolved && resolved.length === 0) setShowResolved(false);
  // Said to a screen reader after a note is resolved or reopened, as the note leaves where the focus was.
  const [status, setStatus] = useState("");
  // The note being resolved or reopened, so a second press waits for the first.
  const [acting, setActing] = useState<string | null>(null);
  // Teammates who can be mentioned: the open workspace's other members with an email.
  const { data: summary } = useApi<WorkspaceSummary>("/api/workspaces");
  const teammates = (summary?.workspaces.find((w) => w.id === summary.activeId && w.id !== summary.personalId)?.members ?? []).filter((m) => m.email && !m.you);
  // A chip completes an "@" or "@partial" the person already typed, else starts a new mention; the box's limit still holds.
  const mention = (email: string) =>
    setDraft((d) => {
      const base = d.replace(/(^|\s)@[^\s@]*$/, "$1");
      return `${base}${base && !/\s$/.test(base) ? " " : ""}@${email} `.slice(0, 1000);
    });

  // After posting or deleting, the focus goes to the comment box: the button pressed is disabled or gone.
  const box = useRef<HTMLTextAreaElement>(null);
  async function post() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/videos/${videoId}/comments`, { method: "POST", body: JSON.stringify({ text, ...(pinAt !== null ? { atSec: pinAt } : {}) }) });
      setDraft("");
      setPinAt(null);
      await refetch();
      refocusIfLost(box.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not post the comment");
    } finally {
      setBusy(false);
    }
  }

  // A resolved note leaves the open list, taking its button with it: the focus goes on to the next open
  // note's Resolve (else the one before, else the resolved notes' toggle), so a list can be worked through
  // from the keyboard. A reopened note's Resolve button takes the focus back.
  const card = useRef<HTMLDivElement>(null);
  // Where the focus goes once the list has been drawn again: a note's action button, or the toggle (null).
  const focusNext = useRef<{ id: string | null } | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (!target || !card.current) return;
    const el = card.current.querySelector<HTMLElement>(target.id ? `[data-comment-action="${target.id}"]` : "[data-resolved-toggle]");
    refocusIfLost(el);
  }, [data]);
  // A reload that failed leaves the list as it was: no focus is moved later on its account.
  useEffect(() => {
    if (loadErr) focusNext.current = null;
  }, [loadErr]);
  async function setResolved(c: VideoComment, value: boolean) {
    if (acting) return;
    setActing(c.id);
    setErr(null);
    const i = open.findIndex((o) => o.id === c.id);
    const next = value ? (open[i + 1] ?? open[i - 1])?.id : c.id;
    try {
      await api(`/api/videos/${videoId}/comments/${c.id}`, { method: "PATCH", body: JSON.stringify({ resolved: value }) });
      focusNext.current = { id: next ?? null };
      setStatus(value ? `Comment resolved${open.length > 1 ? `; ${open.length - 1} open` : "; none open"}` : "Comment reopened");
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : value ? "Could not resolve the comment" : "Could not reopen the comment");
      // A note deleted meanwhile drops out of the list rather than keeping a button that always fails.
      await refetch();
    } finally {
      setActing(null);
    }
  }

  async function remove(c: VideoComment) {
    setErr(null);
    try {
      await api(`/api/videos/${videoId}/comments/${c.id}`, { method: "DELETE" });
      await refetch();
      refocusIfLost(box.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove the comment");
    }
  }

  const row = (c: VideoComment, action: ReactNode) => (
    <li key={c.id} className="flex items-start justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="text-xs text-slate-500">
          {c.authorEmail ?? "You"} · {formatDate(c.createdAt)}
        </div>
        <p className={`whitespace-pre-wrap ${c.resolvedAt ? "text-slate-500" : "text-slate-800"}`}>
          {c.atSec !== undefined &&
            (playerTime !== null ? (
              <button
                type="button"
                onClick={() => seek(c.atSec!)}
                aria-label={`Go to ${formatTimestamp(c.atSec)} in the video`}
                className="mr-1.5 rounded bg-brand-50 px-1.5 py-0.5 align-baseline font-mono text-xs font-medium text-brand-700 hover:bg-brand-100"
                data-testid="comment-time"
              >
                {formatTimestamp(c.atSec)}
              </button>
            ) : (
              <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600" data-testid="comment-time">
                {formatTimestamp(c.atSec)}
              </span>
            ))}
          {c.text}
        </p>
        {c.mentions?.length ? (
          <div className="mt-0.5 text-xs text-slate-500" data-testid="comment-mentions">
            Mentioned {c.mentions.map((m) => m.email).join(", ")}
          </div>
        ) : null}
        {c.resolvedAt && (
          <div className="mt-0.5 text-xs text-slate-500" data-testid="comment-resolved-by">
            Resolved by {c.resolvedByEmail ?? "you"} · {formatDate(c.resolvedAt)}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {action}
        <button type="button" onClick={() => remove(c)} aria-label="Delete comment" title="Remove this comment" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
  const actionClass = "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 aria-disabled:opacity-50";

  return (
    <Card className="p-4" data-testid="comments">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <MessageSquare className="h-4 w-4 text-slate-400" /> Comments
        {comments.length ? (resolved.length ? ` · ${open.length} open, ${resolved.length} resolved` : ` · ${comments.length}`) : ""}
      </h3>
      <p className="mt-1 text-xs text-slate-500">Notes for you and your workspace; viewers of the share page never see them.</p>
      <div ref={card}>
      {open.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100" data-testid="comment-list">
          {open.map((c) =>
            row(
              c,
              <button type="button" onClick={() => setResolved(c, true)} aria-disabled={acting !== null || undefined} data-comment-action={c.id} aria-label={`Resolve comment: ${c.text.slice(0, 60)}`} title="Mark this note as dealt with" className={actionClass}>
                <Check className="h-3.5 w-3.5" /> Resolve
              </button>,
            ),
          )}
        </ul>
      )}
      {open.length === 0 && resolved.length > 0 && <p className="mt-3 text-sm text-slate-500">Every comment is resolved.</p>}
      {resolved.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            data-resolved-toggle
            aria-expanded={showResolved}
            aria-controls={`resolved-comments-${videoId}`}
            onClick={() => setShowResolved((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg px-1 py-0.5 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showResolved ? "rotate-180" : ""}`} />
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
          <ul id={`resolved-comments-${videoId}`} hidden={!showResolved} className="mt-1 divide-y divide-slate-100" data-testid="resolved-comment-list">
            {resolved.map((c) =>
              row(
                c,
                <button type="button" onClick={() => setResolved(c, false)} aria-disabled={acting !== null || undefined} data-comment-action={c.id} aria-label={`Reopen comment: ${c.text.slice(0, 60)}`} title="Mark this note as open again" className={actionClass}>
                  <RotateCcw className="h-3.5 w-3.5" /> Reopen
                </button>,
              ),
            )}
          </ul>
        </div>
      )}
      </div>
      <p className="sr-only" role="status">
        {status}
      </p>
      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void post();
        }}
      >
        <textarea ref={box} aria-label="New comment" value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={1000} placeholder={teammates.length ? "Leave a note for the team; type @ and a teammate's email to notify them" : "Leave a note for the team"} className={inputClass} />
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
        {playerTime !== null && (
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={pinAt !== null} onChange={(e) => setPinAt(e.target.checked ? playerTime : null)} className="h-3.5 w-3.5 rounded border-slate-300" />
            Pin to {formatTimestamp(pinAt ?? playerTime)} in the video
          </label>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" className="px-3 py-1.5 text-xs" loading={busy} disabled={!draft.trim()}>
            Post comment
          </Button>
          {(err ?? loadErr) && <span className="text-xs text-rose-600">{err ?? loadErr}</span>}
        </div>
      </form>
    </Card>
  );
}
