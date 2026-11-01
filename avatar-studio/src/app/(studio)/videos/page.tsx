"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ArchiveRestore, CheckSquare, Clapperboard, Clock, Download, FolderInput, FolderMinus, FolderPen, Link2, Link2Off, TimerOff, Trash2, X } from "lucide-react";
import { api } from "@/lib/client";
import { VideoCard } from "@/components/VideoCard";
import { Button, EmptyState, ErrorBanner, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useWorkspaceRole } from "@/hooks/useCanEdit";
import type { VideoPage, VideoQuery } from "@/lib/services/videos";
import { TRASH_RETENTION_DAYS, type VideoStatus } from "@/lib/types";

const STATUSES: Array<"all" | VideoStatus> = ["all", "processing", "completed", "failed"];
type SortKey = VideoQuery["sort"];
/** Cards per request; "Show more" asks for another page's worth. */
const PAGE = 48;

/** A time as a datetime-local field holds it: the browser's local date and time, to the minute. */
function localMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type BulkAction = "delete" | "move" | "share-off" | "share-on" | "schedule" | "golive" | "expire" | "noexpiry" | "restore" | "purge" | "links";

export default function VideosPage() {
  return (
    <Suspense>
      <VideosInner />
    </Suspense>
  );
}

function VideosInner() {
  const params = useSearchParams();
  const batch = params.get("batch");
  const skipped = Number(params.get("skipped") ?? 0);
  const failedCount = Number(params.get("failed") ?? 0);
  const [q, setQ] = useState("");
  const [needle, setNeedle] = useState("");
  const [status, setStatus] = useState<"all" | VideoStatus>("all");
  const [folder, setFolder] = useState<string>("all"); // "all" | "unfiled" | folder name
  const [sort, setSort] = useState<SortKey>("newest");
  // Reviews exist only in a workspace, so the filter shows there.
  const inWorkspace = !!useWorkspaceRole()?.workspaceId;
  const [review, setReview] = useState<VideoQuery["review"]>("all");
  // Share link state, as the cards' badges say; with the bulk go-live and expiry it finds a campaign's links to fix.
  const [share, setShare] = useState<VideoQuery["share"]>("all");
  // The trash is its own view of the same page: same search, status, and folder filters, different bulk actions.
  const [trash, setTrash] = useState(false);
  // Search as you type, one request per pause rather than per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setNeedle(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  // "Show more" extends the page for the current filters only: a new filter starts again
  // from the first page in the same render, with no extra request for the old extent.
  const filterKey = [needle, status, folder, batch ?? "", sort, trash ? "trash" : "", review, share].join("\u0000");
  const [extent, setExtent] = useState({ key: filterKey, limit: PAGE });
  const limit = extent.key === filterKey ? extent.limit : PAGE;
  const path = useMemo(() => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (needle) params.set("q", needle);
    if (status !== "all") params.set("status", status);
    if (folder === "unfiled") params.set("folder", "");
    else if (folder !== "all") params.set("folder", folder);
    if (batch) params.set("batch", batch);
    if (sort !== "newest") params.set("sort", sort);
    if (trash) params.set("trash", "true");
    if (review !== "all") params.set("review", review);
    if (share !== "all") params.set("share", share);
    return `/api/videos?${params}`;
  }, [limit, needle, status, folder, batch, sort, trash, review, share]);
  // The filtering, sorting, and paging happen on the server; the page only holds what it shows.
  const { data, loading, error, refetch } = useApi<VideoPage>(path, { pollMs: 6000, pollWhile: (d) => d.rendering > 0 });
  const videos = data?.videos ?? [];
  const folders = data?.folders ?? [];
  const hasAny = (data?.total ?? 0) > 0 || (data?.trashed ?? 0) > 0;
  const trashed = data?.trashed ?? 0;
  const remaining = data ? data.matched - videos.length : 0;

  // Multi-select: move the chosen videos to a folder or delete them in one request.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  // "Schedule go-live" and "Set expiry" open a date and time field in the bar, one at a time; it is a local time, sent as an instant.
  const [timeField, setTimeField] = useState<"golive" | "expiry" | null>(null);
  const [timeDraft, setTimeDraft] = useState("");
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
    setTimeField(null);
    setTimeDraft("");
  }
  // Folder management: rename the chosen folder (merging into an existing name) or remove it, leaving its videos unfiled.
  const [folderBusy, setFolderBusy] = useState(false);
  async function manageFolder(remove: boolean) {
    if (folder === "all" || folder === "unfiled") return;
    let to = "";
    if (remove) {
      if (!window.confirm(`Remove the folder "${folder}"? Its videos stay in the library as unfiled.`)) return;
    } else {
      const answer = window.prompt("New folder name", folder);
      if (answer === null) return;
      to = answer.trim();
      if (!to || to === folder) return;
    }
    setFolderBusy(true);
    setBulkErr(null);
    try {
      await api("/api/videos/folders", { method: "POST", body: JSON.stringify({ from: folder, to }) });
      setFolder(to || "all");
      await refetch();
    } catch (e) {
      setBulkErr(e instanceof Error ? e.message : "Could not update the folder");
    } finally {
      setFolderBusy(false);
    }
  }
  // A new filter hides cards; drop the selection so bulk actions only ever touch what is visible.
  useEffect(() => {
    setSelected(new Set());
    setTimeField(null);
    setTimeDraft("");
  }, [q, status, folder, batch, trash, review, share]);
  // The last purge empties both views; leave the trash so the "No videos yet" state (and the filter bar) comes back.
  useEffect(() => {
    if (trash && data && data.total === 0 && data.trashed === 0) setTrash(false);
  }, [data, trash]);
  async function bulk(action: BulkAction) {
    const ids = Array.from(selected);
    if (!ids.length) return;
    let targetFolder: string | undefined;
    if (action === "move") {
      const answer = window.prompt("Folder name (leave empty to move to Unfiled)", "");
      if (answer === null) return;
      targetFolder = answer;
    } else if (action === "delete" && !window.confirm(`Move ${ids.length} ${ids.length === 1 ? "video" : "videos"} to the trash? You can restore ${ids.length === 1 ? "it" : "them"} for ${TRASH_RETENTION_DAYS} days.`)) {
      return;
    } else if (action === "schedule" || action === "expire") {
      const at = new Date(timeDraft);
      if (!timeDraft || Number.isNaN(at.getTime())) return;
      if (at.getTime() <= Date.now()) {
        setBulkErr(action === "schedule" ? "The go-live time must be in the future" : "The expiry must be in the future");
        return;
      }
    } else if (action === "purge" && !window.confirm(`Delete ${ids.length} ${ids.length === 1 ? "video" : "videos"} for good? ${ids.length === 1 ? "Its" : "Their"} short clips, and the cleaned and lip-synced copies made from ${ids.length === 1 ? "it" : "them"}, go too. This cannot be undone.`)) {
      return;
    }
    setBusy(action);
    setBulkErr(null);
    try {
      const body =
        action === "move"
          ? { action, ids, folder: targetFolder }
          : action === "share-off" || action === "share-on"
            ? { action: "share", ids, shareDisabled: action === "share-off" }
            : action === "schedule" || action === "golive"
              ? { action: "schedule", ids, shareStartsAt: action === "golive" ? null : new Date(timeDraft).toISOString() }
              : action === "expire" || action === "noexpiry"
                ? { action: "expire", ids, shareExpiresAt: action === "noexpiry" ? null : new Date(timeDraft).toISOString() }
                : { action, ids };
      const { missing, refused = [] } = await api<{ done: number; missing: string[]; refused?: string[] }>("/api/videos/bulk", { method: "POST", body: JSON.stringify(body) });
      await refetch();
      const notes: string[] = [];
      // A video whose own expiry comes first (or, for an expiry, whose go-live comes at or after it) keeps its link as it was.
      if (refused.length) {
        const one = refused.length === 1;
        notes.push(
          action === "expire"
            ? `${one ? "1 selected video goes" : `${refused.length} selected videos go`} live at or after that time, so ${one ? "it was" : "they were"} not given that expiry and ${one ? "is" : "are"} still selected; set an earlier go-live time on ${one ? "it" : "them"} first.`
            : `${one ? "1 selected video expires" : `${refused.length} selected videos expire`} at or before that time, so ${one ? "it was" : "they were"} not scheduled and ${one ? "is" : "are"} still selected; set a later expiry on ${one ? "it" : "them"} first.`,
        );
      }
      // Videos deleted elsewhere since the page loaded are skipped by the server; say so rather than pretend.
      // For a delete that is the outcome asked for, so it reads as "already deleted" rather than a skip.
      if (missing.length) {
        const which = ids.length === 1 ? "The selected video" : `${missing.length} of the ${ids.length} selected videos`;
        const verb = missing.length === 1 ? "was" : "were";
        notes.push(action === "delete" || action === "purge" ? `${which} had already been deleted.` : `${which} ${verb} no longer there and ${verb} skipped.`);
      }
      if (notes.length) setBulkErr(notes.join(" "));
      if (refused.length) {
        // The refused ones stay selected (with the field open), so they can be found and their expiry moved.
        setSelected(new Set(refused));
        return;
      }
      stopSelecting();
    } catch (e) {
      setBulkErr(e instanceof Error ? e.message : "Could not update the videos");
    } finally {
      setBusy(null);
    }
  }

  // The selection's share links as a CSV to send from: the link where it can be sent now, and why the others are blank.
  // The selection stays, so its links can be fixed (go-live, expiry, links on) and the file downloaded again.
  async function downloadLinks() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBusy("links");
    // A note from an earlier go-live or expiry refusal stays: it names the links to fix, which this file is for checking.
    try {
      const res = await fetch("/api/videos/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }).catch(() => {
        throw new Error("Could not reach the server to download the links");
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not download the links");
      const omitted = Number(res.headers.get("X-Omitted") ?? 0);
      if (omitted > 0) setBulkErr(`${omitted === 1 ? "1 selected video is" : `${omitted} selected videos are`} no longer in the library and ${omitted === 1 ? "was" : "were"} left out of the file.`);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "links.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setBulkErr(e instanceof Error ? e.message : "Could not download the links");
    } finally {
      setBusy(null);
    }
  }

  // The banner stays: after a refusal it says which of the two times to move, which may be the field being opened.
  function openTimeField(kind: "golive" | "expiry") {
    setTimeField(kind);
    setTimeDraft("");
  }
  // The go-live and expiry fields share their shape: a time, a button that sets it, and one that clears it.
  function timeForm(kind: "golive" | "expiry") {
    const golive = kind === "golive";
    const [set, clear] = golive ? (["schedule", "golive"] as const) : (["expire", "noexpiry"] as const);
    return (
      <form
        className="inline-flex flex-wrap items-center gap-1.5"
        data-testid={golive ? "bulk-schedule" : "bulk-expiry"}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void bulk(set);
        }}
      >
        <input
          type="datetime-local"
          aria-label={golive ? "Go-live time for the selected videos" : "Expiry for the selected videos"}
          className={`${inputClass} w-48 py-1 text-xs`}
          value={timeDraft}
          min={localMinute(new Date())}
          onChange={(e) => {
            setTimeDraft(e.target.value);
            setBulkErr(null);
          }}
        />
        <Button
          type="submit"
          variant="secondary"
          className="px-2.5 py-1 text-xs"
          disabled={!selected.size || !timeDraft || busy !== null}
          loading={busy === set}
          title={golive ? "Until this time the share pages, embeds, and email previews of the selected videos answer “not found”" : "From this time the share pages, embeds, and email previews of the selected videos answer “not found”"}
        >
          {golive ? "Schedule" : "Set expiry"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="px-2.5 py-1 text-xs"
          onClick={() => bulk(clear)}
          disabled={!selected.size || busy !== null}
          loading={busy === clear}
          title={golive ? "Clear the go-live time of the selected videos, so their links are live now (unless switched off or expired)" : "Clear the expiry of the selected videos, so their links stay open until switched off"}
        >
          {golive ? "Go live now" : "No expiry"}
        </Button>
        <button
          type="button"
          onClick={() => {
            setTimeField(null);
            setTimeDraft("");
          }}
          disabled={busy !== null}
          aria-label={golive ? "Close go-live time" : "Close expiry"}
          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
    );
  }

  return (
    <>
      <SectionTitle
        title="My videos"
        subtitle="Everything you have rendered. Processing videos update automatically."
        action={
          <Link href="/create" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            New video
          </Link>
        }
      />
      <ErrorBanner message={error ?? bulkErr} />
      {batch && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-900">
          <span>
            Showing one personalized batch{skipped > 0 ? `. ${skipped} ${skipped === 1 ? "row was" : "rows were"} not started because the monthly allowance was reached` : ""}
            {failedCount > 0 ? `. ${failedCount} ${failedCount === 1 ? "render" : "renders"} could not be started; open the failed cards for the provider's message` : ""}.
          </span>
          <span className="flex flex-wrap items-center gap-3">
            <a
              href={`/api/videos/batch/${encodeURIComponent(batch)}`}
              download
              className="font-medium underline hover:no-underline"
              title="Each recipient's row, status, and share link, the link left blank until it can be sent"
            >
              Download links (CSV)
            </a>
            <Link href="/videos" className="font-medium underline hover:no-underline">Show all videos</Link>
          </span>
        </div>
      )}
      {hasAny && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <input aria-label="Search videos" className={`${inputClass} max-w-xs`} placeholder="Search title, description, script, avatar, voice" value={q} onChange={(e) => setQ(e.target.value)} />
          {folders.length > 0 && (
            <select aria-label="Folder" value={folder} onChange={(e) => setFolder(e.target.value)} className={`${inputClass} w-auto`}>
              <option value="all">All folders</option>
              <option value="unfiled">Unfiled</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          {folder !== "all" && folder !== "unfiled" && !trash && (
            <span className="flex gap-1" data-testid="folder-actions">
              <button type="button" onClick={() => manageFolder(false)} disabled={folderBusy} aria-label="Rename folder" title="Rename this folder" className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-50">
                <FolderPen className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => manageFolder(true)} disabled={folderBusy} aria-label="Remove folder" title="Remove this folder; its videos become unfiled" className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-50">
                <FolderMinus className="h-4 w-4" />
              </button>
            </span>
          )}
          <span className="flex-1" />
          {selecting ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1" data-testid="bulk-bar">
              <span className="px-1 text-xs font-medium text-slate-700">{selected.size} selected</span>
              <button type="button" onClick={() => setSelected(new Set(videos.map((v) => v.id)))} disabled={busy !== null} className="text-xs text-brand-700 hover:underline disabled:opacity-50">
                Select all shown
              </button>
              {trash ? (
                <>
                  <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("restore")} disabled={!selected.size || busy !== null} loading={busy === "restore"}>
                    <ArchiveRestore className="h-3.5 w-3.5" /> Restore
                  </Button>
                  <Button variant="danger" className="px-2.5 py-1 text-xs" onClick={() => bulk("purge")} disabled={!selected.size || busy !== null} loading={busy === "purge"}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete forever
                  </Button>
                </>
              ) : (
                <>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void downloadLinks()} disabled={!selected.size || busy !== null} loading={busy === "links"} title="A CSV of the selected videos' share links, each left blank until it can be sent (a render still under way included), with the reason">
                <Download className="h-3.5 w-3.5" /> Download links
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("move")} disabled={!selected.size || busy !== null} loading={busy === "move"}>
                <FolderInput className="h-3.5 w-3.5" /> Move to folder
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("share-off")} disabled={!selected.size || busy !== null} loading={busy === "share-off"} title="The share pages and embeds of the selected videos answer “not found” until turned back on">
                <Link2Off className="h-3.5 w-3.5" /> Links off
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("share-on")} disabled={!selected.size || busy !== null} loading={busy === "share-on"} title="Turn the share links of the selected videos back on. A password, expiry, or go-live time set on a video stays in place.">
                <Link2 className="h-3.5 w-3.5" /> Links on
              </Button>
              {timeField === "golive" ? (
                timeForm("golive")
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => openTimeField("golive")} disabled={!selected.size || busy !== null}>
                  <Clock className="h-3.5 w-3.5" /> Schedule go-live
                </Button>
              )}
              {timeField === "expiry" ? (
                timeForm("expiry")
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => openTimeField("expiry")} disabled={!selected.size || busy !== null}>
                  <TimerOff className="h-3.5 w-3.5" /> Set expiry
                </Button>
              )}
              <Button variant="danger" className="px-2.5 py-1 text-xs" onClick={() => bulk("delete")} disabled={!selected.size || busy !== null} loading={busy === "delete"} title={`Moves the selected videos to the trash, where they can be restored for ${TRASH_RETENTION_DAYS} days`}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
                </>
              )}
              <button type="button" onClick={stopSelecting} disabled={busy !== null} aria-label="Done selecting" className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setSelecting(true)}>
              <CheckSquare className="h-3.5 w-3.5" /> Select
            </Button>
          )}
          {STATUSES.map((s) => (
            <button
              key={s}
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${status === s ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setTrash((t) => !t);
              // Trashed links answer "not found" whatever they were set to, so the share filter has no place there.
              setShare("all");
            }}
            aria-pressed={trash}
            data-testid="trash-toggle"
            title={`Videos you deleted; each is removed for good ${TRASH_RETENTION_DAYS} days after it was trashed`}
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${trash ? "bg-rose-700 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            <Trash2 className="h-3 w-3" /> Trash{trashed ? ` (${trashed})` : ""}
          </button>
          {inWorkspace && (
            <select aria-label="Filter by review" value={review} onChange={(e) => setReview(e.target.value as VideoQuery["review"])} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
              <option value="all">Any review state</option>
              <option value="pending">In review</option>
              <option value="approved">Approved</option>
              <option value="changes">Changes requested</option>
              <option value="none">Not reviewed</option>
            </select>
          )}
          {!trash && (
          <select aria-label="Filter by share link" value={share} onChange={(e) => setShare(e.target.value as VideoQuery["share"])} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
            <option value="all">Any share link</option>
            <option value="live">Link live</option>
            <option value="expiring">Expiring within a week</option>
            <option value="scheduled">Going live later</option>
            <option value="off">Link off</option>
            <option value="expired">Expired</option>
          </select>
          )}
          <select aria-label="Sort videos" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="ml-auto rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A–Z</option>
            <option value="views">Most viewed</option>
          </select>
        </div>
      )}
      {loading && !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-[16/11]" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <EmptyState
          icon={trash ? <Trash2 className="h-8 w-8" /> : <Clapperboard className="h-8 w-8" />}
          title={trash ? (trashed ? "No trashed videos match" : "The trash is empty") : hasAny ? "No videos match" : "No videos yet"}
          body={trash ? `Deleted videos wait here for ${TRASH_RETENTION_DAYS} days before they are removed for good.` : hasAny ? "Try a different search, status, folder, or share link." : "Your rendered videos will show up here."}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {videos.map((v) => (
              <VideoCard key={v.id} video={v} selectable={selecting} selected={selected.has(v.id)} onToggle={() => busy === null && toggle(v.id)} />
            ))}
          </div>
          {remaining > 0 && (
            <div className="mt-6 flex flex-col items-center gap-2 text-sm text-slate-500">
              <span>Showing {videos.length} of {data?.matched}</span>
              <Button variant="secondary" onClick={() => setExtent({ key: filterKey, limit: limit + PAGE })} loading={loading} data-testid="load-more">
                Show {Math.min(remaining, PAGE)} more
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
