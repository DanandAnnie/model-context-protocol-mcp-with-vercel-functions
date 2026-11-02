"use client";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, CornerDownRight, MessageSquare, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import { formatTimestamp } from "@/lib/text";
import { refocusIfLost } from "@/lib/focus";
import { repliesByThread, splitComments } from "@/lib/comment-list";
import type { VideoComment, WorkspaceRole } from "@/lib/types";

const LINK_GONE = "The comment this link points to is no longer here; it may have been deleted.";

/** A note as the list returns it: `mine` marks the caller's own, which they can edit and delete. */
type Note = VideoComment & { mine?: boolean };

interface WorkspaceSummary {
  personalId: string;
  activeId: string;
  workspaces: Array<{ id: string; members: Array<{ userId: string; email?: string; role: WorkspaceRole; you?: boolean }> }>;
}

/**
 * Review notes on a video for the owner and workspace members; each author can remove their own. With the
 * page's player, a note can be pinned to the moment the player is at when the box is ticked, and a pinned
 * note's time moves the player there. Anyone who can comment marks a note resolved once it is dealt with;
 * resolved notes fold away under the open ones and can be reopened. Authors edit and delete their own notes. A note
 * that starts a thread can be answered; replies sit under it and are resolved, reopened, and deleted with it.
 */
export function VideoComments({ videoId, player }: { videoId: string; player?: RefObject<HTMLVideoElement | null> }) {
  const { data, error: loadErr, refetch } = useApi<{ comments: Note[] }>(`/api/videos/${videoId}/comments`);
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
  const replies = repliesByThread(comments);
  const [showResolved, setShowResolved] = useState(false);
  // With nothing resolved the toggle goes, so the next note resolved starts folded again.
  if (showResolved && resolved.length === 0) setShowResolved(false);
  // Said to a screen reader after a note is resolved or reopened, as the note leaves where the focus was.
  const [status, setStatus] = useState("");
  // Cleared first, so the same message twice in a row is still spoken the second time.
  const announce = (message: string) => {
    setStatus("");
    window.setTimeout(() => setStatus(message), 50);
  };
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
  // A comment email links here with ?comment=<id> (the note that starts the thread): once the notes are in,
  // that thread is shown (a resolved one unfolded), scrolled to, focused, and marked for a few seconds. The
  // parameter is taken off the address so a reload does not do it again. A link to a reply finds its thread.
  const [linked, setLinked] = useState<string | null>(null);
  // The thread focused from the link stays focusable until the focus leaves it, after its mark has faded.
  const [linkFocus, setLinkFocus] = useState<string | null>(null);
  const [linkedGone, setLinkedGone] = useState(false);
  const linkTarget = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (linkTarget.current === undefined) {
      const url = new URL(window.location.href);
      linkTarget.current = url.searchParams.get("comment");
      if (linkTarget.current !== null) {
        url.searchParams.delete("comment");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    }
    const id = linkTarget.current;
    if (!id || !data) return;
    linkTarget.current = null;
    const hit = data.comments.find((c) => c.id === id);
    const thread = hit?.parentId ? (data.comments.find((c) => c.id === hit.parentId) ?? hit) : hit;
    if (!thread) {
      setLinkedGone(true);
      announce(LINK_GONE);
      return;
    }
    if (thread.resolvedAt) setShowResolved(true);
    setLinked(thread.id);
    setLinkFocus(thread.id);
  }, [data]);
  useEffect(() => {
    if (!linked) return;
    const el = card.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(linked)}"]`);
    el?.scrollIntoView({ block: "center" });
    el?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setLinked(null), 6000);
    return () => window.clearTimeout(timer);
  }, [linked]);
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
      announce(value ? `Comment resolved${open.length > 1 ? `; ${open.length - 1} open` : "; none open"}` : "Comment reopened");
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : value ? "Could not resolve the comment" : "Could not reopen the comment");
      // A note deleted meanwhile drops out of the list rather than keeping a button that always fails.
      await refetch();
    } finally {
      setActing(null);
    }
  }

  // The note whose text is being changed, with the text as typed so far. Leaving the form (saved or not)
  // hands the focus back to that note's Edit button.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // The note whose Edit button takes the focus once its form has gone: at once after Cancel (the box that had
  // it is gone), and after a save only if the person has not moved on meanwhile.
  const editFocus = useRef<{ id: string; force: boolean } | null>(null);
  useEffect(() => {
    const target = editFocus.current;
    if (!target || editing?.id === target.id) return;
    editFocus.current = null;
    const el = card.current?.querySelector<HTMLElement>(`[data-comment-edit="${target.id}"]`);
    if (target.force) el?.focus();
    else refocusIfLost(el);
  }, [editing, data]);
  // A note deleted or gone from the list (in another tab, say) takes its open form with it.
  useEffect(() => {
    if (editing && data && !data.comments.some((c) => c.id === editing.id)) setEditing(null);
  }, [data, editing]);
  const cancelEdit = () => {
    if (editing) editFocus.current = { id: editing.id, force: true };
    setEditing(null);
  };
  async function saveEdit() {
    if (!editing || saving) return;
    const { id } = editing;
    const text = editing.text.trim();
    if (!text) return;
    setSaving(true);
    setErr(null);
    try {
      await api(`/api/videos/${videoId}/comments/${id}`, { method: "PATCH", body: JSON.stringify({ text }) });
      // Another note's form, opened while this one saved, stays open.
      setEditing((cur) => {
        if (cur?.id !== id) return cur;
        editFocus.current = { id, force: false };
        return null;
      });
      announce("Comment saved");
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the comment");
      // A note deleted or changed meanwhile is shown as it now is.
      await refetch();
    } finally {
      setSaving(false);
    }
  }

  // The thread being answered, with the reply as typed so far. Leaving the form hands the focus back to its Reply
  // button: at once on Cancel, and after posting only if the person has not moved on meanwhile.
  const [replying, setReplying] = useState<{ id: string; text: string } | null>(null);
  const [postingReply, setPostingReply] = useState(false);
  const replyFocus = useRef<{ id: string; force: boolean } | null>(null);
  useEffect(() => {
    const target = replyFocus.current;
    // A Cancel or a post waits for its form to close; a delete's target is taken whatever is open.
    if (!target || (target.force && replying?.id === target.id)) return;
    replyFocus.current = null;
    // A resolved thread, or one whose reply form is open, has no Reply button: its own action button, else the
    // comment box, takes the focus instead.
    const el = card.current?.querySelector<HTMLElement>(`[data-comment-reply="${target.id}"]`) ?? card.current?.querySelector<HTMLElement>(`[data-comment-action="${target.id}"]`) ?? box.current;
    if (target.force) el?.focus();
    else refocusIfLost(el);
  }, [replying, data]);
  // A thread resolved or deleted (here or in another tab) takes its open reply form with it.
  useEffect(() => {
    if (replying && data && !data.comments.some((c) => c.id === replying.id && !c.resolvedAt)) setReplying(null);
  }, [data, replying]);
  const cancelReply = () => {
    if (replying) replyFocus.current = { id: replying.id, force: true };
    setReplying(null);
  };
  async function postReply() {
    if (!replying || postingReply) return;
    const { id } = replying;
    const text = replying.text.trim();
    if (!text) return;
    setPostingReply(true);
    setErr(null);
    try {
      await api(`/api/videos/${videoId}/comments`, { method: "POST", body: JSON.stringify({ text, parentId: id }) });
      setReplying((cur) => {
        if (cur?.id !== id) return cur;
        replyFocus.current = { id, force: false };
        return null;
      });
      announce("Reply posted");
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not post the reply");
      await refetch();
    } finally {
      setPostingReply(false);
    }
  }

  async function remove(c: VideoComment) {
    // A note that starts a thread takes its replies with it, whoever wrote them; say so first.
    const answers = c.parentId ? 0 : (replies.get(c.id)?.length ?? 0);
    if (answers && !window.confirm(`Delete this comment and its ${answers === 1 ? "reply" : `${answers} replies`}? This cannot be undone.`)) return;
    setErr(null);
    try {
      // The server refuses (409) if the thread was answered since: those replies were not seen, so not agreed to.
      await api(`/api/videos/${videoId}/comments/${c.id}${c.parentId ? "" : `?replies=${answers}`}`, { method: "DELETE" });
      announce(c.parentId ? "Reply deleted" : answers ? `Comment and ${answers === 1 ? "its reply" : `its ${answers} replies`} deleted` : "Comment deleted");
      // A deleted reply hands the focus to its thread's Reply button, a deleted thread to the comment box.
      if (c.parentId) replyFocus.current = { id: c.parentId, force: false };
      await refetch();
      if (!c.parentId) refocusIfLost(box.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove the comment");
      // A thread answered meanwhile (409) or a note already gone is shown as it now is.
      await refetch();
    }
  }

  const excerpt = (c: VideoComment) => c.text.slice(0, 60);
  // A note and, for one that starts a thread, its replies and the way to answer it (open threads only).
  const row = (c: Note, action: ReactNode, reply = false): ReactNode => (
    <li
      key={c.id}
      className={`${reply ? "py-1.5 text-sm" : "py-2 text-sm"}${linked === c.id ? " -mx-2 rounded-lg bg-amber-50 px-2 outline-none ring-2 ring-amber-300" : linkFocus === c.id ? " -mx-2 rounded-lg px-2 outline-none focus:ring-2 focus:ring-slate-300" : ""}`}
      data-testid={reply ? "comment-reply" : undefined}
      data-comment-id={c.id}
      data-linked={linked === c.id || undefined}
      tabIndex={linkFocus === c.id ? -1 : undefined}
      onBlur={linkFocus === c.id ? (e) => e.target === e.currentTarget && setLinkFocus(null) : undefined}
    >
     <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-500">
          {c.authorEmail ?? "You"} · {formatDate(c.createdAt)}
          {c.editedAt && (
            <span title={`Edited ${formatDate(c.editedAt)}`} data-testid="comment-edited">
              {" "}
              · edited
            </span>
          )}
        </div>
        {editing?.id === c.id ? (
          <form
            className="mt-1 space-y-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
          >
            <textarea
              autoFocus
              aria-label="Edit comment"
              value={editing.text}
              readOnly={saving}
              onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                cancelEdit();
              }}
              rows={2}
              maxLength={1000}
              className={inputClass}
            />
            <div className="flex items-center gap-2">
              <Button type="submit" className="px-3 py-1 text-xs" loading={saving} disabled={!editing.text.trim()}>
                Save
              </Button>
              <Button type="button" variant="secondary" className="px-3 py-1 text-xs" onClick={cancelEdit}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
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
        )}
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
      {/* While its text, or one of its replies, is being changed, a note is not resolved or deleted from under the form. */}
      {editing?.id !== c.id && !replies.get(c.id)?.some((r) => r.id === editing?.id) && (
        <div className="flex shrink-0 items-center gap-0.5">
          {action}
          {c.mine && (
            <button type="button" onClick={() => setEditing({ id: c.id, text: c.text })} data-comment-edit={c.id} aria-label={`Edit comment: ${excerpt(c)}`} title="Change this comment's text" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {c.mine && (
            <button type="button" onClick={() => remove(c)} aria-label={`Delete comment: ${excerpt(c)}`} title="Remove this comment" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
     </div>
      {!reply && (replies.get(c.id)?.length ?? 0) > 0 && (
        <ul className="ml-2 mt-1 divide-y divide-slate-100 border-l-2 border-slate-100 pl-3" aria-label={`Replies to: ${excerpt(c)}`}>
          {replies.get(c.id)!.map((r) => row(r, null, true))}
        </ul>
      )}
      {/* A reply whose note is gone is listed on its own, but there is no thread to answer. */}
      {!reply && !c.resolvedAt && !c.parentId && (
        replying?.id === c.id ? (
          <form
            className="ml-2 mt-1.5 space-y-1.5 border-l-2 border-slate-100 pl-3"
            onSubmit={(e) => {
              e.preventDefault();
              void postReply();
            }}
          >
            <textarea
              autoFocus
              aria-label={`Reply to: ${excerpt(c)}`}
              value={replying.text}
              readOnly={postingReply}
              onChange={(e) => setReplying({ id: c.id, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                cancelReply();
              }}
              rows={2}
              maxLength={1000}
              className={inputClass}
            />
            <div className="flex items-center gap-2">
              <Button type="submit" className="px-3 py-1 text-xs" loading={postingReply} disabled={!replying.text.trim()}>
                Post reply
              </Button>
              <Button type="button" variant="secondary" className="px-3 py-1 text-xs" onClick={cancelReply}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setReplying({ id: c.id, text: "" })} data-comment-reply={c.id} aria-label={`Reply to comment: ${excerpt(c)}`} className="ml-2 mt-1 inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
            <CornerDownRight className="h-3.5 w-3.5" /> Reply
          </button>
        )
      )}
    </li>
  );
  const actionClass = "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 aria-disabled:opacity-50";

  return (
    <Card className="p-4" data-testid="comments">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <MessageSquare className="h-4 w-4 text-slate-400" /> Comments
        {open.length + resolved.length ? (resolved.length ? ` · ${open.length} open, ${resolved.length} resolved` : ` · ${open.length}`) : ""}
      </h3>
      <p className="mt-1 text-xs text-slate-500">Notes for you and your workspace; viewers of the share page never see them.</p>
      {/* Said to a screen reader through the card's status line, which is there from the start. */}
      {linkedGone && (
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="comment-link-gone">
          {LINK_GONE}
        </p>
      )}
      <div ref={card}>
      {open.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100" data-testid="comment-list">
          {open.map((c) =>
            row(
              c,
              <button type="button" onClick={() => setResolved(c, true)} aria-disabled={acting !== null || undefined} data-comment-action={c.id} aria-label={`Resolve comment: ${excerpt(c)}`} title="Mark this note as dealt with" className={actionClass}>
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
                <button type="button" onClick={() => setResolved(c, false)} aria-disabled={acting !== null || undefined} data-comment-action={c.id} aria-label={`Reopen comment: ${excerpt(c)}`} title="Mark this note as open again" className={actionClass}>
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
