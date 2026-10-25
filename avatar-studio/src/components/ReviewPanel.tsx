"use client";
import { useState } from "react";
import { BadgeCheck, MessageSquareWarning, Send, Undo2 } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { useWorkspaceRole } from "@/hooks/useCanEdit";
import { api, formatDate } from "@/lib/client";
import { roleCanEdit } from "@/lib/roles";
import { REVIEW_LABEL, type Video } from "@/lib/types";

/**
 * Review and approval for a workspace video: editors ask for a review, workspace owners approve or
 * ask for changes. The server enforces who may do what; this panel only offers what applies.
 */
export function ReviewPanel({ video, onChange }: { video: Video; onChange: (video: Video) => void }) {
  const who = useWorkspaceRole();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Reviews belong to a workspace, and only while that workspace is the one open.
  if (!who || !who.workspaceId || who.workspaceId !== video.ownerId || video.deletedAt) return null;
  const canEdit = roleCanEdit(who.role);
  const isOwner = who.role === "owner";
  const review = video.review;
  const pending = review?.status === "pending";
  const mayWithdraw = pending && (isOwner || review?.requestedById === who.userId);

  async function send(action: "request" | "approve" | "changes" | "withdraw") {
    setBusy(action);
    setErr(null);
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}/review`, { method: "POST", body: JSON.stringify({ action, ...(note.trim() ? { note: note.trim() } : {}) }) });
      setNote("");
      onChange(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not update the review");
    } finally {
      setBusy(null);
    }
  }

  const person = (email?: string, id?: string) => (id && id === who.userId ? "you" : email ?? "a member");
  return (
    <Card className="p-4" data-testid="review-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Review</h3>
        {review && (
          <span data-testid="review-status" className={`rounded-full px-2 py-0.5 text-xs font-medium ${review.status === "approved" ? "bg-emerald-50 text-emerald-800" : review.status === "changes" ? "bg-amber-50 text-amber-900" : "bg-brand-50 text-brand-800"}`}>
            {REVIEW_LABEL[review.status]}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-600">
        {!review
          ? "Ask a workspace owner to approve this video before it is shared."
          : review.status === "pending"
            ? `Asked by ${person(review.requestedByEmail, review.requestedById)} on ${formatDate(review.requestedAt)}.`
            : `${review.status === "approved" ? "Approved" : "Changes asked for"} by ${person(review.decidedByEmail, review.decidedById)}${review.decidedAt ? ` on ${formatDate(review.decidedAt)}` : ""}.`}
      </p>
      {review?.note && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="review-note">{review.note}</p>}
      <ErrorBanner message={err} />
      {(canEdit && !pending) || (pending && (isOwner || mayWithdraw)) ? (
        <div className="mt-3 space-y-2">
          {(isOwner && pending) || (canEdit && !pending) ? (
            <textarea
              aria-label="Review note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder={pending ? "What should change? (needed to ask for changes)" : "Anything the reviewer should know? (optional)"}
              className={`${inputClass} text-sm`}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canEdit && !pending && (
              <Button className="px-3 py-1.5 text-xs" onClick={() => send("request")} loading={busy === "request"} disabled={!!busy}>
                <Send className="h-3.5 w-3.5" /> {review ? "Ask for review again" : "Ask for review"}
              </Button>
            )}
            {isOwner && pending && (
              <>
                <Button className="px-3 py-1.5 text-xs" onClick={() => send("approve")} loading={busy === "approve"} disabled={!!busy}>
                  <BadgeCheck className="h-3.5 w-3.5" /> Approve
                </Button>
                <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => send("changes")} loading={busy === "changes"} disabled={!!busy || !note.trim()}>
                  <MessageSquareWarning className="h-3.5 w-3.5" /> Ask for changes
                </Button>
              </>
            )}
            {mayWithdraw && (
              <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => send("withdraw")} loading={busy === "withdraw"} disabled={!!busy}>
                <Undo2 className="h-3.5 w-3.5" /> Withdraw
              </Button>
            )}
          </div>
        </div>
      ) : pending ? (
        <p className="mt-2 text-xs text-slate-500">Waiting for a workspace owner.</p>
      ) : null}
    </Card>
  );
}
