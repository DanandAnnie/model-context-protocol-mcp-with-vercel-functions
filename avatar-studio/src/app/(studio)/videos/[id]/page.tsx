"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArchiveRestore, ArrowLeft, Captions, Check, Clock, Code2, Copy, Download, Eye, FolderOpen, Languages, LayoutTemplate, Link2, Lock, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Button, Card, ErrorBanner, SectionTitle, Skeleton, StatusBadge, inputClass } from "@/components/ui";
import { ViewSparkline } from "@/components/ViewSparkline";
import { VideoComments } from "@/components/VideoComments";
import { ReviewPanel } from "@/components/ReviewPanel";
import { SubtitleLanguages } from "@/components/SubtitleLanguages";
import { CaptionEditor } from "@/components/CaptionEditor";
import { ViewerEmails } from "@/components/ViewerEmails";
import { useCanEdit } from "@/hooks/useCanEdit";
import { captionsBurnedIn } from "@/lib/captions";
import { useApi } from "@/hooks/useApi";
import { ApiError, api, formatDate, formatSeconds, isDarkHex, posterUrl, purgeAt, shareExpired } from "@/lib/client";
import { socialShareLinks } from "@/lib/social";
import { TRASH_RETENTION_DAYS, type Video } from "@/lib/types";

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  const [embedAutoplay, setEmbedAutoplay] = useState(false);
  const [embedLoop, setEmbedLoop] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const [savedTemplate, setSavedTemplate] = useState<string | null>(null);
  const [templateErr, setTemplateErr] = useState<string | null>(null);
  async function saveAsTemplate() {
    if (!video) return;
    const title = window.prompt("Template name", video.title);
    if (title === null) return;
    setTemplateErr(null);
    try {
      const { template } = await api<{ template: { id: string } }>("/api/templates", { method: "POST", body: JSON.stringify({ fromVideoId: video.id, title: title.trim() || video.title }) });
      setSavedTemplate(template.id);
    } catch (e) {
      setTemplateErr(e instanceof Error ? e.message : "Could not save the template");
    }
  }
  // A mention email links here with ?ws=<workspace> so a teammate whose active space is another one
  // lands on the video rather than a "not found". Only a workspace the reader belongs to and is not
  // already in is switched to (a crafted link cannot move them out of one); the switch sets the cookie
  // every request reads, so the page reloads without the parameter. The fetch waits until that is settled.
  const [ownerReady, setOwnerReady] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    const ws = url.searchParams.get("ws");
    if (!ws) {
      setOwnerReady(true);
      return;
    }
    url.searchParams.delete("ws");
    const clean = `${url.pathname}${url.search}${url.hash}`;
    api<{ activeId: string; workspaces: Array<{ id: string }> }>("/api/workspaces")
      .then(async ({ activeId, workspaces }) => {
        if (ws === activeId || !workspaces.some((w) => w.id === ws)) {
          window.history.replaceState(null, "", clean);
          setOwnerReady(true);
          return;
        }
        await api("/api/workspaces/switch", { method: "POST", body: JSON.stringify({ id: ws }) });
        window.location.replace(clean);
      })
      .catch(() => setOwnerReady(true));
  }, []);
  const { data, loading, error, setData, refetch } = useApi<{ video: Video; shareOrigin?: string }>(ownerReady ? `/api/videos/${id}` : null, {
    pollMs: 5000,
    pollWhile: (d) => d.video.status === "processing" || d.video.status === "queued",
  });
  const video = data?.video;
  const canEdit = useCanEdit();

  const savingTitle = useRef(false);

  // The player, which comments pinned to a moment read and seek. A mention email links here with
  // ?t=<seconds> to open at the note's moment.
  const player = useRef<HTMLVideoElement>(null);
  const startAt = useRef<number | null>(null);
  useEffect(() => {
    const t = Number(new URL(window.location.href).searchParams.get("t"));
    if (Number.isFinite(t) && t > 0) startAt.current = t;
  }, []);

  // Folder: free text with the owner's existing folders as suggestions.
  const { data: libraryData } = useApi<{ videos: Video[] }>("/api/videos");
  const folders = Array.from(new Set((libraryData?.videos ?? []).map((v) => v.folder).filter((f): f is string => !!f))).sort();
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const [folderErr, setFolderErr] = useState<string | null>(null);
  /**
   * Folds a PATCH response into the page's record. Merging (rather than replacing) means two saves
   * in flight cannot let the earlier response undo the later one; keys the server dropped (a removed
   * description, a link turned back on) must disappear too, or the control flips back until the
   * refetch lands.
   */
  const OPTIONAL_KEYS = ["description", "folder", "cover", "subtitles", "captionCues", "review", "shareGate", "shareDisabled", "shareDownload", "shareLocked", "shareCta", "shareExpiresAt"] as const;
  function applyServer(next: Video) {
    setData((d) => {
      const merged = { ...d?.video, ...next } as Video;
      for (const key of OPTIONAL_KEYS) if (!(key in next)) delete merged[key];
      return { video: merged };
    });
  }

  async function saveFolder() {
    if (!video || folderDraft === null) return;
    const folder = folderDraft.trim();
    setFolderDraft(null);
    if (folder === (video.folder ?? "")) return;
    try {
      const res = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify({ folder }) });
      applyServer(res.video);
      void refetch();
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
      applyServer(res.video);
      void refetch();
      setRenameErr(null);
      setEditing(false);
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message : "Could not rename");
    } finally {
      savingTitle.current = false;
    }
  }

  // Where share links point: the server's public origin (APP_URL when set, as the share email uses),
  // kept once known because local updates replace `data` with the video alone.
  const [shareOrigin, setShareOrigin] = useState("");
  const serverOrigin = data?.shareOrigin;
  useEffect(() => {
    if (serverOrigin) setShareOrigin(serverOrigin);
  }, [serverOrigin]);
  const shareBase = () => shareOrigin || window.location.origin;
  async function copyShareLink() {
    if (!video) return;
    const url = `${shareBase()}/share/${video.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  const [shareErr, setShareErr] = useState<string | null>(null);
  // Optimistic: a box flips at once and reverts if the save fails.
  type SharePatch = { shareDownload?: boolean; shareGate?: boolean; shareDisabled?: boolean; shareExpiresAt?: string | null };
  const [shareDraft, setShareDraft] = useState<SharePatch>({});
  async function patchShare(patch: SharePatch): Promise<boolean> {
    if (!video) return false;
    setShareErr(null);
    setShareDraft((d) => ({ ...d, ...patch }));
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      applyServer(next);
      // A status poll that started before the save would land after it with the old record.
      void refetch();
      return true;
    } catch (e) {
      setShareErr(e instanceof Error ? e.message : "Could not update sharing");
      return false;
    } finally {
      setShareDraft((d) => {
        const rest = { ...d };
        for (const key of Object.keys(patch) as Array<keyof SharePatch>) delete rest[key];
        return rest;
      });
    }
  }
  const shareLive = !(shareDraft.shareDisabled ?? !!video?.shareDisabled);
  // Expiry: the owner types a local date and time; the API stores it as an instant.
  const [expiryDraft, setExpiryDraft] = useState("");
  const expiryInput = (iso?: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  async function saveExpiry() {
    const at = new Date(expiryDraft);
    if (!expiryDraft || Number.isNaN(at.getTime())) return;
    if (at.getTime() <= Date.now()) {
      setShareErr("The expiry must be in the future");
      return;
    }
    if (await patchShare({ shareExpiresAt: at.toISOString() })) setExpiryDraft("");
  }

  // Cover image: downscaled in the browser to fit a 1280px box, sent as a JPEG data URL.
  const [coverBusy, setCoverBusy] = useState<"save" | "frame" | "remove" | null>(null);
  const [coverErr, setCoverErr] = useState<string | null>(null);
  async function fileToCover(file: File): Promise<string> {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("That file is not an image"));
        el.src = url;
      });
      // Fit in a 1280px box, so a tall portrait image stays well under the 2 MB cover limit.
      const scale = Math.min(1, 1280 / img.naturalWidth, 1280 / img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d")!;
      // JPEG has no alpha: a transparent PNG lands on white rather than black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  /**
   * The frame at `time` as a cover, read from a separate video element loaded with CORS so the page's
   * own player is never affected: a host that does not allow it fails here with a clear message, and
   * the player keeps playing. Downscaled like an upload.
   */
  async function frameToCover(src: string, time: number): Promise<string> {
    const unreadable = "Could not read a frame from this video: its host may not allow it, or the link may have expired. Take a screenshot and upload it instead";
    const el = document.createElement("video");
    el.crossOrigin = "anonymous";
    el.muted = true;
    // Metadata first, then only what the seek needs, rather than the whole file again.
    el.preload = "metadata";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The video took too long to load a frame")), 15_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        // Safari can report the seek before the frame there is decoded; wait for it so the cover is never blank.
        const frameReady = () => {
          if (el.readyState >= 2) return done();
          el.onloadeddata = el.oncanplay = () => el.readyState >= 2 && done();
        };
        el.onloadedmetadata = () => {
          const end = Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.05) : time;
          let target = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, end));
          // A seek to where the element already is (0 at first) may not load a frame; one frame later always does.
          if (Math.abs(target - el.currentTime) < 0.01) target = Math.min(end, target + 0.04);
          el.onseeked = frameReady;
          el.currentTime = target;
        };
        el.onerror = () => {
          clearTimeout(timer);
          reject(new Error(unreadable));
        };
        el.src = src;
      });
      // Fit in a 1280px box, so a tall portrait frame stays well under the 2 MB cover limit.
      const scale = Math.min(1, 1280 / el.videoWidth, 1280 / el.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
      canvas.getContext("2d")!.drawImage(el, 0, 0, canvas.width, canvas.height);
      try {
        return canvas.toDataURL("image/jpeg", 0.85);
      } catch {
        throw new Error(unreadable);
      }
    } finally {
      el.removeAttribute("src");
      el.load();
    }
  }
  async function saveCover(file: File | null, frame?: { src: string; time: number }) {
    if (!video || coverBusy) return;
    setCoverErr(null);
    setCoverBusy(frame ? "frame" : file ? "save" : "remove");
    try {
      const body = { cover: frame ? await frameToCover(frame.src, frame.time) : file ? await fileToCover(file) : null };
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setData({ video: next });
      void refetch();
    } catch (e) {
      setCoverErr(e instanceof Error ? e.message : "Could not update the cover");
    } finally {
      setCoverBusy(null);
    }
  }

  // Share password: set or change it from one input, remove it with a button; never shown back.
  const [sharePw, setSharePw] = useState("");
  const [pwBusy, setPwBusy] = useState<"save" | "remove" | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  async function saveSharePassword(remove = false) {
    if (!video || pwBusy) return;
    setPwErr(null);
    setPwBusy(remove ? "remove" : "save");
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify({ sharePassword: remove ? null : sharePw.trim() }) });
      setData({ video: next });
      setSharePw("");
      void refetch();
    } catch (e) {
      setPwErr(e instanceof Error ? e.message : "Could not update the password");
    } finally {
      setPwBusy(null);
    }
  }

  // Call to action shown under the share-page player.
  // Send by email: recipients separated by commas, spaces, or new lines, plus an optional note.
  const [mailTo, setMailTo] = useState("");
  const [mailMsg, setMailMsg] = useState("");
  const [mailBusy, setMailBusy] = useState(false);
  const [mailStatus, setMailStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const mailRecipients = mailTo.split(/[\s,;]+/).filter(Boolean);
  async function sendByEmail() {
    if (!video || mailBusy || mailRecipients.length === 0) return;
    setMailBusy(true);
    setMailStatus(null);
    try {
      const res = await api<{ sent: string[]; failed: { to: string; error: string }[]; delivers: boolean }>(`/api/videos/${video.id}/share`, {
        method: "POST",
        body: JSON.stringify({ to: mailRecipients, message: mailMsg.trim() || undefined }),
      });
      const n = res.sent.length;
      const note = res.delivers ? "" : " (demo: no email provider is configured, so nothing was delivered)";
      const failed = res.failed.length ? ` ${res.failed.length} could not be sent: ${res.failed.map((f) => f.to).join(", ")}.` : "";
      setMailStatus({ ok: res.failed.length === 0, text: `Sent to ${n} ${n === 1 ? "recipient" : "recipients"}${note}.${failed}` });
      // Only the addresses that failed stay in the box, so a retry does not email the others twice.
      setMailTo(res.failed.map((f) => f.to).join(", "));
      if (res.failed.length === 0) setMailMsg("");
    } catch (e) {
      setMailStatus({ ok: false, text: e instanceof Error ? e.message : "Could not send" });
    } finally {
      setMailBusy(false);
    }
  }
  // Description shown under the share-page player; a blank save removes it.
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [descBusy, setDescBusy] = useState(false);
  const [descErr, setDescErr] = useState<string | null>(null);
  async function saveDescription() {
    if (!video || descBusy || descDraft === null) return;
    setDescBusy(true);
    setDescErr(null);
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify({ description: descDraft.trim() }) });
      applyServer(next);
      setDescDraft(null);
      void refetch();
    } catch (e) {
      setDescErr(e instanceof Error ? e.message : "Could not save the description");
    } finally {
      setDescBusy(false);
    }
  }
  const [ctaLabel, setCtaLabel] = useState<string | null>(null);
  const [ctaUrl, setCtaUrl] = useState<string | null>(null);
  const [ctaErr, setCtaErr] = useState<string | null>(null);
  const [ctaBusy, setCtaBusy] = useState<"save" | "remove" | null>(null);
  const ctaDraft = { label: (ctaLabel ?? video?.shareCta?.label ?? "").trim(), url: (ctaUrl ?? video?.shareCta?.url ?? "").trim() };
  async function saveCta(remove = false) {
    if (!video || ctaBusy) return;
    setCtaErr(null);
    setCtaBusy(remove ? "remove" : "save");
    try {
      const body = remove ? { shareCta: null } : { shareCta: ctaDraft };
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify(body) });
      applyServer(next);
      setCtaLabel(null);
      setCtaUrl(null);
      void refetch();
    } catch (e) {
      setCtaErr(e instanceof Error ? e.message : "Could not save the button");
    } finally {
      setCtaBusy(null);
    }
  }

  async function copyEmbed() {
    if (!video) return;
    const w = video.aspect === "9:16" ? 360 : video.aspect === "1:1" ? 480 : 640;
    const h = video.aspect === "9:16" ? 640 : video.aspect === "1:1" ? 480 : 360;
    const query = [embedAutoplay ? "autoplay=1" : "", embedLoop ? "loop=1" : ""].filter(Boolean).join("&");
    const src = `${shareBase()}/share/${video.id}${query ? `?${query}` : ""}`;
    const snippet = `<iframe src="${src}" width="${w}" height="${h}" style="border:0;max-width:100%" allow="${embedAutoplay ? "autoplay; " : ""}fullscreen" title="${video.title.replace(/"/g, "&quot;")}"></iframe>`;
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

  async function remove(permanent = false) {
    if (!video) return;
    if (!confirm(permanent ? "Delete this video for good? This cannot be undone." : `Move this video to the trash? You can restore it for ${TRASH_RETENTION_DAYS} days.`)) return;
    setDeleting(true);
    try {
      await api(`/api/videos/${video.id}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" });
      router.push("/videos");
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message : "Could not delete the video");
      setDeleting(false);
    }
  }

  const [restoring, setRestoring] = useState(false);
  async function restore() {
    if (!video) return;
    setRestoring(true);
    try {
      const { video: back } = await api<{ video: Video }>(`/api/videos/${video.id}/restore`, { method: "POST" });
      setData({ video: back });
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message : "Could not restore the video");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
      <Link href="/videos" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" /> All videos
      </Link>
      <ErrorBanner message={error ?? renameErr ?? folderErr} />
      {video?.deletedAt && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900" data-testid="trash-banner" role="status">
          <span>
            This video is in the trash. Its share link is off and it will be deleted for good on {formatDate(purgeAt(video)!)} unless you restore it.
          </span>
          <span className="flex gap-2">
            <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={restore} loading={restoring}>
              <ArchiveRestore className="h-3.5 w-3.5" /> Restore
            </Button>
            <Button variant="danger" className="px-3 py-1.5 text-xs" onClick={() => remove(true)} loading={deleting}>
              <Trash2 className="h-3.5 w-3.5" /> Delete forever
            </Button>
          </span>
        </div>
      )}
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
                {video.status === "completed" && !video.deletedAt && (
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
                    <span className="inline-flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700" title="Options for the embed snippet; the share link itself is unchanged">
                      <label className="inline-flex items-center gap-1.5">
                        <input type="checkbox" checked={embedAutoplay} onChange={(e) => setEmbedAutoplay(e.target.checked)} className="accent-brand-600" aria-label="Embed autoplays muted" />
                        Autoplay (muted)
                      </label>
                      <label className="inline-flex items-center gap-1.5">
                        <input type="checkbox" checked={embedLoop} onChange={(e) => setEmbedLoop(e.target.checked)} className="accent-brand-600" aria-label="Embed loops" />
                        Loop
                      </label>
                    </span>
                    <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700" title="Turn off to make the share page and embed unavailable; views and clicks stop counting">
                      <input type="checkbox" checked={shareLive} onChange={(e) => patchShare({ shareDisabled: !e.target.checked })} className="accent-brand-600" />
                      Share link is live
                    </label>
                    <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700" title="Show a download button on the share page">
                      <input type="checkbox" checked={shareDraft.shareDownload ?? !!video.shareDownload} onChange={(e) => patchShare({ shareDownload: e.target.checked })} className="accent-brand-600" />
                      Viewers can download
                    </label>
                    <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700" title="Viewers enter an email before the video plays; the emails are listed below">
                      <input type="checkbox" checked={shareDraft.shareGate ?? !!video.shareGate} onChange={(e) => patchShare({ shareGate: e.target.checked })} className="accent-brand-600" />
                      Ask for an email before playing
                    </label>
                    {!shareLive && <span className="text-xs text-slate-500" data-testid="share-off-note">Share link off: the share page and embed answer “not found”.</span>}
                    <form
                      className="inline-flex flex-wrap items-center gap-2"
                      data-testid="share-expiry"
                      noValidate
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveExpiry();
                      }}
                    >
                      {video.shareExpiresAt && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${shareExpired(video) ? "bg-rose-50 text-rose-800" : "bg-slate-100 text-slate-700"}`}
                          data-testid="share-expiry-badge"
                        >
                          <Clock className="h-3 w-3" /> {shareExpired(video) ? "Expired" : "Expires"} {formatDate(video.shareExpiresAt)}
                        </span>
                      )}
                      <input
                        type="datetime-local"
                        aria-label="Share link expiry"
                        className={`${inputClass} w-52 py-1.5 text-xs`}
                        value={expiryDraft}
                        min={expiryInput(new Date().toISOString())}
                        onChange={(e) => setExpiryDraft(e.target.value)}
                      />
                      <Button type="submit" variant="secondary" disabled={!expiryDraft} title="The share link stops working at this time; you keep access">
                        {video.shareExpiresAt ? "Change expiry" : "Set expiry"}
                      </Button>
                      {video.shareExpiresAt && (
                        <Button type="button" variant="ghost" onClick={() => void patchShare({ shareExpiresAt: null })}>
                          Clear expiry
                        </Button>
                      )}
                    </form>
                    <form
                      className="inline-flex flex-wrap items-center gap-2"
                      data-testid="share-password"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (sharePw.trim()) void saveSharePassword();
                      }}
                    >
                      {video.shareLocked && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800" data-testid="share-locked">
                          <Lock className="h-3 w-3" /> Password protected
                        </span>
                      )}
                      <input
                        type="password"
                        aria-label="Share password"
                        autoComplete="new-password"
                        className={`${inputClass} w-44 py-1.5 text-xs`}
                        placeholder={video.shareLocked ? "Change password" : "Set a password"}
                        maxLength={64}
                        value={sharePw}
                        onChange={(e) => setSharePw(e.target.value)}
                      />
                      <Button type="submit" variant="secondary" className="px-3 py-1.5 text-xs" loading={pwBusy === "save"} disabled={!sharePw.trim() || pwBusy === "remove"}>
                        {video.shareLocked ? "Change" : "Protect"}
                      </Button>
                      {video.shareLocked && (
                        <Button type="button" variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => saveSharePassword(true)} loading={pwBusy === "remove"} disabled={pwBusy === "save"}>
                          Remove password
                        </Button>
                      )}
                      {pwErr && <span className="text-xs text-rose-600">{pwErr}</span>}
                    </form>
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
                {savedTemplate ? (
                  <Link href="/templates" className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100">
                    <Check className="h-4 w-4" /> Saved · View templates
                  </Link>
                ) : (
                  <Button variant="secondary" onClick={saveAsTemplate}>
                    <LayoutTemplate className="h-4 w-4" /> Save as template
                  </Button>
                )}
                {templateErr && <span className="text-xs text-rose-600">{templateErr}</span>}
                {!video.deletedAt && (
                  <Button variant="danger" onClick={() => remove()} loading={deleting} title={`Moves the video to the trash, where it can be restored for ${TRASH_RETENTION_DAYS} days`}>
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                )}
              </div>
            }
          />

          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-center bg-slate-950 p-0">
               <div className={`relative flex items-center justify-center ${video.aspect === "9:16" ? "aspect-[9/16] h-[70vh]" : video.aspect === "1:1" ? "aspect-square w-full max-w-[560px]" : "aspect-video w-full"}`}>
                {video.status === "completed" && video.videoUrl ? (
                  <video
                    ref={player}
                    src={video.videoUrl}
                    poster={posterUrl(video)}
                    controls
                    className="h-full w-full"
                    data-testid="video-player"
                    onLoadedMetadata={(e) => {
                      const el = e.currentTarget;
                      if (startAt.current === null) return;
                      el.currentTime = Math.min(startAt.current, Number.isFinite(el.duration) ? el.duration : startAt.current);
                      startAt.current = null;
                    }}
                  />
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
                  {video.status === "completed" && (
                    <Row label="Views by day" wrap>
                      <ViewSparkline video={video} />
                    </Row>
                  )}
                  {video.status === "completed" && (
                    <Row label="Watch-through" wrap>
                      <span
                        data-testid="watch-through"
                        title={`Viewers who reached a quarter, half, three quarters, and the end${video.views ? `; ${Math.min(100, Math.round(((video.watch?.q100 ?? 0) / video.views) * 100))}% of views played to the end` : ""}`}
                      >
                        {([25, 50, 75, 100] as const).map((q, i) => (
                          <span key={q} className="inline-block">
                            {i > 0 && <span className="text-slate-300">&nbsp;·&nbsp;</span>}
                            <span className="text-slate-500">{q}%</span> {video.watch?.[`q${q}`] ?? 0}
                          </span>
                        ))}
                      </span>
                    </Row>
                  )}
                  {(video.shareCta || (video.ctaClicks ?? 0) > 0) && (
                    <Row label="Button clicks">
                      <span data-testid="cta-clicks" title={video.lastCtaClickAt ? `Last clicked ${formatDate(video.lastCtaClickAt)}` : "No clicks yet"}>{video.ctaClicks ?? 0}</span>
                    </Row>
                  )}
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
                  <Row label="Voice">
                    {video.scenes?.length && video.scenes.every((sc) => sc.audioId)
                      ? `Recorded audio${video.scenes.length === 1 && video.scenes[0].audioName ? ` (${video.scenes[0].audioName})` : ""}`
                      : `${video.voiceName ?? video.voiceId}${video.scenes?.some((sc) => sc.audioId) ? ", plus recorded audio" : ""}`}
                  </Row>
                  <Row label="Speed">{video.speed}x</Row>
                  {video.pitch ? <Row label="Pitch">{video.pitch > 0 ? `+${video.pitch}` : video.pitch}</Row> : null}
                  {video.emotion ? <Row label="Voice emotion">{video.emotion}</Row> : null}
                  <Row label="Captions">{video.captions ? `On${video.captionStyle ? ` · ${video.captionStyle.position}, ${video.captionStyle.size}${video.captionStyle.look ? `, ${video.captionStyle.look}` : ""}` : ""}` : "Off"}</Row>
                  <Row label="Background">
                    {video.background.type === "color" ? (
                      <span className="inline-flex items-center gap-2"><span className="h-4 w-4 rounded border border-slate-200" style={{ background: video.background.value }} />{video.background.value}</span>
                    ) : video.background.type === "video" ? (
                      "Video"
                    ) : (
                      "Image"
                    )}
                  </Row>
                </dl>
              </Card>
              <Card className="p-4" data-testid="cover-card">
                <h3 className="text-sm font-semibold text-slate-900">Cover image</h3>
                <p className="mt-1 text-xs text-slate-500">The poster shown on the share page, in link previews, and in your library: upload an image, or pause the player on a frame and use it. Fitted in 1280 × 1280 pixels; 2 MB.</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {posterUrl(video) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={posterUrl(video)} alt="" className="h-14 w-24 rounded-md border border-slate-200 object-cover" data-testid="cover-preview" />
                  )}
                  <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50">
                    {coverBusy === "save" ? "Uploading…" : video.cover ? "Replace cover" : "Upload cover"}
                    <input
                      type="file"
                      accept="image/*"
                      aria-label="Cover image"
                      className="sr-only"
                      disabled={!!coverBusy}
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        e.target.value = "";
                        if (file) void saveCover(file);
                      }}
                    />
                  </label>
                  {video.status === "completed" && video.videoUrl && (
                    <Button
                      type="button"
                      variant="secondary"
                      className="px-3 py-1.5 text-xs"
                      onClick={() => saveCover(null, { src: video.videoUrl!, time: player.current?.currentTime ?? 0 })}
                      loading={coverBusy === "frame"}
                      disabled={!!coverBusy && coverBusy !== "frame"}
                      title="Pause the player on the frame you want, then use it as the cover"
                    >
                      Use current frame
                    </Button>
                  )}
                  {video.cover && (
                    <Button type="button" variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => saveCover(null)} loading={coverBusy === "remove"} disabled={coverBusy === "save" || coverBusy === "frame"}>
                      Remove cover
                    </Button>
                  )}
                  {coverErr && <span className="text-xs text-rose-600">{coverErr}</span>}
                </div>
              </Card>
              {video.status === "completed" && (
                <Card className="p-4" data-testid="share-email-card">
                  <h3 className="text-sm font-semibold text-slate-900">Send by email</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Emails the share link to up to 10 people{video.shareLocked ? "; they will be told a password is needed (send it separately)" : ""}.
                  </p>
                  <form
                    className="mt-3 space-y-2"
                    noValidate
                    onSubmit={(e) => {
                      e.preventDefault();
                      void sendByEmail();
                    }}
                  >
                    <textarea
                      className={`${inputClass} min-h-[60px]`}
                      aria-label="Recipients"
                      placeholder="jane@example.com, sam@example.com"
                      value={mailTo}
                      onChange={(e) => setMailTo(e.target.value)}
                    />
                    <textarea className={`${inputClass} min-h-[60px]`} aria-label="Message" placeholder="A note for the recipients (optional)" maxLength={500} value={mailMsg} onChange={(e) => setMailMsg(e.target.value)} />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="submit" className="px-3 py-1.5 text-xs" loading={mailBusy} disabled={mailRecipients.length === 0 || !shareLive || shareExpired(video) || !!video.deletedAt}>
                        Send link
                      </Button>
                      {video.deletedAt ? <span className="text-xs text-slate-500">Restore the video from the trash first.</span> : (!shareLive || shareExpired(video)) && <span className="text-xs text-slate-500">Turn the share link on first.</span>}
                      {/* Always mounted so screen readers announce the first message too. */}
                      <span className={`text-xs ${mailStatus?.ok ? "text-emerald-700" : "text-rose-600"}`} data-testid="share-email-status" role="status">
                        {mailStatus?.text}
                      </span>
                    </div>
                  </form>
                </Card>
              )}
              {video.status === "completed" && (
                <Card className="p-4" data-testid="share-social-card">
                  <h3 className="text-sm font-semibold text-slate-900">Post the link</h3>
                  {video.deletedAt || !shareLive || shareExpired(video) ? (
                    <p className="mt-1 text-xs text-slate-500">{video.deletedAt ? "Restore the video from the trash first." : "Turn the share link on first."}</p>
                  ) : !shareOrigin ? null : (
                    <>
                      <p className="mt-1 text-xs text-slate-500">
                        Each network opens in a new tab with the share link filled in; nothing is posted until you confirm there.{video.shareLocked ? " Viewers will need the password." : ""}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Post the link to">
                        {socialShareLinks(`${shareOrigin}/share/${video.id}`, video.title).map((l) => (
                          <a
                            key={l.network}
                            href={l.href}
                            // A mailto link hands off to the mail app; a new tab for it would be left empty.
                            {...(l.network === "email" ? {} : { target: "_blank", rel: "noopener noreferrer" })}
                            data-network={l.network}
                            className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
                          >
                            {l.label}
                            {l.network !== "email" && <span className="sr-only"> (opens in a new tab)</span>}
                          </a>
                        ))}
                      </div>
                    </>
                  )}
                </Card>
              )}
              {!video.deletedAt && <ViewerEmails videoId={video.id} gateOn={!!video.shareGate} />}
              {!video.deletedAt && video.status === "completed" && canEdit && <CaptionEditor video={video} burnedIn={captionsBurnedIn(video)} onUpdated={applyServer} />}
              {!video.deletedAt && <SubtitleLanguages video={video} onUpdated={applyServer} />}
              <Card className="p-4" data-testid="share-description-card">
                <h3 className="text-sm font-semibold text-slate-900">Description</h3>
                <p className="mt-1 text-xs text-slate-500">Shown under the player on the share page and in link previews. Leave it empty to show nothing.</p>
                <form
                  className="mt-3 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveDescription();
                  }}
                >
                  <textarea
                    className={`${inputClass} min-h-[72px]`}
                    aria-label="Share page description"
                    placeholder="What viewers should know before they press play"
                    maxLength={500}
                    value={descDraft ?? video.description ?? ""}
                    onChange={(e) => setDescDraft(e.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <Button type="submit" className="px-3 py-1.5 text-xs" loading={descBusy} disabled={descDraft === null || descDraft.trim() === (video.description ?? "")}>
                      Save description
                    </Button>
                    {descErr && <span className="text-xs text-rose-600">{descErr}</span>}
                  </div>
                </form>
              </Card>
              <Card className="p-4" data-testid="share-cta-card">
                <h3 className="text-sm font-semibold text-slate-900">Call to action</h3>
                <p className="mt-1 text-xs text-slate-500">A button under the player on the share page, in your brand colour.</p>
                <form
                  className="mt-3 space-y-2"
                  // The server's message names the accepted schemes; the browser's generic URL check would hide it.
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (ctaDraft.label && ctaDraft.url) void saveCta();
                  }}
                >
                  <input className={inputClass} aria-label="Button label" placeholder="Book a showing" maxLength={40} value={ctaLabel ?? video.shareCta?.label ?? ""} onChange={(e) => setCtaLabel(e.target.value)} />
                  <input className={inputClass} aria-label="Button link" type="url" placeholder="https://…" value={ctaUrl ?? video.shareCta?.url ?? ""} onChange={(e) => setCtaUrl(e.target.value)} />
                  <div className="flex items-center gap-2">
                    <Button type="submit" className="px-3 py-1.5 text-xs" loading={ctaBusy === "save"} disabled={!ctaDraft.label || !ctaDraft.url || ctaBusy === "remove"}>
                      Save button
                    </Button>
                    {video.shareCta && (
                      <Button type="button" variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => saveCta(true)} loading={ctaBusy === "remove"} disabled={ctaBusy === "save"}>
                        Remove
                      </Button>
                    )}
                    {ctaErr && <span className="text-xs text-rose-600">{ctaErr}</span>}
                  </div>
                </form>
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
                        <div className="min-w-0">
                          {(sc.avatarName || sc.voiceName || sc.audioId || sc.layout) && (
                            <div className="mb-0.5 text-xs text-slate-500">
                              {[sc.avatarName, sc.audioId ? `recorded audio${sc.audioName ? `: ${sc.audioName}` : ""}` : sc.voiceName, sc.layout ? `presenter ${Math.round(sc.layout.scale * 100)}%${sc.layout.x || sc.layout.y ? ", moved" : ""}` : undefined].filter(Boolean).join(" · ")}
                            </div>
                          )}
                          <p className="whitespace-pre-wrap leading-relaxed text-slate-700">{sc.script}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{video.script}</p>
                )}
              </Card>
              <ReviewPanel video={video} onChange={(next) => setData({ video: next })} />
              <VideoComments videoId={video.id} player={video.status === "completed" && video.videoUrl ? player : undefined} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Row({ label, children, wrap = false }: { label: string; children: React.ReactNode; wrap?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className={`${wrap ? "" : "truncate"} text-right text-slate-900`}>{children}</dd>
    </div>
  );
}
