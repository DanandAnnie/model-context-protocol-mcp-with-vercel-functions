"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ArchiveRestore, CheckSquare, Clapperboard, FolderInput, FolderMinus, FolderPen, Link2, Link2Off, Trash2, X } from "lucide-react";
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

type BulkAction = "delete" | "move" | "share-off" | "share-on" | "restore" | "purge";

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
  // The trash is its own view of the same page: same search, status, and folder filters, different bulk actions.
  const [trash, setTrash] = useState(false);
  // Search as you type, one request per pause rather than per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setNeedle(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  // "Show more" extends the page for the current filters only: a new filter starts again
  // from the first page in the same render, with no extra request for the old extent.
  const filterKey = [needle, status, folder, batch ?? "", sort, trash ? "trash" : "", review].join("\u0000");
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
    return `/api/videos?${params}`;
  }, [limit, needle, status, folder, batch, sort, trash, review]);
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
  useEffect(() => setSelected(new Set()), [q, status, folder, batch, trash]);
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
    } else if (action === "purge" && !window.confirm(`Delete ${ids.length} ${ids.length === 1 ? "video" : "videos"} for good? ${ids.length === 1 ? "Its" : "Their"} short clips and the recordings cleaned from ${ids.length === 1 ? "it" : "them"} go too. This cannot be undone.`)) {
      return;
    }
    setBusy(action);
    setBulkErr(null);
    try {
      const body =
        action === "move" ? { action, ids, folder: targetFolder } : action === "share-off" || action === "share-on" ? { action: "share", ids, shareDisabled: action === "share-off" } : { action, ids };
      const { missing } = await api<{ done: number; missing: string[] }>("/api/videos/bulk", { method: "POST", body: JSON.stringify(body) });
      await refetch();
      // Videos deleted elsewhere since the page loaded are skipped by the server; say so rather than pretend.
      // For a delete that is the outcome asked for, so it reads as "already deleted" rather than a skip.
      if (missing.length) {
        const which = ids.length === 1 ? "The selected video" : `${missing.length} of the ${ids.length} selected videos`;
        const verb = missing.length === 1 ? "was" : "were";
        setBulkErr(action === "delete" || action === "purge" ? `${which} had already been deleted.` : `${which} ${verb} no longer there and ${verb} skipped.`);
      }
      stopSelecting();
    } catch (e) {
      setBulkErr(e instanceof Error ? e.message : "Could not update the videos");
    } finally {
      setBusy(null);
    }
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
          <Link href="/videos" className="font-medium underline hover:no-underline">Show all videos</Link>
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
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("move")} disabled={!selected.size || busy !== null} loading={busy === "move"}>
                <FolderInput className="h-3.5 w-3.5" /> Move to folder
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("share-off")} disabled={!selected.size || busy !== null} loading={busy === "share-off"} title="The share pages and embeds of the selected videos answer “not found” until turned back on">
                <Link2Off className="h-3.5 w-3.5" /> Links off
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("share-on")} disabled={!selected.size || busy !== null} loading={busy === "share-on"} title="Turn the share links of the selected videos back on. A password or expiry set on a video stays in place.">
                <Link2 className="h-3.5 w-3.5" /> Links on
              </Button>
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
            onClick={() => setTrash((t) => !t)}
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
          body={trash ? `Deleted videos wait here for ${TRASH_RETENTION_DAYS} days before they are removed for good.` : hasAny ? "Try a different search, status, or folder." : "Your rendered videos will show up here."}
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
