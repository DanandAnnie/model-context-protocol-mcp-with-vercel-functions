"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowLeft, Captions, Check, Code2, Copy, Download, Eye, FolderOpen, Languages, Link2, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Button, Card, ErrorBanner, SectionTitle, Skeleton, StatusBadge } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { ApiError, api, formatDate, formatSeconds, isDarkHex } from "@/lib/client";
import type { Video } from "@/lib/types";

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const { data, loading, error, setData } = useApi<{ video: Video }>(`/api/videos/${id}`, {
    pollMs: 5000,
    pollWhile: (d) => d.video.status === "processing" || d.video.status === "queued",
  });
  const video = data?.video;

  const savingTitle = useRef(false);

  // Folder: free text with the owner's existing folders as suggestions.
  const { data: libraryData } = useApi<{ videos: Video[] }>("/api/videos");
  const folders = Array.from(new Set((libraryData?.videos ?? []).map((v) => v.folder).filter((f): f is string => !!f))).sort();
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const [folderErr, setFolderErr] = useState<string | null>(null);
  async function saveFolder() {
    if (!video || folderDraft === null) return;
    const folder = folderDraft.trim();
    setFolderDraft(null);
    if (folder === (video.folder ?? "")) return;
    try {
      const res = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify({ folder }) });
      setData({ video: { ...video, folder: res.video.folder } });
      setFolderErr(null);
    } catch (e) {
      setFolderErr(e instanceof Error ? e.message : "Could not move the video");
    }
  }

  async function saveTitle() {
    if (!video || savingTitle.current) return; // Enter triggers this, then the unmount's blur does too.
    const title = draftTitle.trim();
    if (!title || title === video.title) {
      setEditing(false);
      return;
    }
    savingTitle.current = true;
    try {
      const res = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
      setData({ video: { ...video, title: res.video.title } });
      setRenameErr(null);
      setEditing(false);
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message : "Could not rename");
    } finally {
      savingTitle.current = false;
    }
  }

  async function copyShareLink() {
    if (!video) return;
    const url = `${window.location.origin}/share/${video.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  const [shareErr, setShareErr] = useState<string | null>(null);
  // Optimistic: the box flips at once and reverts if the save fails.
  const [downloadOn, setDownloadOn] = useState<boolean | null>(null);
  async function setShareDownload(on: boolean) {
    if (!video) return;
    setShareErr(null);
    setDownloadOn(on);
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify({ shareDownload: on }) });
      setData({ video: next });
    } catch (e) {
      setShareErr(e instanceof Error ? e.message : "Could not update sharing");
    } finally {
      setDownloadOn(null);
    }
  }

  async function copyEmbed() {
    if (!video) return;
    const w = video.aspect === "9:16" ? 360 : video.aspect === "1:1" ? 480 : 640;
    const h = video.aspect === "9:16" ? 640 : video.aspect === "1:1" ? 480 : 360;
    const snippet = `<iframe src="${window.location.origin}/share/${video.id}" width="${w}" height="${h}" style="border:0;max-width:100%" allow="fullscreen" title="${video.title.replace(/"/g, "&quot;")}"></iframe>`;
    try {
      await navigator.clipboard.writeText(snippet);
      setEmbedCopied(true);
      setTimeout(() => setEmbedCopied(false), 2000);
    } catch {
      window.prompt("Copy this embed code", snippet);
    }
  }

  const [retrying, setRetrying] = useState(false);
  const [retryErr, setRetryErr] = useState<string | null>(null);
  async function retry() {
    if (!video) return;
    setRetrying(true);
    setRetryErr(null);
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}/retry`, { method: "POST" });
      router.push(`/videos/${next.id}`);
    } catch (e) {
      // A refused start still records the new (failed) video; show it rather than piling up silent copies.
      const failedId = e instanceof ApiError ? (e.body?.video as { id?: string } | undefined)?.id : undefined;
      if (failedId) {
        router.push(`/videos/${failedId}`);
        return;
      }
      setRetryErr(e instanceof Error ? e.message : "Could not retry the render");
      setRetrying(false);
    }
  }

  async function remove() {
    if (!video || !confirm("Delete this video? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await api(`/api/videos/${video.id}`, { method: "DELETE" });
      router.push("/videos");
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message : "Could not delete the video");
      setDeleting(false);
    }
  }

  return (
    <>
      <Link href="/videos" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" /> All videos
      </Link>
      <ErrorBanner message={error ?? renameErr ?? folderErr} />
      {loading || !video ? (
        <Skeleton className="aspect-video w-full" />
      ) : (
        <>
          <SectionTitle
            title={
              editing ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTitle();
                    if (e.key === "Escape") setEditing(false);
                  }}
                  aria-label="Video title"
                  className="w-full max-w-xl rounded-lg border border-brand-300 px-2 py-1 text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-100"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDraftTitle(video.title);
                    setEditing(true);
                  }}
                  className="group inline-flex items-center gap-2 text-left"
                  title="Rename"
                >
                  {video.title}
                  <Pencil className="h-4 w-4 text-slate-300 group-hover:text-slate-600" />
                </button>
              )
            }
            subtitle={`Created ${formatDate(video.createdAt)} · ${video.aspect}${video.resolution ? ` · ${video.resolution}` : ""} · ${video.provider}`}
            action={
              <div className="flex flex-wrap items-center gap-2">
                {video.videoUrl && (
                  <a href={video.videoUrl} download target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
                    <Download className="h-4 w-4" /> Download
                  </a>
                )}
                {video.status === "completed" && (
                  <>
                    <a href={`/api/videos/${video.id}/captions`} download className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50" title="Also available as WebVTT with ?format=vtt">
                      <Captions className="h-4 w-4" /> Captions (.srt)
                    </a>
                    <Button variant="secondary" onClick={copyShareLink}>
                      {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Link2 className="h-4 w-4" />} {copied ? "Link copied" : "Share"}
                    </Button>
                    <Button variant="secondary" onClick={copyEmbed} title="Copy an iframe snippet for your site">
                      {embedCopied ? <Check className="h-4 w-4 text-emerald-600" /> : <Code2 className="h-4 w-4" />} {embedCopied ? "Embed copied" : "Embed"}
                    </Button>
                    <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700" title="Show a download button on the share page">
                      <input type="checkbox" checked={downloadOn ?? !!video.shareDownload} onChange={(e) => setShareDownload(e.target.checked)} className="accent-brand-600" />
                      Viewers can download
                    </label>
                    {shareErr && <span className="text-xs text-rose-600">{shareErr}</span>}
                  </>
                )}
                {video.videoUrl && (
                  <Link href={`/translate?source=${encodeURIComponent(video.videoUrl)}&title=${encodeURIComponent(video.title)}`} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
                    <Languages className="h-4 w-4" /> Translate
                  </Link>
                )}
                <Link href={`/create?from=${video.id}`} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
                  <Copy className="h-4 w-4" /> Edit a copy
                </Link>
                <Button variant="danger" onClick={remove} loading={deleting}>
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
              </div>
            }
          />

          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-center bg-slate-950 p-0">
               <div className={`relative flex items-center justify-center ${video.aspect === "9:16" ? "aspect-[9/16] h-[70vh]" : video.aspect === "1:1" ? "aspect-square w-full max-w-[560px]" : "aspect-video w-full"}`}>
                {video.status === "completed" && video.videoUrl ? (
                  <video src={video.videoUrl} poster={video.thumbnailUrl} controls className="h-full w-full" />
                ) : video.status === "failed" ? (
                  <div className="p-8 text-center text-sm text-rose-200">
                    <p className="font-medium">Render failed</p>
                    <p className="mt-1 text-rose-300/80">{video.error}</p>
                    <button
                      type="button"
                      onClick={retry}
                      disabled={retrying}
                      className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20 disabled:opacity-60"
                    >
                      <RotateCcw className="h-4 w-4" /> {retrying ? "Submitting…" : "Retry render"}
                    </button>
                    {retryErr && <p className="mt-2 text-xs text-rose-300">{retryErr}</p>}
                  </div>
                ) : (
                  <div className="p-8 text-center text-slate-300">
                    <StatusBadge status={video.status} />
                    <p className="mt-3 text-sm">Rendering your video. This page refreshes automatically.</p>
                  </div>
                )}
               </div>
              </div>
            </Card>

            <div className="space-y-4">
              <Card className="p-4">
                <h3 className="text-sm font-semibold text-slate-900">Details</h3>
                <dl className="mt-3 space-y-2 text-sm">
                  <Row label="Status"><StatusBadge status={video.status} /></Row>
                  <Row label="Duration">{video.durationSec != null ? formatSeconds(video.durationSec) : "—"}</Row>
                  <Row label="Share views">
                    <span className="inline-flex items-center gap-1.5" title={video.lastViewedAt ? `Last viewed ${formatDate(video.lastViewedAt)}` : "No views yet"}>
                      <Eye className="h-3.5 w-3.5 text-slate-400" />
                      {video.views ?? 0}
                    </span>
                  </Row>
                  <Row label="Folder">
                    {folderDraft === null ? (
                      <button
                        type="button"
                        onClick={() => setFolderDraft(video.folder ?? "")}
                        className="inline-flex items-center gap-1.5 rounded px-1 text-slate-900 hover:bg-slate-100"
                        title="Move to a folder"
                        aria-label="Move to a folder"
                      >
                        <FolderOpen className="h-3.5 w-3.5 text-slate-400" />
                        {video.folder ?? "Unfiled"}
                      </button>
                    ) : (
                      <>
                        <input
                          autoFocus
                          list="video-folders"
                          aria-label="Folder name"
                          value={folderDraft}
                          maxLength={40}
                          placeholder="Unfiled"
                          onChange={(e) => setFolderDraft(e.target.value)}
                          onBlur={saveFolder}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveFolder();
                            if (e.key === "Escape") setFolderDraft(null);
                          }}
                          className="w-36 rounded border border-slate-200 px-2 py-0.5 text-right text-sm focus:border-brand-500 focus:outline-none"
                        />
                        <datalist id="video-folders">
                          {folders.map((f) => (
                            <option key={f} value={f} />
                          ))}
                        </datalist>
                      </>
                    )}
                  </Row>
                  <Row label="Avatar">{video.avatarName ?? video.avatarId}</Row>
                  <Row label="Voice">{video.voiceName ?? video.voiceId}</Row>
                  <Row label="Speed">{video.speed}x</Row>
                  <Row label="Captions">{video.captions ? "On" : "Off"}</Row>
                  <Row label="Background">
                    {video.background.type === "color" ? (
                      <span className="inline-flex items-center gap-2"><span className="h-4 w-4 rounded border border-slate-200" style={{ background: video.background.value }} />{video.background.value}</span>
                    ) : (
                      "Image"
                    )}
                  </Row>
                </dl>
              </Card>
              <Card className="p-4">
                <h3 className="text-sm font-semibold text-slate-900">{video.scenes && video.scenes.length > 1 ? `Script · ${video.scenes.length} scenes` : "Script"}</h3>
                {video.scenes && video.scenes.length > 1 ? (
                  <ol className="mt-2 space-y-3">
                    {video.scenes.map((sc, i) => (
                      <li key={i} className="flex gap-3 text-sm">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-black/10 text-[10px] font-semibold text-slate-700" style={sc.background.type === "color" ? { background: sc.background.value, color: isDarkHex(sc.background.value) ? "#fff" : undefined } : undefined}>
                          {i + 1}
                        </span>
                        <p className="whitespace-pre-wrap leading-relaxed text-slate-700">{sc.script}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{video.script}</p>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="truncate text-right text-slate-900">{children}</dd>
    </div>
  );
}
