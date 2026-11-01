"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore, CheckSquare, Clapperboard, Clock, LayoutGrid, List, Download, FolderInput, KeyRound, SlidersHorizontal, FolderMinus, FolderPen, Link2, Link2Off, RotateCcw, Star, StarOff, TimerOff, Trash2, X } from "lucide-react";
import { api, folderFor, overSelection } from "@/lib/client";
import { VideoCard, VideoRow } from "@/components/VideoCard";
import { Button, EmptyState, ErrorBanner, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit, useWorkspaceRole } from "@/hooks/useCanEdit";
import type { VideoPage, VideoQuery } from "@/lib/services/videos";
import { BULK_MAX, EMPTY_TRASH_MAX, LIBRARY_PAGE_MAX, MAX_FOLDER_NAME, MAX_RETRY_AT_ONCE, RESTORE_ALL_MAX, SHARE_PASSWORD_MAX, SHARE_PASSWORD_MIN, TRASH_RETENTION_DAYS, type VideoStatus } from "@/lib/types";

const STATUSES: Array<"all" | VideoStatus> = ["all", "processing", "completed", "failed"];
type SortKey = VideoQuery["sort"];
/** Where this browser keeps the library's layout (grid of cards or list of rows). */
const LAYOUT_KEY = "avatar-studio:library-layout";
/** Cards per request; "Show more" asks for another page's worth. */
const PAGE = 48;

/** " (12)" after a folder's name in the picker. */
const withCount = (n: number) => ` (${n})`;
/** A folder's count, read as the folder's own entry only: a folder named "constructor" is not the object's prototype. */
const countOf = (counts: Record<string, number>, folder: string) => (Object.hasOwn(counts, folder) && typeof counts[folder] === "number" ? counts[folder] : 0);

/** A time as a datetime-local field holds it: the browser's local date and time, to the minute. */
function localMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type BulkAction = "delete" | "move" | "share-off" | "share-on" | "schedule" | "golive" | "expire" | "noexpiry" | "restore" | "purge" | "links" | "password" | "nopassword" | "settings" | "retry" | "star" | "unstar" | "empty" | "restoreall" | "unfile";

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
  // Viewers can browse the trash but not empty it (the server refuses them too).
  const canEdit = useCanEdit() !== false;
  const trashToggleRef = useRef<HTMLButtonElement>(null);
  // Set once the trash is emptied; the toggle takes the focus when it is enabled again, after the request.
  const focusTrashToggle = useRef(false);
  const [review, setReview] = useState<VideoQuery["review"]>("all");
  // Share link state, as the cards' badges say; with the bulk go-live and expiry it finds a campaign's links to fix.
  const [share, setShare] = useState<VideoQuery["share"]>("all");
  // The trash is its own view of the same page: same search, status, and folder filters, different bulk actions.
  const [trash, setTrash] = useState(false);
  // Only the starred videos (in the trash view too, where a star is kept for when a video comes back).
  const [starred, setStarred] = useState(false);
  // When the videos were made: a campaign's renders of this week or month, whatever folder they went to.
  const [created, setCreated] = useState<VideoQuery["created"]>("all");
  // Cards or compact rows; remembered by this browser only (read after mounting, so the server render stays the grid).
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LAYOUT_KEY) === "list") setLayout("list");
    } catch {
      // Storage blocked (a private window, say): the grid it is.
    }
  }, []);
  function chooseLayout(next: "grid" | "list") {
    setLayout(next);
    try {
      window.localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // Not remembered, but the choice still holds for this visit.
    }
  }
  // Search as you type, one request per pause rather than per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setNeedle(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  // "Show more" extends the page for the current filters only: a new filter starts again
  // from the first page in the same render, with no extra request for the old extent.
  const filterKey = [needle, status, folder, batch ?? "", sort, trash ? "trash" : "", review, share, starred ? "starred" : "", created].join("\u0000");
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
    if (starred) params.set("starred", "1");
    if (created !== "all") params.set("created", created);
    return `/api/videos?${params}`;
  }, [limit, needle, status, folder, batch, sort, trash, review, share, starred, created]);
  // The share analytics of what the library shows now, every match rather than the page loaded, in the same order.
  const analyticsHref = useMemo(() => {
    const params = new URLSearchParams(path.split("?")[1]);
    params.delete("limit");
    params.delete("trash");
    const query = params.toString();
    return `/api/videos/analytics${query ? `?${query}` : ""}`;
  }, [path]);
  // The filtering, sorting, and paging happen on the server; the page only holds what it shows.
  const { data, loading, error, refetch } = useApi<VideoPage>(path, { pollMs: 6000, pollWhile: (d) => d.rendering > 0 });
  const videos = data?.videos ?? [];
  const folders = data?.folders ?? [];
  const folderCounts = data?.folderCounts ?? {};
  const hasAny = (data?.total ?? 0) > 0 || (data?.trashed ?? 0) > 0;
  const trashed = data?.trashed ?? 0;
  const remaining = data ? data.matched - videos.length : 0;
  // Whether a filter other than Starred narrows the list, for the empty state's advice.
  const narrowed = !!needle || status !== "all" || folder !== "all" || review !== "all" || share !== "all" || created !== "all" || !!batch;

  // Multi-select: move the chosen videos to a folder or delete them in one request.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  // "Schedule go-live" and "Set expiry" open a date and time field in the bar, one at a time; it is a local time, sent as an instant.
  // The share password, link settings, and folder fields take the same place in the bar, so only one of them is open at a time.
  const [timeField, setTimeField] = useState<"golive" | "expiry" | "password" | "settings" | "folder" | null>(null);
  const [timeDraft, setTimeDraft] = useState("");
  // The download button and email gate, each left as it is ("") or turned on or off on every selected video.
  const [linkSettings, setLinkSettings] = useState<{ download: "" | "on" | "off"; gate: "" | "on" | "off" }>({ download: "", gate: "" });
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
    setSelectAllFor(null);
    setTimeField(null);
    setTimeDraft("");
    setLinkSettings({ download: "", gate: "" });
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
  // The refusal of an over-limit selection goes once the selection is back within what one action takes.
  useEffect(() => {
    if (selected.size <= BULK_MAX) setBulkErr((note) => (note?.startsWith("One action takes up to") ? null : note));
  }, [selected]);
  // "Select all matching": the filters it was asked for. Every match (up to what one bulk action takes) is loaded onto the
  // page first and then selected, so the selection stays within what is shown and the bar's counts stay true.
  // `seen` is the page as it was when more was asked for: only a response after it can say whether everything is in.
  const [selectAllFor, setSelectAllFor] = useState<{ key: string; seen: VideoPage | null; seenError: string | null } | null>(null);
  const selectTarget = data ? Math.min(data.matched, BULK_MAX) : 0;
  const selectAllRef = useRef<HTMLButtonElement>(null);
  const selectShownRef = useRef<HTMLButtonElement>(null);
  function selectLoaded() {
    setSelected(new Set(videos.slice(0, BULK_MAX).map((v) => v.id)));
    setSelectAllFor(null);
    // The button goes once everything is loaded, which drops the focus to the page; keep the keyboard in the bar.
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) selectShownRef.current?.focus();
    });
  }
  useEffect(() => {
    if (selectAllFor === null) return;
    // The filters (or the search being typed) changed before the matches came in: nothing is selected for them.
    if (selectAllFor.key !== filterKey || q.trim() !== needle) return setSelectAllFor(null);
    // A failed load leaves the old page; give up rather than wait for a page that will not come.
    if (error && error !== selectAllFor.seenError) return setSelectAllFor(null);
    if (loading || !data || data === selectAllFor.seen) return;
    if (videos.length >= selectTarget) return selectLoaded();
    // More match now than when the button was pressed: load up to the new count (never past BULK_MAX), then select.
    if (limit < selectTarget) {
      setSelectAllFor({ key: filterKey, seen: data, seenError: error });
      setExtent({ key: filterKey, limit: selectTarget });
    } else setSelectAllFor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectAllFor, filterKey, q, needle, data, error, loading, videos, selectTarget, limit]);
  function selectAllMatching() {
    if (selectAllFor !== null || !data) return;
    // Everything that one action takes is already on the page.
    if (videos.length >= selectTarget) return selectLoaded();
    setSelectAllFor({ key: filterKey, seen: data, seenError: error });
    setExtent({ key: filterKey, limit: selectTarget });
  }
  // A new filter (or sort, which starts the page again) hides cards; drop the selection so bulk actions only ever touch
  // what is visible, and any "Select all matching" still loading for the old filters.
  useEffect(() => {
    setSelected(new Set());
    setSelectAllFor(null);
    setTimeField(null);
    setTimeDraft("");
    setLinkSettings({ download: "", gate: "" });
  }, [q, status, folder, batch, sort, trash, review, share, starred, created]);
  // The last purge empties both views; leave the trash so the "No videos yet" state (and the filter bar) comes back.
  useEffect(() => {
    if (trash && data && data.total === 0 && data.trashed === 0) setTrash(false);
  }, [data, trash]);
  async function bulk(action: BulkAction) {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const over = overSelection(ids.length, BULK_MAX);
    if (over) return setBulkErr(over);
    let targetFolder: string | undefined;
    if (action === "move" || action === "unfile") {
      // A name that only differs from an existing folder in case or spacing goes into that folder. The length is checked
      // after trimming, as the server does, so spaces pasted around a full-length name do not cut it short.
      targetFolder = action === "unfile" ? "" : folderFor(timeDraft, folders);
      if (action === "move" && !targetFolder) return;
      if (targetFolder.length > MAX_FOLDER_NAME) {
        setBulkErr(`Keep the folder name to ${MAX_FOLDER_NAME} characters`);
        return;
      }
    } else if (action === "delete" && !window.confirm(`Move ${ids.length} ${ids.length === 1 ? "video" : "videos"} to the trash? You can restore ${ids.length === 1 ? "it" : "them"} for ${TRASH_RETENTION_DAYS} days.`)) {
      return;
    } else if (action === "password") {
      const length = timeDraft.trim().length;
      if (length < SHARE_PASSWORD_MIN || length > SHARE_PASSWORD_MAX) {
        setBulkErr(`The share password needs ${SHARE_PASSWORD_MIN} to ${SHARE_PASSWORD_MAX} characters`);
        return;
      }
      // A video already locked gets the new password in place of its own, and its unlocked visitors must enter it again.
      const locked = videos.filter((v) => selected.has(v.id) && v.shareLocked).length;
      if (locked && !window.confirm(`${locked === 1 ? "1 selected video already has" : `${locked} selected videos already have`} a share password. Replace ${locked === 1 ? "it" : "them"} with this one? Visitors who unlocked ${locked === 1 ? "it" : "them"} must enter the new one.`)) return;
    } else if (action === "settings" && linkSettings.gate === "on" && !window.confirm(`Ask for an email before ${ids.length === 1 ? "the selected video plays" : `the ${ids.length} selected videos play`}? Everyone opening ${ids.length === 1 ? "its link or embed" : "their links or embeds"}, including people you have already sent ${ids.length === 1 ? "it" : "them"} to, sees the form first.`)) {
      return;
    } else if (action === "nopassword" && !window.confirm(`Remove the share password from ${ids.length} ${ids.length === 1 ? "video" : "videos"}? Anyone with ${ids.length === 1 ? "the link" : "their links"} can then watch.`)) {
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
        action === "move" || action === "unfile"
          ? { action: "move", ids, folder: targetFolder }
          : action === "share-off" || action === "share-on"
            ? { action: "share", ids, shareDisabled: action === "share-off" }
            : action === "star" || action === "unstar"
              ? { action: "star", ids, starred: action === "star" }
            : action === "schedule" || action === "golive"
              ? { action: "schedule", ids, shareStartsAt: action === "golive" ? null : new Date(timeDraft).toISOString() }
              : action === "expire" || action === "noexpiry"
                ? { action: "expire", ids, shareExpiresAt: action === "noexpiry" ? null : new Date(timeDraft).toISOString() }
                : action === "password" || action === "nopassword"
                  ? { action: "password", ids, sharePassword: action === "nopassword" ? null : timeDraft }
                  : action === "settings"
                    ? {
                        action,
                        ids,
                        ...(linkSettings.download ? { shareDownload: linkSettings.download === "on" } : {}),
                        ...(linkSettings.gate ? { shareGate: linkSettings.gate === "on" } : {}),
                      }
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
    const over = overSelection(ids.length, BULK_MAX);
    if (over) return setBulkErr(over);
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

  // The selection's failed renders, each started again as its own retry. Edited cuts are not retried, and a failed render
  // already retried is left for its newest copy (the server checks both too), so the same cards cannot be paid for twice.
  // Afterwards the selection holds only what is left to look at: the ones not started, and a copy that failed again.
  const retriedShown = new Set(videos.map((v) => v.retryOf).filter(Boolean));
  const failedSelected = videos.filter((v) => selected.has(v.id) && v.status === "failed" && !v.directed?.editOf && !retriedShown.has(v.id)).map((v) => v.id);
  useEffect(() => {
    if (busy !== null || !focusTrashToggle.current) return;
    focusTrashToggle.current = false;
    trashToggleRef.current?.focus();
  }, [busy]);

  // Everything in the trash back to the library, whatever the filters show. Nothing is lost, but their share links come
  // back online with them, so the count (read fresh) is confirmed first.
  async function restoreTheTrash() {
    setBusy("restoreall");
    setBulkErr(null);
    try {
      const { trashed: count } = await api<VideoPage>("/api/videos?trash=true&limit=1");
      if (!count) {
        focusTrashToggle.current = true;
        return void (await refetch());
      }
      const one = count === 1;
      const over = count > RESTORE_ALL_MAX ? ` Only ${RESTORE_ALL_MAX} come back at a time; restore all again for the rest.` : "";
      if (!window.confirm(`Bring ${one ? "the 1 video" : `all ${count} videos`} in the trash back to the library? ${one ? "Its share link and embeds work" : "Their share links and embeds work"} again as they were set.${over}`)) {
        if (count !== trashed) await refetch();
        return;
      }
      const { remaining } = await api<{ done: number; remaining: number }>("/api/videos/restore-all", { method: "POST" });
      await refetch();
      if (remaining) setBulkErr(`${remaining === 1 ? "1 video is" : `${remaining} videos are`} still in the trash; restore all again to bring ${remaining === 1 ? "it" : "them"} back.`);
      else focusTrashToggle.current = true;
    } catch (e) {
      // Some may have come back before the request failed; show where things stand.
      await refetch();
      setBulkErr(e instanceof Error ? e.message : "Could not restore the trash");
    } finally {
      setBusy(null);
    }
  }

  // Everything in the trash, whatever the filters show. The count is read fresh (a teammate may have trashed more since
  // the page loaded) and sent along, so the server refuses rather than delete videos the confirm never counted.
  async function emptyTheTrash() {
    setBusy("empty");
    setBulkErr(null);
    try {
      const { trashed: count } = await api<VideoPage>("/api/videos?trash=true&limit=1");
      if (!count) {
        // Emptied elsewhere meanwhile: the button goes, and the focus goes to the Trash toggle rather than the page.
        focusTrashToggle.current = true;
        return void (await refetch());
      }
      const what = count === 1 ? "the 1 video" : `all ${count} videos`;
      const one = count === 1;
      const over = count > EMPTY_TRASH_MAX ? ` Only ${EMPTY_TRASH_MAX} go at a time; empty it again for the rest.` : "";
      if (!window.confirm(`Delete ${what} in the trash for good? ${one ? "Its" : "Their"} comments, the emails ${one ? "its share page" : "their share pages"} collected, short clips, and the cleaned, lip-synced, and music copies made from ${one ? "it" : "them"} go too. This cannot be undone.${over}`)) {
        // The toolbar's count may be older than the one just asked about.
        if (count !== trashed) await refetch();
        return;
      }
      const { remaining } = await api<{ done: number; remaining: number }>("/api/videos/empty-trash", { method: "POST", body: JSON.stringify({ expected: count }) });
      await refetch();
      if (remaining) setBulkErr(`${remaining === 1 ? "1 video is" : `${remaining} videos are`} still in the trash; empty it again to delete ${remaining === 1 ? "it" : "them"}.`);
      // The button goes with the last of the trash; focus lands on the Trash toggle rather than the page.
      else focusTrashToggle.current = true;
    } catch (e) {
      // Some may have gone before the request failed; show what is left.
      await refetch();
      setBulkErr(e instanceof Error ? e.message : "Could not empty the trash");
    } finally {
      setBusy(null);
    }
  }

  async function retryFailed() {
    const ids = failedSelected.slice(0, MAX_RETRY_AT_ONCE);
    if (!ids.length) return;
    const over = failedSelected.slice(MAX_RETRY_AT_ONCE);
    const what = ids.length === 1 ? "1 failed render" : `${ids.length} failed renders`;
    if (!window.confirm(`Start ${what} again with the same settings?${over.length ? ` Only the first ${MAX_RETRY_AT_ONCE} are started now; the other ${over.length} stay selected.` : ""} Each counts toward this month's renders.`)) return;
    setBusy("retry");
    setBulkErr(null);
    try {
      const r = await api<{ started: Array<{ from: string; id: string }>; failedAgain: Array<{ from: string; id?: string; reason: string }>; skipped: Array<{ id: string; code: "not_failed" | "trashed" | "edited_cut" | "retried" | "allowance" }>; missing: string[] }>("/api/videos/retry", { method: "POST", body: JSON.stringify({ ids }) });
      await refetch();
      const count = (code: string) => r.skipped.filter((x) => x.code === code).length;
      const n = (k: number, one: string, many: string) => (k === 1 ? one : many.replace("#", String(k)));
      const notes: string[] = [];
      if (r.started.length) notes.push(`${n(r.started.length, "1 render was", "# renders were")} started again.`);
      if (count("allowance")) notes.push(`${n(count("allowance"), "1 was", "# were")} not started: this month's render allowance is used up.`);
      if (count("retried")) notes.push(`${n(count("retried"), "1 had", "# had")} already been started again; retry the newer copy if it failed too.`);
      if (count("edited_cut")) notes.push(`${n(count("edited_cut"), "1 is an edited cut", "# are edited cuts")}, which ${count("edited_cut") === 1 ? "is" : "are"} not retried; edit the original's scenes again instead.`);
      if (count("trashed")) notes.push(`${n(count("trashed"), "1 is", "# are")} in the trash; restore ${count("trashed") === 1 ? "it" : "them"} first.`);
      if (count("not_failed")) notes.push(`${n(count("not_failed"), "1 was", "# were")} no longer a failed render.`);
      if (r.failedAgain.length) {
        const reason = r.failedAgain[0].reason.replace(/\.$/, "");
        notes.push(r.failedAgain.length === 1 ? `1 render could not be started again: ${reason}.` : `${r.failedAgain.length} renders could not be started again (the first: ${reason}).`);
      }
      if (r.missing.length) notes.push(`${n(r.missing.length, "1 was", "# were")} no longer in the library.`);
      if (over.length) notes.push(`The other ${over.length} failed ${over.length === 1 ? "render is" : "renders are"} still selected; retry ${over.length === 1 ? "it" : "them"} next.`);
      // A copy refused straight away is the one to retry next (its original now counts as retried), so it is selected.
      const left = new Set([...r.skipped.map((x) => x.id), ...r.failedAgain.map((f) => f.id ?? f.from), ...over]);
      // Everything started reads as done: the new renders show in the library with no note needed.
      if (left.size || r.missing.length) {
        setBulkErr(notes.join(" "));
        setSelected(left);
      } else stopSelecting();
    } catch (e) {
      // Some may have started before the request failed; show them, so the next click does not start them twice.
      await refetch();
      setBulkErr(e instanceof Error ? e.message : "Could not start the renders again");
    } finally {
      setBusy(null);
    }
  }

  // The banner stays: after a refusal it says which of the two times to move, which may be the field being opened.
  function openTimeField(kind: "golive" | "expiry" | "password" | "settings" | "folder") {
    setTimeField(kind);
    setTimeDraft("");
    setLinkSettings({ download: "", gate: "" });
  }
  // A folder for every selected video: one of the library's folders (suggested as it is typed), a new one, or Unfiled.
  function folderForm() {
    const target = folderFor(timeDraft, folders);
    const joins = !!target && folders.includes(target);
    return (
      <form
        className="inline-flex flex-wrap items-center gap-1.5"
        data-testid="bulk-folder"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void bulk("move");
        }}
      >
        <input
          autoFocus
          list="bulk-folder-names"
          aria-label="Folder for the selected videos"
          aria-describedby="bulk-folder-hint"
          placeholder="Folder name"
          className={`${inputClass} w-44 py-1 text-xs`}
          value={timeDraft}
          onChange={(e) => {
            setTimeDraft(e.target.value);
            setBulkErr(null);
          }}
        />
        <datalist id="bulk-folder-names">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <span id="bulk-folder-hint" aria-live="polite" className="text-xs text-slate-500">
          {!target ? "" : joins ? `Into the existing “${target}”` : "A new folder"}
        </span>
        <Button type="submit" variant="secondary" className="px-2.5 py-1 text-xs" disabled={!selected.size || !target || busy !== null} loading={busy === "move"}>
          Move
        </Button>
        <Button type="button" variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => bulk("unfile")} disabled={!selected.size || busy !== null} loading={busy === "unfile"} title="Take the selected videos out of their folders">
          Unfiled
        </Button>
        <button
          type="button"
          onClick={() => {
            setTimeField(null);
            setTimeDraft("");
          }}
          disabled={busy !== null}
          aria-label="Close folder"
          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
    );
  }
  // A password for every selected link: typed once, kept only as each video's own salted hash.
  function passwordForm() {
    return (
      <form
        className="inline-flex flex-wrap items-center gap-1.5"
        data-testid="bulk-password"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void bulk("password");
        }}
      >
        <input
          type="password"
          autoComplete="new-password"
          aria-label="Share password for the selected videos"
          placeholder={`${SHARE_PASSWORD_MIN}–${SHARE_PASSWORD_MAX} characters`}
          className={`${inputClass} w-44 py-1 text-xs`}
          value={timeDraft}
          maxLength={SHARE_PASSWORD_MAX}
          onChange={(e) => {
            setTimeDraft(e.target.value);
            setBulkErr(null);
          }}
        />
        <Button type="submit" variant="secondary" className="px-2.5 py-1 text-xs" disabled={!selected.size || !timeDraft.trim() || busy !== null} loading={busy === "password"} title="Visitors to the selected videos' share pages must enter this password before the video plays">
          Protect
        </Button>
        <Button type="button" variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => bulk("nopassword")} disabled={!selected.size || busy !== null} loading={busy === "nopassword"} title="Remove the share password from the selected videos">
          Remove password
        </Button>
        <button
          type="button"
          onClick={() => {
            setTimeField(null);
            setTimeDraft("");
          }}
          disabled={busy !== null}
          aria-label="Close share password"
          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
    );
  }
  // The share page's download button and email gate, for every selected video; a setting left as it is is not sent.
  function settingsForm() {
    const choice = (label: string, key: "download" | "gate") => (
      <select
        aria-label={label}
        value={linkSettings[key]}
        onChange={(e) => setLinkSettings((prev) => ({ ...prev, [key]: e.target.value as "" | "on" | "off" }))}
        className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
      >
        <option value="">{key === "download" ? "Viewers can download: leave as is" : "Ask for an email before playing: leave as is"}</option>
        <option value="on">{key === "download" ? "Viewers can download: yes" : "Ask for an email before playing: yes"}</option>
        <option value="off">{key === "download" ? "Viewers can download: no" : "Ask for an email before playing: no"}</option>
      </select>
    );
    return (
      <form
        className="inline-flex flex-wrap items-center gap-1.5"
        data-testid="bulk-settings"
        onSubmit={(e) => {
          e.preventDefault();
          void bulk("settings");
        }}
      >
        {choice("Download button for the selected videos", "download")}
        {choice("Ask for email for the selected videos", "gate")}
        <Button type="submit" variant="secondary" className="px-2.5 py-1 text-xs" disabled={!selected.size || (!linkSettings.download && !linkSettings.gate) || busy !== null} loading={busy === "settings"}>
          Apply
        </Button>
        <button
          type="button"
          onClick={() => {
            setTimeField(null);
            setLinkSettings({ download: "", gate: "" });
          }}
          disabled={busy !== null}
          aria-label="Close link settings"
          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
    );
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
              {/* Each with how many videos it holds in this view, whatever the other filters, so an empty pick is not a surprise. */}
              <option value="all">All folders{withCount(trash ? trashed : (data?.total ?? 0))}</option>
              <option value="unfiled">Unfiled{withCount(countOf(folderCounts, ""))}</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                  {withCount(countOf(folderCounts, f))}
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
              <span role="status" className={`px-1 text-xs font-medium ${selected.size > BULK_MAX ? "text-amber-800" : "text-slate-700"}`}>
                {selected.size} selected{selected.size > BULK_MAX ? `, over the ${BULK_MAX} one action takes` : ""}
              </span>
              <button
                ref={selectShownRef}
                type="button"
                onClick={() => {
                  // Never more than one action takes, so every button in the bar can act on what is chosen.
                  setSelected(new Set(videos.slice(0, BULK_MAX).map((v) => v.id)));
                  if (videos.length > BULK_MAX) setBulkErr(`Selected the first ${BULK_MAX} of the ${videos.length} shown, as one action takes up to ${BULK_MAX}.`);
                }}
                disabled={busy !== null} className="text-xs text-brand-700 hover:underline disabled:opacity-50">
                Select all shown
              </button>
              {remaining > 0 && videos.length < BULK_MAX && (
                <button
                  ref={selectAllRef}
                  type="button"
                  onClick={selectAllMatching}
                  disabled={busy !== null}
                  // While the matches load it stays focusable (marked, ignoring clicks), as the studio's buttons do.
                  aria-disabled={selectAllFor !== null || undefined}
                  title={data && data.matched > BULK_MAX ? `One bulk action takes up to ${BULK_MAX} videos; the first ${BULK_MAX} in this order are loaded and selected` : "Loads every video that matches the filters and selects them all"}
                  className="text-xs text-brand-700 hover:underline disabled:opacity-50 aria-disabled:cursor-wait"
                >
                  {selectAllFor !== null ? "Selecting…" : data && data.matched > BULK_MAX ? `Select the first ${BULK_MAX} matching` : `Select all ${data?.matched ?? 0} matching`}
                </button>
              )}
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
              {failedSelected.length > 0 && (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void retryFailed()} disabled={busy !== null} loading={busy === "retry"} title={`Start the selected failed renders again with the same settings, up to ${MAX_RETRY_AT_ONCE} at a time; each counts toward this month's renders`}>
                  <RotateCcw className="h-3.5 w-3.5" /> Retry failed ({failedSelected.length})
                </Button>
              )}
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("star")} disabled={!selected.size || busy !== null} loading={busy === "star"} title="Star the selected videos to find them again with the Starred filter">
                <Star className="h-3.5 w-3.5" /> Star
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => bulk("unstar")} disabled={!selected.size || busy !== null} loading={busy === "unstar"} title="Take the stars off the selected videos">
                <StarOff className="h-3.5 w-3.5" /> Unstar
              </Button>
              {timeField === "folder" ? (
                folderForm()
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => openTimeField("folder")} disabled={!selected.size || busy !== null}>
                  <FolderInput className="h-3.5 w-3.5" /> Move to folder
                </Button>
              )}
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
              {timeField === "password" ? (
                passwordForm()
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => openTimeField("password")} disabled={!selected.size || busy !== null}>
                  <KeyRound className="h-3.5 w-3.5" /> Password
                </Button>
              )}
              {timeField === "settings" ? (
                settingsForm()
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => openTimeField("settings")} disabled={!selected.size || busy !== null} title="Let viewers of the selected videos download them, or ask them for an email before playing, or stop either">
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Download &amp; email
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
            <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setSelecting(true)} disabled={busy === "empty" || busy === "restoreall"}>
              <CheckSquare className="h-3.5 w-3.5" /> Select
            </Button>
          )}
          {trash && !selecting && trashed > 0 && canEdit && (
            <>
              <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => void restoreTheTrash()} disabled={busy !== null && busy !== "restoreall"} loading={busy === "restoreall"} title="Brings every video in the trash back to the library, whatever the filters show; their share links work again">
                <ArchiveRestore className="h-3.5 w-3.5" /> Restore all
              </Button>
              <Button variant="danger" className="px-3 py-1.5 text-xs" onClick={() => void emptyTheTrash()} disabled={busy !== null && busy !== "empty"} loading={busy === "empty"} title="Deletes every video in the trash for good, whatever the filters show">
                <Trash2 className="h-3.5 w-3.5" /> Empty trash
              </Button>
            </>
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
            ref={trashToggleRef}
            disabled={busy === "empty" || busy === "restoreall"}
            onClick={() => {
              setTrash((t) => !t);
              // Trashed links answer "not found" whatever they were set to, so the share filter has no place there.
              setShare("all");
            }}
            aria-pressed={trash}
            data-testid="trash-toggle"
            title={`Videos you deleted; each is removed for good ${TRASH_RETENTION_DAYS} days after it was trashed`}
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium disabled:opacity-50 ${trash ? "bg-rose-700 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            <Trash2 className="h-3 w-3" /> Trash{trashed ? ` (${trashed})` : ""}
          </button>
          <button
            type="button"
            onClick={() => setStarred((s) => !s)}
            aria-pressed={starred}
            data-testid="starred-toggle"
            title="Only starred videos"
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${starred ? "bg-amber-800 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            <Star className={`h-3 w-3 ${starred ? "fill-white" : ""}`} /> Starred
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
          <select aria-label="Filter by date made" value={created} onChange={(e) => setCreated(e.target.value as VideoQuery["created"])} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
            <option value="all">Made any time</option>
            <option value="7d">Made in the last 7 days</option>
            <option value="30d">Made in the last 30 days</option>
            <option value="90d">Made in the last 90 days</option>
          </select>
          {/* Rounded children rather than a clipping parent, so a focus ring shows whole. */}
          <span className="inline-flex rounded-full border border-slate-200 bg-white" role="group" aria-label="Layout">
            <button type="button" onClick={() => chooseLayout("grid")} aria-pressed={layout === "grid"} title="Grid" className={`rounded-l-full px-2 py-1 ${layout === "grid" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">Grid</span>
            </button>
            <button type="button" onClick={() => chooseLayout("list")} aria-pressed={layout === "list"} title="List" className={`rounded-r-full px-2 py-1 ${layout === "list" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
              <List className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">List</span>
            </button>
          </span>
          {/* Shown only when the file would hold a video: the share analytics of what the library shows, in its order. */}
          {!trash && (data?.matched ?? 0) > 0 && (
            <a href={analyticsHref} download className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50" title="Views, watch-through, clicks, and share links for the videos shown, every match and in this order" data-testid="library-analytics">
              <Download className="h-3 w-3" aria-hidden /> Download analytics
            </a>
          )}
          <select aria-label="Sort videos" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="ml-auto rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A–Z</option>
            <option value="views">Most viewed</option>
            <option value="viewed">Latest viewer visit</option>
            <option value="length">Longest first</option>
          </select>
        </div>
      )}
      {loading && !data ? (
        layout === "list" ? (
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 rounded-none" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="aspect-[16/11]" />
            ))}
          </div>
        )
      ) : videos.length === 0 ? (
        <EmptyState
          icon={trash ? <Trash2 className="h-8 w-8" /> : <Clapperboard className="h-8 w-8" />}
          title={trash ? (trashed ? "No trashed videos match" : "The trash is empty") : hasAny ? "No videos match" : "No videos yet"}
          body={
            trash
              ? // Trashed videos the filters hide are still counted on the toggle, so say what hides them.
                trashed && (narrowed || starred)
                ? `Try a different search, status, folder, or date${starred ? ", or turn off Starred" : ""}.`
                : `Deleted videos wait here for ${TRASH_RETENTION_DAYS} days before they are removed for good.`
              : hasAny
                ? starred && !narrowed
                  ? "No video is starred yet; star one from its page, or several from Select."
                  : `Try a different search, status, folder, date, ${starred ? "share link, or turn off Starred" : "or share link"}.`
                : "Your rendered videos will show up here."
          }
        />
      ) : (
        <>
          {layout === "list" ? (
            <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200" data-testid="video-list">
              {videos.map((v) => (
                <VideoRow key={v.id} video={v} selectable={selecting} selected={selected.has(v.id)} onToggle={() => busy === null && toggle(v.id)} />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {videos.map((v) => (
                <VideoCard key={v.id} video={v} selectable={selecting} selected={selected.has(v.id)} onToggle={() => busy === null && toggle(v.id)} />
              ))}
            </div>
          )}
          {remaining > 0 && (
            <div className="mt-6 flex flex-col items-center gap-2 text-sm text-slate-500">
              <span>Showing {videos.length} of {data?.matched}</span>
              {videos.length < LIBRARY_PAGE_MAX ? (
                <Button variant="secondary" onClick={() => setExtent({ key: filterKey, limit: Math.min(limit + PAGE, LIBRARY_PAGE_MAX) })} loading={loading} data-testid="load-more">
                  Show {Math.min(remaining, PAGE, LIBRARY_PAGE_MAX - limit)} more
                </Button>
              ) : (
                <span role="status" data-testid="page-cap">That is as many as the library shows at once; search or filter to find the rest.</span>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
