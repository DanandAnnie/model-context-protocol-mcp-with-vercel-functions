"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { CheckSquare, Clapperboard, FolderInput, Trash2, X } from "lucide-react";
import { api } from "@/lib/client";
import { VideoCard } from "@/components/VideoCard";
import { Button, EmptyState, ErrorBanner, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import type { Video, VideoStatus } from "@/lib/types";

const STATUSES: Array<"all" | VideoStatus> = ["all", "processing", "completed", "failed"];

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
  const { data, loading, error, refetch } = useApi<{ videos: Video[] }>("/api/videos", {
    pollMs: 6000,
    pollWhile: (d) => d.videos.some((v) => v.status === "processing" || v.status === "queued"),
  });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | VideoStatus>("all");
  const [folder, setFolder] = useState<string>("all"); // "all" | "unfiled" | folder name
  const folders = useMemo(() => Array.from(new Set((data?.videos ?? []).map((v) => v.folder).filter((f): f is string => !!f))).sort(), [data]);
  const videos = useMemo(() => {
    const all = data?.videos ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((v) => {
      if (batch && v.batchId !== batch) return false;
      if (folder === "unfiled" ? !!v.folder : folder !== "all" && v.folder !== folder) return false;
      const statusOk = status === "all" ? true : status === "processing" ? v.status === "processing" || v.status === "queued" : v.status === status;
      const textOk = !needle || `${v.title} ${v.script} ${v.avatarName ?? ""} ${v.voiceName ?? ""}`.toLowerCase().includes(needle);
      return statusOk && textOk;
    });
  }, [data, q, status, batch, folder]);
  const hasAny = (data?.videos.length ?? 0) > 0;

  // Multi-select: move the chosen videos to a folder or delete them in one request.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
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
  async function bulk(action: "delete" | "move") {
    const ids = Array.from(selected);
    if (!ids.length) return;
    let targetFolder: string | undefined;
    if (action === "move") {
      const answer = window.prompt("Folder name (leave empty to move to Unfiled)", "");
      if (answer === null) return;
      targetFolder = answer;
    } else if (!window.confirm(`Delete ${ids.length} ${ids.length === 1 ? "video" : "videos"}? This cannot be undone.`)) {
      return;
    }
    setBusy(true);
    setBulkErr(null);
    try {
      await api("/api/videos/bulk", { method: "POST", body: JSON.stringify(action === "move" ? { action, ids, folder: targetFolder } : { action, ids }) });
      await refetch();
      stopSelecting();
    } catch (e) {
      setBulkErr(e instanceof Error ? e.message : "Could not update the videos");
    } finally {
      setBusy(false);
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
          <input className={`${inputClass} max-w-xs`} placeholder="Search title, script, avatar, voice" value={q} onChange={(e) => setQ(e.target.value)} />
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
          <span className="flex-1" />
          {selecting ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1" data-testid="bulk-bar">
              <span className="px-1 text-xs font-medium text-slate-700">{selected.size} selected</span>
              <button type="button" onClick={() => setSelected(new Set(videos.map((v) => v.id)))} className="text-xs text-brand-700 hover:underline">
                Select all shown
              </button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("move")} disabled={!selected.size || busy}>
                <FolderInput className="h-3.5 w-3.5" /> Move to folder
              </Button>
              <Button variant="danger" className="px-2.5 py-1 text-xs" onClick={() => bulk("delete")} disabled={!selected.size || busy} loading={busy}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
              <button type="button" onClick={stopSelecting} aria-label="Done selecting" className="rounded p-1 text-slate-500 hover:bg-slate-100">
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
              onClick={() => setStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${status === s ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-[16/11]" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <EmptyState
          icon={<Clapperboard className="h-8 w-8" />}
          title={hasAny ? "No videos match" : "No videos yet"}
          body={hasAny ? "Try a different search, status, or folder." : "Your rendered videos will show up here."}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((v) => (
            <VideoCard key={v.id} video={v} selectable={selecting} selected={selected.has(v.id)} onToggle={() => toggle(v.id)} />
          ))}
        </div>
      )}
    </>
  );
}
