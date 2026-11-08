"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore, AtSign, Tag, Captions, ImageIcon, CheckSquare, FileText, Clapperboard, Clock, Copy, LayoutGrid, List, Download, FolderInput, KeyRound, MousePointerClick, QrCode, SlidersHorizontal, FolderMinus, FolderPen, Link2, Link2Off, MessageSquare, RotateCcw, Star, StarOff, TimerOff, Trash2, X } from "lucide-react";
import { CREATED_WITHIN_DAYS, LENGTH_FILTERS, LIBRARY_SEARCH_MAX, SHAPE_FILTERS, SHARE_FILTERS, VIEWED_FILTERS, api, clickSelect, folderFor, nextShareChange, overSelection, libraryAddress, libraryFilterKey, withoutLibraryFilters } from "@/lib/client";
import { isSearchKey, libraryKey, readSingleKeyShortcuts, typesText } from "@/lib/shortcuts";
import { useMobileNav } from "@/components/MobileNav";
import { fileToCover } from "@/lib/image-upload";
import { isApple } from "@/components/QuickFind";
import { VideoCard, VideoRow } from "@/components/VideoCard";
import { FolderShare } from "@/components/FolderShare";
import { VIDEO_TAGS_MAX, VIDEO_TAG_MAX, cleanTags, sameTag, tagText } from "@/lib/tags";
import { SavedViews } from "@/components/SavedViews";
import { Button, EmptyState, ErrorBanner, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { freshVideoIds, readSeenMark } from "@/lib/comment-list";
import { useCanEdit, useWorkspaceRole } from "@/hooks/useCanEdit";
import type { VideoPage, VideoQuery } from "@/lib/services/videos";
import { BULK_MAX, EMPTY_TRASH_MAX, LIBRARY_PAGE_MAX, MAX_FOLDER_NAME, MAX_RETRY_AT_ONCE, RESTORE_ALL_MAX, SHARE_CTA_LABEL_MAX, SHARE_CTA_URL_MAX, SHARE_PASSWORD_MAX, SHARE_PASSWORD_MIN, TRASH_RETENTION_DAYS, type VideoStatus } from "@/lib/types";

const STATUSES: Array<"all" | VideoStatus> = ["all", "processing", "completed", "failed"];
const CREATED_FILTERS = Object.keys(CREATED_WITHIN_DAYS) as (keyof typeof CREATED_WITHIN_DAYS)[];
const REVIEW_FILTERS = ["pending", "approved", "changes", "none"] as const;
const COMMENT_FILTERS = ["open", "mentions"] as const;
type CommentFilter = VideoQuery["comments"];
const commentFilterFrom = (asked: string | null): CommentFilter => fromAddress(asked, COMMENT_FILTERS);

/** A filter's value from the page's address when the library knows it, else "all". */
function fromAddress<T extends string>(asked: string | null, known: readonly T[]): T | "all" {
  return known.includes(asked as T) ? (asked as T) : "all";
}
type SortKey = VideoQuery["sort"];
/** Where this browser keeps the library's layout (grid of cards or list of rows). */
const LAYOUT_KEY = "avatar-studio:library-layout";
/** Cards per request; "Show more" asks for another page's worth. */
const PAGE = 48;

/** " (12)" after a folder's name in the picker. */
const withCount = (n: number) => ` (${n})`;
/** A folder's count, read as the folder's own entry only: a folder named "constructor" is not the object's prototype. */
const countOf = (counts: Record<string, number>, folder: string) => (Object.hasOwn(counts, folder) && typeof counts[folder] === "number" ? counts[folder] : 0);

/** The presenter or voice filter the address asks for (`?presenter=<avatar id>`, `?voice=<voice id>`), or "all"; a blank one is no filter. */
const presenterFrom = (asked: string | null) => asked?.trim().slice(0, 120) || "all";
/**
 * The folder the address asks for (`?folder=`, as Home's shared folders card links): its name as the library's folder
 * select holds it, "unfiled" for an empty one (as the API reads it), or every folder when there is none.
 */
const folderFrom = (asked: string | null) => (asked === null ? "all" : asked.trim().slice(0, MAX_FOLDER_NAME) || "unfiled");
/**
 * The tag the address asks for (`?tag=`), cut to the characters a tag takes (whole characters, as the server counts them),
 * or "" for any tag: a blank one is no filter, and "" can never be a tag, so a tag named "all" is still one to filter on.
 */
const tagFrom = (asked: string | null) => Array.from(asked?.trim() ?? "").slice(0, VIDEO_TAG_MAX).join("").trim();
/** The search the address asks for (`?q=`), cut to the length the server takes. */
const searchFrom = (asked: string | null) => (asked ?? "").slice(0, LIBRARY_SEARCH_MAX);

/** A time as a datetime-local field holds it: the browser's local date and time, to the minute. */
function localMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type BulkAction = "delete" | "move" | "share-off" | "share-on" | "schedule" | "golive" | "expire" | "noexpiry" | "restore" | "purge" | "links" | "password" | "nopassword" | "settings" | "retry" | "star" | "unstar" | "empty" | "restoreall" | "unfile" | "cta" | "nocta" | "copylinks" | "qrcodes" | "captions" | "scripts" | "cover" | "nocover" | "tag" | "untag";

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
  const [q, setQ] = useState(() => searchFrom(params.get("q")));
  const [needle, setNeedle] = useState(() => searchFrom(params.get("q")).trim());
  // Home's notices open the library at `?share=`, `?status=`, `?created=`, `?review=`, and `?comments=` (`open` or `mentions`), `?shape=`
  // (landscape, portrait, or square), `?length=` (short, medium, or long), and `?viewed=` (yes or no) work the same way, and
  // the video page's presenter and voice links at `?presenter=` (an avatar id) and `?voice=` (a voice id), read
  // too), as are `?folder=`, `?starred=1`, and `?q=`, again whenever the address changes (the sidebar's My videos goes
  // back to every video); a value the library does not know is ignored. The page writes them back as they change (below).
  const askedFilters = libraryFilterKey(params);
  const [status, setStatus] = useState<"all" | VideoStatus>(() => fromAddress(params.get("status"), STATUSES));
  const [folder, setFolder] = useState<string>(() => folderFrom(params.get("folder"))); // "all" | "unfiled" | folder name
  // Only the videos one presenter appears in, by avatar id: "all" for any.
  const [presenter, setPresenter] = useState<string>(() => presenterFrom(params.get("presenter")));
  // Only the videos that speak in one voice, by voice id: "all" for any.
  const [voice, setVoice] = useState<string>(() => presenterFrom(params.get("voice")));
  // Only the videos carrying one tag (case aside): "" for any.
  const [tagFilter, setTagFilter] = useState<string>(() => tagFrom(params.get("tag")));
  const [sort, setSort] = useState<SortKey>("newest");
  // Reviews exist only in a workspace, so the filter shows there.
  const where = useWorkspaceRole();
  const inWorkspace = !!where?.workspaceId;
  // Saved views are each person's own, kept apart for each space they work in.
  const viewSpace = where ? (where.workspaceId ? `${where.workspaceId}:${where.userId}` : where.userId) : null;
  // Viewers can browse the trash but not empty it (the server refuses them too).
  const canEdit = useCanEdit() !== false;
  const trashToggleRef = useRef<HTMLButtonElement>(null);
  // Set once the trash is emptied; the toggle takes the focus when it is enabled again, after the request.
  const focusTrashToggle = useRef(false);
  const [review, setReview] = useState<VideoQuery["review"]>(() => fromAddress(params.get("review"), REVIEW_FILTERS));
  // Share link state, as the cards' badges say; with the bulk go-live and expiry it finds a campaign's links to fix.
  const [share, setShare] = useState<VideoQuery["share"]>(() => fromAddress(params.get("share"), SHARE_FILTERS));
  // The trash is its own view of the same page: same search, status, and folder filters, different bulk actions.
  const [trash, setTrash] = useState(false);
  // Only the starred videos (in the trash view too, where a star is kept for when a video comes back).
  const [starred, setStarred] = useState(() => params.get("starred") === "1");
  // Only the videos with a review note no one has resolved yet (what the team still has to act on), or only those with an
  // open thread that names the reader (what is waiting on them); one or the other.
  const [commentFilter, setCommentFilter] = useState<CommentFilter>(() => commentFilterFrom(params.get("comments")));
  // When the videos were made: a campaign's renders of this week or month, whatever folder they went to.
  const [created, setCreated] = useState<VideoQuery["created"]>(() => fromAddress(params.get("created"), CREATED_FILTERS));
  // The shape a video was made in: the portrait cuts for social, say, apart from the landscape ones.
  const [shape, setShape] = useState<VideoQuery["shape"]>(() => fromAddress(params.get("shape"), SHAPE_FILTERS));
  // How long a finished video runs: the short cuts for social apart from the longer walkthroughs.
  const [lengthFilter, setLengthFilter] = useState<VideoQuery["length"]>(() => fromAddress(params.get("length"), LENGTH_FILTERS));
  // Whether a finished video's share page has been viewed: with a batch, the recipients still to follow up.
  const [viewed, setViewed] = useState<VideoQuery["viewed"]>(() => fromAddress(params.get("viewed"), VIEWED_FILTERS));
  const [filtersAsked, setFiltersAsked] = useState(askedFilters);
  // The filters as the page writes them into its address (below): the search once typing pauses, Unfiled as an empty folder.
  const filtersInAddress = {
    q: needle ? needle.slice(0, LIBRARY_SEARCH_MAX) : null,
    status: status === "all" ? null : status,
    folder: folder === "all" ? null : folder === "unfiled" ? "" : folder,
    presenter: presenter === "all" ? null : presenter,
    voice: voice === "all" ? null : voice,
    tag: tagFilter || null,
    review: review === "all" ? null : review,
    share: share === "all" ? null : share,
    comments: commentFilter === "all" ? null : commentFilter,
    created: created === "all" ? null : created,
    shape: shape === "all" ? null : shape,
    length: lengthFilter === "all" ? null : lengthFilter,
    viewed: viewed === "all" ? null : viewed,
    starred: starred ? "1" : null,
  };
  // The page's own writes to its address (below) still to come back through the router, oldest first.
  const ownWrites = useRef<string[]>([]);
  // The search and filters as a saved view keeps them (the search once typing pauses).
  const viewNow = libraryAddress("", filtersInAddress)?.replace(/^\?/, "") ?? "";
  if (askedFilters !== filtersAsked) {
    setFiltersAsked(askedFilters);
    // One of the page's own writes coming back is not read again (that would undo what is typed in the search box while
    // its pause runs, or a filter changed since an earlier write); it and any earlier ones are done with. Anything else
    // (a link, the sidebar's My videos, Back) is read when it says something else than the filters on the page.
    const own = ownWrites.current.lastIndexOf(askedFilters);
    // An address from elsewhere ends any wait for the page's own: writes that came back together with it are not looked for.
    if (own < 0) ownWrites.current = [];
    if (own >= 0) ownWrites.current.splice(0, own + 1);
    else if (libraryAddress(params.toString(), filtersInAddress) !== null) {
      setQ(searchFrom(params.get("q")));
      setNeedle(searchFrom(params.get("q")).trim());
      setStarred(params.get("starred") === "1");
      setShare(fromAddress(params.get("share"), SHARE_FILTERS));
      setStatus(fromAddress(params.get("status"), STATUSES));
      setCreated(fromAddress(params.get("created"), CREATED_FILTERS));
      setShape(fromAddress(params.get("shape"), SHAPE_FILTERS));
      setLengthFilter(fromAddress(params.get("length"), LENGTH_FILTERS));
      setViewed(fromAddress(params.get("viewed"), VIEWED_FILTERS));
      setReview(fromAddress(params.get("review"), REVIEW_FILTERS));
      setCommentFilter(commentFilterFrom(params.get("comments")));
      setPresenter(presenterFrom(params.get("presenter")));
      setVoice(presenterFrom(params.get("voice")));
      setTagFilter(tagFrom(params.get("tag")));
      setFolder(folderFrom(params.get("folder")));
    }
  }
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
  // The filters go into the page's address as they change (the search once typing pauses), in place of the entry rather
  // than as a new one, so a reload, a copied link, or Back from a video opens the library as it was left. Whatever else
  // the address holds (a batch's results, say) stays.
  useEffect(() => {
    const next = libraryAddress(window.location.search, filtersInAddress);
    if (next === null) return;
    // Once the router has caught up with the address, nothing written earlier is still to come back (several writes can
    // come back as one, the last).
    if (askedFilters === libraryFilterKey(new URLSearchParams(window.location.search))) ownWrites.current = [];
    try {
      // Written to the history directly, as Clear filters does: Next keeps the page's search params in step with it.
      window.history.replaceState(null, "", `${window.location.pathname}${next}${window.location.hash}`);
      ownWrites.current = [...ownWrites.current.slice(-19), libraryFilterKey(new URLSearchParams(next))];
    } catch {
      // Some browsers refuse a burst of history writes; the filters still hold on the page.
    }
    // filtersInAddress is made from these on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, status, folder, presenter, voice, tagFilter, review, share, commentFilter, created, shape, lengthFilter, viewed, starred]);
  // "Show more" extends the page for the current filters only: a new filter starts again
  // from the first page in the same render, with no extra request for the old extent.
  const filterKey = [needle, status, folder, batch ?? "", sort, trash ? "trash" : "", review, share, starred ? "starred" : "", commentFilter === "all" ? "" : commentFilter, created, shape, lengthFilter, viewed, presenter, voice, tagFilter].join("\u0000");
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
    if (commentFilter !== "all") params.set("comments", commentFilter);
    if (created !== "all") params.set("created", created);
    if (shape !== "all") params.set("shape", shape);
    if (lengthFilter !== "all") params.set("length", lengthFilter);
    if (viewed !== "all") params.set("viewed", viewed);
    if (presenter !== "all") params.set("presenter", presenter);
    if (voice !== "all") params.set("voice", voice);
    if (tagFilter) params.set("tag", tagFilter);
    return `/api/videos?${params}`;
  }, [limit, needle, status, folder, batch, sort, trash, review, share, starred, commentFilter, created, shape, lengthFilter, viewed, presenter, voice, tagFilter]);
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
  // Videos whose comments are new since the reader last opened them here: what someone else last wrote, against the mark
  // each video page keeps in this browser. Worked out with the page's data, which only ever arrives in the browser.
  const freshComments = useMemo(() => new Set(freshVideoIds(data?.latestComment, data?.you, readSeenMark)), [data]);
  // A shown video's link going live or expiring changes its card (Copy link, badges) with nothing to read from the
  // server, so the page draws itself again then, rather than waiting for a reload; filtered by share link, the list
  // itself may change (a link gone live no longer "Going live later"), so it is read again instead. A tab hidden for a
  // while (or a computer asleep) holds its timers back, so the page looks again when it is shown.
  const [shareTick, setShareTick] = useState(0);
  const shareFiltered = share !== "all";
  useEffect(() => {
    const wait = nextShareChange(data?.videos ?? []);
    if (wait === undefined) return;
    const t = setTimeout(() => (shareFiltered ? void refetch() : setShareTick((n) => n + 1)), wait + 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, shareTick, shareFiltered]);
  useEffect(() => {
    const shown = () => document.visibilityState === "visible" && setShareTick((n) => n + 1);
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, []);
  // What a card's Copy link did, said once for the whole page rather than by each card; cleared first, so the same
  // words said again are heard again. A link that can no longer be sent means the list is out of date, so it is read again.
  const [cardNote, setCardNote] = useState("");
  const cardCopyNote = (note: string, stale: boolean) => {
    setCardNote("");
    requestAnimationFrame(() => setCardNote(note));
    if (stale) void refetch();
  };
  const videos = data?.videos ?? [];
  const folders = data?.folders ?? [];
  const folderCounts = data?.folderCounts ?? {};
  const presenters = data?.presenters ?? [];
  const voicesUsed = data?.voices ?? [];
  const tagsUsed = data?.tags ?? [];
  const hasAny = (data?.total ?? 0) > 0 || (data?.trashed ?? 0) > 0;
  const trashed = data?.trashed ?? 0;
  const remaining = data ? data.matched - videos.length : 0;
  // The on/off filters an empty list names, so the way back is said.
  const toggledOn = [starred && "Starred", commentFilter === "open" && "Open comments", commentFilter === "mentions" && "Mentions me"].filter((t): t is string => !!t);
  // Whether a filter other than Starred, Open comments, and Mentions me narrows the list, for the empty state's advice.
  const narrowed = !!needle || status !== "all" || folder !== "all" || presenter !== "all" || voice !== "all" || !!tagFilter || review !== "all" || share !== "all" || created !== "all" || shape !== "all" || lengthFilter !== "all" || viewed !== "all" || !!batch;
  // Any filter at all, a search being typed included: what Clear filters takes back. The sort, the layout, and the trash
  // view are not filters, so they stay.
  const filtersOn = narrowed || toggledOn.length > 0 || q.trim() !== "";
  const [filterNote, setFilterNote] = useState("");
  function clearFilters() {
    setQ("");
    setNeedle("");
    setStatus("all");
    setFolder("all");
    setPresenter("all");
    setVoice("all");
    setTagFilter("");
    setReview("all");
    setShare("all");
    setCreated("all");
    setShape("all");
    setLengthFilter("all");
    setViewed("all");
    setStarred(false);
    setCommentFilter("all");
    // Filters the address asked for (Home's notices, the video page's links, a batch) leave it too, so a reload or the
    // back button does not bring them back unasked.
    // Written to the history at once (Next keeps the page's search params in step with it), rather than through the
    // router, which would leave the old address, and a batch's results, in place until its navigation settles.
    const rest = withoutLibraryFilters(params.toString());
    if (rest !== null) window.history.replaceState(null, "", `${window.location.pathname}${rest}`);
    // Cleared first, so the same words said again are heard again; the search box is where the next filter starts.
    setFilterNote("");
    requestAnimationFrame(() => setFilterNote("Filters cleared"));
    searchRef.current?.focus();
  }

  // Multi-select: move the chosen videos to a folder or delete them in one request.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  // "Schedule go-live" and "Set expiry" open a date and time field in the bar, one at a time; it is a local time, sent as an instant.
  // The share password, link settings, and folder fields take the same place in the bar, so only one of them is open at a time.
  const [timeField, setTimeField] = useState<"golive" | "expiry" | "password" | "settings" | "folder" | "cta" | "cover" | "tags" | null>(null);
  // The call-to-action button's text and link, for every selected video's share page.
  const [ctaDraft, setCtaDraft] = useState({ label: "", url: "" });
  // The picture chosen for every selected video's cover, made ready to send (a JPEG fitted in 1280px) when it is picked.
  const [coverDraft, setCoverDraft] = useState<{ name: string; dataUrl: string } | null>(null);
  // A picture still being read; each pick is numbered so only the latest one, picked while the field is open, is kept.
  const [coverReading, setCoverReading] = useState(false);
  const coverPick = useRef(0);
  const [timeDraft, setTimeDraft] = useState("");
  // The download button and email gate, each left as it is ("") or turned on or off on every selected video.
  const [linkSettings, setLinkSettings] = useState<{ download: "" | "on" | "off"; gate: "" | "on" | "off" }>({ download: "", gate: "" });
  // The video clicked last while selecting, where a Shift+click's run of cards starts. It is forgotten whenever the
  // selection is replaced rather than clicked, so a run never starts from a card the user did not just choose.
  const anchor = useRef<string | null>(null);
  // From `selected` as rendered rather than an updater, as the anchor moves in step with it.
  function click(id: string, shift: boolean) {
    const done = clickSelect(selected, videos.map((v) => v.id), anchor.current, id, shift);
    anchor.current = done.anchor;
    setSelected(done.selected);
  }
  // Never more than one action takes, so every button in the bar can act on what is chosen.
  function selectShown() {
    setSelected(new Set(videos.slice(0, BULK_MAX).map((v) => v.id)));
    anchor.current = null;
    if (videos.length > BULK_MAX) setBulkErr(`Selected the first ${BULK_MAX} of the ${videos.length} shown, as one action takes up to ${BULK_MAX}.`);
  }
  // The bar's field (a folder, a time, the password, or the link settings) takes its button's place, and closes back
  // onto that button (`data-opens`), so the keyboard stays where it was; with that button disabled (nothing is
  // selected any more), onto "Select all shown".
  const barRef = useRef<HTMLDivElement>(null);
  function closeTimeField() {
    const kind = timeField;
    setTimeField(null);
    setTimeDraft("");
    setLinkSettings({ download: "", gate: "" });
    setCtaDraft({ label: "", url: "" });
    setCoverDraft(null);
    coverPick.current += 1;
    setCoverReading(false);
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const opener = barRef.current?.querySelector<HTMLButtonElement>(`[data-opens='${kind}']`);
      if (opener && !opener.disabled) opener.focus();
      else selectShownRef.current?.focus();
    });
  }
  const selectButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // "/" moved the focus to the search box and is still held: its repeats are not typed into the box.
  const slashHeld = useRef(false);
  // The small-screen menu covers the page while open; "/" does not reach behind it.
  const { open: navOpen } = useMobileNav();
  // Escape and Ctrl/⌘+A while selecting (see libraryKey), read through a ref, set once each render commits, so the
  // listener sees the state on screen. In Firefox an Escape that closes the folder field's list of suggestions also
  // reaches here and closes the field; Chromium keeps that Escape to the list.
  const onLibraryKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    onLibraryKey.current = (e) => {
      if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const editable = !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
      const inField = !!el && !!barRef.current?.contains(el) && !!el.closest("form");
      // "/" jumps to the search box, with what it holds selected so typing replaces it; a library with nothing in it has none.
      if (!navOpen && searchRef.current && isSearchKey(e, { editable: typesText(el), enabled: readSingleKeyShortcuts() })) {
        e.preventDefault();
        slashHeld.current = true;
        searchRef.current.focus();
        searchRef.current.select();
        return;
      }
      const does = libraryKey(e, { apple: isApple(), selecting, busy: busy !== null, fieldOpen: timeField !== null, inField, editable, inSelect: el?.tagName === "SELECT" });
      if (!does) return;
      e.preventDefault();
      if (does === "close-field") closeTimeField();
      else if (does === "select-all") selectShown();
      else {
        stopSelecting();
        requestAnimationFrame(() => selectButtonRef.current?.focus());
      }
    };
  });
  useEffect(() => {
    const listen = (e: KeyboardEvent) => onLibraryKey.current(e);
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, []);
  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
    anchor.current = null;
    setSelectAllFor(null);
    setTimeField(null);
    setTimeDraft("");
    setLinkSettings({ download: "", gate: "" });
    setCtaDraft({ label: "", url: "" });
    setCoverDraft(null);
    coverPick.current += 1;
    setCoverReading(false);
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
    anchor.current = null;
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
    anchor.current = null;
    setSelectAllFor(null);
    setTimeField(null);
    setTimeDraft("");
    setLinkSettings({ download: "", gate: "" });
    setCtaDraft({ label: "", url: "" });
    setCoverDraft(null);
    coverPick.current += 1;
    setCoverReading(false);
  }, [q, status, folder, batch, sort, trash, review, share, starred, commentFilter, created, shape, lengthFilter, viewed, presenter, voice, tagFilter]);
  // The last purge empties both views; leave the trash so the "No videos yet" state (and the filter bar) comes back.
  useEffect(() => {
    if (trash && data && data.total === 0 && data.trashed === 0) setTrash(false);
  }, [data, trash]);
  async function bulk(action: BulkAction) {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setCopyNote(null);
    const over = overSelection(ids.length, BULK_MAX);
    if (over) return setBulkErr(over);
    let targetFolder: string | undefined;
    let bulkTags: string[] = [];
    if (action === "move" || action === "unfile") {
      // A name that only differs from an existing folder in case or spacing goes into that folder. The length is checked
      // after trimming, as the server does, so spaces pasted around a full-length name do not cut it short.
      targetFolder = action === "unfile" ? "" : folderFor(timeDraft, folders);
      if (action === "move" && !targetFolder) return;
      if (targetFolder.length > MAX_FOLDER_NAME) {
        setBulkErr(`Keep the folder name to ${MAX_FOLDER_NAME} characters`);
        return;
      }
    } else if (action === "tag" || action === "untag") {
      // A comma ends a tag, as on the video page, so "spring, open house" names two.
      bulkTags = cleanTags(timeDraft.split(",").map(tagText));
      if (!bulkTags.length) return;
      if (bulkTags.length > VIDEO_TAGS_MAX) return setBulkErr(`Name at most ${VIDEO_TAGS_MAX} tags at once`);
      if (bulkTags.some((t) => Array.from(t).length > VIDEO_TAG_MAX)) return setBulkErr(`A tag is at most ${VIDEO_TAG_MAX} characters`);
      // Nothing to take off: said here, and nothing is sent, as "No cover" does.
      if (action === "untag" && !videos.some((v) => selected.has(v.id) && v.tags?.some((t) => bulkTags.some((b) => sameTag(b, t))))) {
        return setBulkErr(`None of the selected videos has ${bulkTags.length === 1 ? "that tag" : "those tags"}`);
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
    } else if (action === "cta" || action === "nocta") {
      if (action === "cta") {
        const label = ctaDraft.label.trim();
        const url = ctaDraft.url.trim();
        if (!label || label.length > SHARE_CTA_LABEL_MAX) return setBulkErr(`Give the button 1 to ${SHARE_CTA_LABEL_MAX} characters of text`);
        if (!/^https?:\/\/[^\s]+$/i.test(url)) return setBulkErr("The button's link must start with http:// or https://");
        if (url.length > SHARE_CTA_URL_MAX) return setBulkErr(`Keep the button's link to ${SHARE_CTA_URL_MAX} characters`);
      }
      // The button is part of what a share page shows, so changing it sends an approved video back to not reviewed.
      const chosen = videos.filter((v) => selected.has(v.id));
      const same = (v: (typeof chosen)[number]) => (action === "nocta" ? !v.shareCta : v.shareCta?.label === ctaDraft.label.trim() && v.shareCta?.url === ctaDraft.url.trim());
      const replaced = action === "cta" ? chosen.filter((v) => v.shareCta && !same(v)).length : chosen.filter((v) => v.shareCta).length;
      const approved = chosen.filter((v) => v.review?.status === "approved" && !same(v)).length;
      const notes = [
        !replaced
          ? ""
          : action === "cta"
            ? `${replaced === 1 ? "1 selected video has a button already, which this replaces" : `${replaced} selected videos have a button already, which this replaces`}.`
            : `${replaced === 1 ? "1 selected video has a button on its share page" : `${replaced} selected videos have a button on their share pages`}.`,
        approved ? `${approved === 1 ? "1 approved video goes" : `${approved} approved videos go`} back to not reviewed, as ${approved === 1 ? "its" : "their"} share page changes.` : "",
      ].filter(Boolean);
      if (notes.length && !window.confirm(`${notes.join(" ")} ${action === "cta" ? "Set this button" : replaced === 1 ? "Remove it" : "Remove them"}?`)) return;
    } else if (action === "cover" || action === "nocover") {
      if (action === "cover" && !coverDraft) return;
      // The cover is part of what a share page shows, so changing it sends an approved video back to not reviewed.
      const chosen = videos.filter((v) => selected.has(v.id));
      const replaced = chosen.filter((v) => v.cover).length;
      const approved = chosen.filter((v) => v.review?.status === "approved" && (action === "cover" || v.cover)).length;
      const notes = [
        !replaced
          ? ""
          : action === "cover"
            ? `${replaced === 1 ? "1 selected video has a cover already, which this replaces" : `${replaced} selected videos have a cover already, which this replaces`}.`
            : `${replaced === 1 ? "1 selected video has a cover; without it the share page shows the renderer's own picture of the video" : `${replaced} selected videos have a cover; without one the share page shows the renderer's own picture of the video`}.`,
        approved ? `${approved === 1 ? "1 approved video goes" : `${approved} approved videos go`} back to not reviewed, as ${approved === 1 ? "its" : "their"} share page changes.` : "",
      ].filter(Boolean);
      if (action === "nocover" && !replaced) return setBulkErr(`${ids.length === 1 ? "The selected video has no" : "None of the selected videos has a"} cover to remove.`);
      if (notes.length && !window.confirm(`${notes.join(" ")} ${action === "cover" ? "Set this cover" : replaced === 1 ? "Remove it" : "Remove them"}?`)) return;
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
                  : action === "cta" || action === "nocta"
                    ? { action: "cta", ids, shareCta: action === "nocta" ? null : { label: ctaDraft.label.trim(), url: ctaDraft.url.trim() } }
                  : action === "cover" || action === "nocover"
                    ? { action: "cover", ids, cover: action === "nocover" ? null : coverDraft!.dataUrl }
                  : action === "tag" || action === "untag"
                    ? { action: "tags", ids, [action === "tag" ? "add" : "remove"]: bulkTags }
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
          action === "tag" || action === "untag"
            ? `${one ? "1 selected video" : `${refused.length} selected videos`} would have more than ${VIDEO_TAGS_MAX} tags, so ${one ? "it was" : "they were"} not tagged and ${one ? "is" : "are"} still selected; take a tag off ${one ? "it" : "them"} first.`
            : action === "expire"
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
        anchor.current = null;
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
  // The selection stays, so its links can be fixed (go-live, expiry, links on) and the file downloaded again. With
  // "qrcodes", a zip of a QR code of each link that can be sent now, for printing flyers or signs for several at once;
  // with "captions", a zip of each rendered video's captions (SRT), to upload with the videos on another site; with
  // "scripts", a zip of each video's script as the editor's Download script writes it, to edit or import again.
  async function downloadLinks(kind: "links" | "qrcodes" | "captions" | "scripts" = "links") {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const over = overSelection(ids.length, BULK_MAX);
    if (over) return setBulkErr(over);
    const what = kind === "links" ? "the links" : kind === "qrcodes" ? "the QR codes" : kind === "captions" ? "the captions" : "the scripts";
    const madeFor = selected;
    setBusy(kind);
    setCopyNote(null);
    // An earlier copy's or download's own refusal goes; it said why that one failed.
    setBulkErr((note) => (note !== null && note === copyErr.current ? null : note));
    // A note from an earlier go-live or expiry refusal stays: it names the links to fix, which this file is for checking.
    try {
      const res = await fetch(kind === "captions" || kind === "scripts" ? `/api/videos/${kind}` : `/api/videos/links${kind === "qrcodes" ? "?format=qr" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }).catch(() => {
        throw new Error(`Could not reach the server to download ${what}`);
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Could not download ${what}`);
      const omitted = Number(res.headers.get("X-Omitted") ?? 0);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? (kind === "links" ? "links.csv" : `${kind === "qrcodes" ? "qr-codes" : kind}.zip`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      // What the file holds is said only for the selection it was made for, and once it is saved.
      if (selectedNow.current !== madeFor) return;
      if (omitted > 0) setBulkErr(`${omitted === 1 ? "1 selected video is" : `${omitted} selected videos are`} no longer in the library and ${omitted === 1 ? "was" : "were"} left out of the file.`);
      if (kind === "qrcodes") {
        const links = Number(res.headers.get("X-Links") ?? 0);
        const unsendable = Number(res.headers.get("X-Unsendable") ?? 0);
        setCopyNote(`Saved ${links} QR ${links === 1 ? "code" : "codes"}${unsendable ? `; left out: ${unsendable} ${unsendable === 1 ? "has" : "have"} no link that can be sent yet` : ""}`);
      }
      if (kind === "captions") {
        const files = Number(res.headers.get("X-Files") ?? 0);
        const missing = Number(res.headers.get("X-Missing") ?? 0);
        setCopyNote(`Saved captions for ${files} ${files === 1 ? "video" : "videos"}${missing ? `; left out: ${missing} ${missing === 1 ? "has" : "have"} none (still rendering, failed, or no script of its own)` : ""}`);
      }
      if (kind === "scripts") {
        const files = Number(res.headers.get("X-Files") ?? 0);
        const missing = Number(res.headers.get("X-Missing") ?? 0);
        setCopyNote(`Saved ${files} ${files === 1 ? "script" : "scripts"}${missing ? `; left out: ${missing} with no script to save` : ""}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : `Could not download ${what}`;
      copyErr.current = message;
      setBulkErr(message);
    } finally {
      setBusy(null);
    }
  }
  // The selected videos' links that can be sent now, one a line, put on the clipboard for an email or a chat. The note
  // and any refusal belong to the selection they were made for, so a change of selection (or a later copy) clears them.
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const copyErr = useRef<string | null>(null);
  const selectedNow = useRef(selected);
  useLayoutEffect(() => {
    selectedNow.current = selected;
  });
  useEffect(() => {
    setCopyNote(null);
    setBulkErr((note) => (note !== null && note === copyErr.current ? null : note));
  }, [selected]);
  async function copyLinks() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const over = overSelection(ids.length, BULK_MAX);
    if (over) return setBulkErr(over);
    const madeFor = selected;
    setBusy("copylinks");
    setCopyNote(null);
    setBulkErr((note) => (note !== null && note === copyErr.current ? null : note));
    const counts = { links: 0, omitted: 0, unsendable: 0 };
    // Fetched inside the clipboard write rather than before it, so a browser that only lets a click copy at once (Safari)
    // still counts the copy as the click's.
    const text = fetch("/api/videos/links?format=text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) })
      .catch(() => {
        throw new Error("Could not reach the server to copy the links");
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not copy the links");
        counts.links = Number(res.headers.get("X-Links") ?? 0);
        counts.omitted = Number(res.headers.get("X-Omitted") ?? 0);
        counts.unsendable = Number(res.headers.get("X-Unsendable") ?? 0);
        if (!counts.links) throw new Error(`None of the selected videos has a link that can be sent yet (still rendering, failed, switched off, expired, or not live until later); Download links says why for each.`);
        return res.text();
      });
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
        // The item may be refused before it reads the text; the failure is reported from `text` below.
        blob.catch(() => {});
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      if (selectedNow.current !== madeFor) return;
      const left = [
        counts.unsendable ? `${counts.unsendable} ${counts.unsendable === 1 ? "has" : "have"} no link that can be sent yet` : "",
        counts.omitted ? `${counts.omitted} ${counts.omitted === 1 ? "is" : "are"} no longer in the library` : "",
      ].filter(Boolean);
      setCopyNote(`Copied ${counts.links} ${counts.links === 1 ? "link" : "links"}${left.length ? `; left out: ${left.join(", ")}` : ""}`);
    } catch {
      // The server's answer says what went wrong if it was the problem; otherwise the browser refused the copy.
      const failed = await text.then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : "Could not copy the links"),
      );
      const message = failed ?? "The browser did not let the page copy to the clipboard; Download links gives the same links as a file.";
      copyErr.current = message;
      setBulkErr(message);
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
        anchor.current = null;
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
  function openTimeField(kind: "golive" | "expiry" | "password" | "settings" | "folder" | "cta" | "cover" | "tags") {
    setCtaDraft({ label: "", url: "" });
    setCoverDraft(null);
    coverPick.current += 1;
    setCoverReading(false);
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
          onClick={closeTimeField}
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
          onClick={closeTimeField}
          disabled={busy !== null}
          aria-label="Close share password"
          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
    );
  }
  // Tags put on, or taken off, every selected video (a comma between two), the library's tags suggested as it is typed.
  function tagsForm() {
    const named = timeDraft.split(",").some((t) => tagText(t));
    // Suggested for the tag being typed, after the last comma, with the ones before it kept in front.
    const cut = timeDraft.lastIndexOf(",");
    const before = cut < 0 ? "" : `${timeDraft.slice(0, cut + 1)} `;
    const typed = timeDraft.slice(0, cut + 1).split(",").map(tagText);
    return (
      <form
        className="inline-flex flex-wrap items-center gap-1.5"
        data-testid="bulk-tags"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void bulk("tag");
        }}
      >
        <input
          autoFocus
          list="bulk-tag-names"
          aria-label="Tags for the selected videos"
          placeholder="Tag, or tags with commas"
          maxLength={VIDEO_TAGS_MAX * (VIDEO_TAG_MAX + 2)}
          className={`${inputClass} w-44 py-1 text-xs`}
          value={timeDraft}
          onChange={(e) => {
            setTimeDraft(e.target.value);
            setBulkErr(null);
          }}
        />
        <datalist id="bulk-tag-names">
          {tagsUsed
            .filter((t) => !typed.some((x) => sameTag(x, t.name)))
            .map((t) => (
              <option key={t.name} value={`${before}${t.name}`} />
            ))}
        </datalist>
        <Button type="submit" variant="secondary" className="px-2.5 py-1 text-xs" disabled={!selected.size || !named || busy !== null} loading={busy === "tag"} title="Put these tags on the selected videos, keeping the tags they have">
          Add tag
        </Button>
        <Button type="button" variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => bulk("untag")} disabled={!selected.size || !named || busy !== null} loading={busy === "untag"} title="Take these tags off the selected videos that have them">
          Remove tag
        </Button>
        <button
          type="button"
          onClick={closeTimeField}
          disabled={busy !== null}
          aria-label="Close tags"
          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
    );
  }
  // One call-to-action button (its text and link) for every selected video's share page, or none.
  function ctaForm() {
    return (
      <form
        className="inline-flex flex-wrap items-center gap-1.5"
        data-testid="bulk-cta"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void bulk("cta");
        }}
      >
        <input
          autoFocus
          aria-label="Button text for the selected videos"
          placeholder="Button text"
          className={`${inputClass} w-36 py-1 text-xs`}
          value={ctaDraft.label}
          onChange={(e) => {
            setCtaDraft((prev) => ({ ...prev, label: e.target.value }));
            setBulkErr(null);
          }}
        />
        <input
          type="url"
          inputMode="url"
          aria-label="Button link for the selected videos"
          placeholder="https://…"
          className={`${inputClass} w-48 py-1 text-xs`}
          value={ctaDraft.url}
          onChange={(e) => {
            setCtaDraft((prev) => ({ ...prev, url: e.target.value }));
            setBulkErr(null);
          }}
        />
        <Button type="submit" variant="secondary" className="px-2.5 py-1 text-xs" disabled={!selected.size || !ctaDraft.label.trim() || !ctaDraft.url.trim() || busy !== null} loading={busy === "cta"} title="Shows this button under the player on the selected videos' share pages">
          Set button
        </Button>
        <Button type="button" variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => bulk("nocta")} disabled={!selected.size || busy !== null} loading={busy === "nocta"} title="Remove the call-to-action button from the selected videos' share pages">
          No button
        </Button>
        <button
          type="button"
          onClick={closeTimeField}
          disabled={busy !== null}
          aria-label="Close call to action"
          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
    );
  }
  // One cover picture for every selected video's share page and card (each keeps its own copy), or none.
  function coverForm() {
    return (
      <form
        className="inline-flex flex-wrap items-center gap-1.5"
        data-testid="bulk-cover"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void bulk("cover");
        }}
      >
        <label className={`inline-flex cursor-pointer items-center rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-brand-500 ${busy !== null ? "pointer-events-none opacity-50" : ""}`}>
          {coverReading ? "Reading picture…" : coverDraft ? "Choose another picture" : "Choose picture"}
          <input
            autoFocus
            type="file"
            accept="image/*"
            aria-label={`${coverDraft ? "Choose another picture" : "Choose picture"} for the selected videos' cover`}
            aria-describedby={coverDraft ? "bulk-cover-chosen" : undefined}
            className="sr-only"
            disabled={busy !== null}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBulkErr(null);
              // The picture being read replaces the one shown, so Set cover never sends a picture other than the last chosen.
              const pick = ++coverPick.current;
              setCoverDraft(null);
              setCoverReading(true);
              try {
                const dataUrl = await fileToCover(file);
                if (pick === coverPick.current) setCoverDraft({ name: file.name, dataUrl });
              } catch (err) {
                if (pick === coverPick.current) setBulkErr(err instanceof Error ? err.message : "Could not read that picture");
              } finally {
                if (pick === coverPick.current) setCoverReading(false);
              }
            }}
          />
        </label>
        {coverDraft && (
          <span id="bulk-cover-chosen" role="status" className="inline-flex items-center gap-1.5 text-xs text-slate-600">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverDraft.dataUrl} alt="" className="h-6 w-10 rounded border border-slate-200 object-cover" data-testid="bulk-cover-preview" />
            <span className="max-w-32 truncate" title={coverDraft.name}>
              <span className="sr-only">Chosen: </span>
              {coverDraft.name}
            </span>
          </span>
        )}
        <Button type="submit" variant="secondary" className="px-2.5 py-1 text-xs" disabled={!selected.size || !coverDraft || coverReading || busy !== null} loading={busy === "cover"} title="Shows this picture before the selected videos play, on their share pages and cards">
          Set cover
        </Button>
        <Button type="button" variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => bulk("nocover")} disabled={!selected.size || busy !== null} loading={busy === "nocover"} title="Remove the selected videos' covers, so each shows the renderer's own picture of it again">
          No cover
        </Button>
        <button
          type="button"
          onClick={closeTimeField}
          disabled={busy !== null}
          aria-label="Close cover"
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
          onClick={closeTimeField}
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
          className={`${inputClass} w-52 py-1 text-xs`}
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
          onClick={closeTimeField}
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
            Showing one personalized batch{viewed === "no" ? ", only the videos not viewed yet" : viewed === "yes" ? ", only the videos viewed" : ""}{skipped > 0 ? `. ${skipped} ${skipped === 1 ? "row was" : "rows were"} not started because the monthly allowance was reached` : ""}
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
          <input
            ref={searchRef}
            type="search"
            aria-label="Search videos"
            aria-keyshortcuts="/"
            className={`${inputClass} max-w-xs`}
            placeholder="Search title, description, script, avatar, voice"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "/" && e.repeat && slashHeld.current) e.preventDefault();
            }}
            onKeyUp={(e) => {
              if (e.key === "/") slashHeld.current = false;
            }}
            onBlur={() => (slashHeld.current = false)}
          />
          {/* Shown with no folders too while the address names one, so the filter in use can be seen and changed. */}
          {(folders.length > 0 || folder !== "all") && (
            <select aria-label="Folder" value={folder} onChange={(e) => setFolder(e.target.value)} className={`${inputClass} w-auto max-w-[14rem]`}>
              {/* Each with how many videos it holds in this view, whatever the other filters, so an empty pick is not a surprise. */}
              <option value="all">All folders{withCount(trash ? trashed : (data?.total ?? 0))}</option>
              <option value="unfiled">Unfiled{withCount(countOf(folderCounts, ""))}</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                  {withCount(countOf(folderCounts, f))}
                </option>
              ))}
              {/* A folder named in the address that no video is in any more (renamed or emptied since the link was made): still the one shown. */}
              {folder !== "all" && folder !== "unfiled" && !folders.includes(folder) && (
                <option value={folder}>
                  {folder}
                  {withCount(0)}
                </option>
              )}
            </select>
          )}
          {/* Offered once the videos in this view have more than one presenter, or while one is chosen (from the address, say). */}
          {(presenters.length > 1 || presenter !== "all") && (
            <select aria-label="Filter by presenter" value={presenter} onChange={(e) => setPresenter(e.target.value)} className={`${inputClass} w-auto max-w-[14rem]`}>
              <option value="all">Any presenter</option>
              {presenters.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || "Unnamed presenter"}
                  {withCount(p.count)}
                </option>
              ))}
              {/* One chosen that no video in this view shows: counted as none once the list says so, not while it loads. */}
              {presenter !== "all" && !presenters.some((p) => p.id === presenter) && <option value={presenter}>{data ? `This presenter${withCount(0)}` : "Chosen presenter"}</option>}
            </select>
          )}
          {/* The same for the voices the videos speak in. */}
          {(voicesUsed.length > 1 || voice !== "all") && (
            <select aria-label="Filter by voice" value={voice} onChange={(e) => setVoice(e.target.value)} className={`${inputClass} w-auto max-w-[14rem]`}>
              <option value="all">Any voice</option>
              {voicesUsed.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || "Unnamed voice"}
                  {withCount(p.count)}
                </option>
              ))}
              {voice !== "all" && !voicesUsed.some((p) => p.id === voice) && <option value={voice}>{data ? `This voice${withCount(0)}` : "Chosen voice"}</option>}
            </select>
          )}
          {/* The tags on this view's videos, most used first, once any video has one, or while one is chosen. */}
          {(tagsUsed.length > 0 || !!tagFilter) && (
            <select aria-label="Filter by tag" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className={`${inputClass} w-auto max-w-[14rem]`}>
              <option value="">Any tag</option>
              {tagsUsed.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {withCount(t.count)}
                </option>
              ))}
              {/* A tag from the address that no video in this view carries (or spelled otherwise): still the one shown. */}
              {!!tagFilter && !tagsUsed.some((t) => t.name === tagFilter) && (
                <option value={tagFilter}>
                  {tagFilter}
                  {data && !tagsUsed.some((t) => sameTag(t.name, tagFilter)) ? withCount(0) : ""}
                </option>
              )}
            </select>
          )}
          {folder !== "all" && folder !== "unfiled" && !trash && (
            <span className="flex gap-1" data-testid="folder-actions">
              <FolderShare folder={folder} canEdit={canEdit} />
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
            <div ref={barRef} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1" data-testid="bulk-bar">
              <span role="status" className={`px-1 text-xs font-medium ${selected.size > BULK_MAX ? "text-amber-800" : "text-slate-700"}`}>
                {selected.size} selected{selected.size > BULK_MAX ? `, over the ${BULK_MAX} one action takes` : ""}
              </span>
              <button
                ref={selectShownRef}
                type="button"
                onClick={selectShown}
                aria-keyshortcuts="Control+A Meta+A"
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
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void copyLinks()} disabled={!selected.size || busy !== null} loading={busy === "copylinks"} title="Copies the share links of the selected videos that can be sent now, one a line, to paste into an email or a chat">
                <Copy className="h-3.5 w-3.5" /> Copy links
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void downloadLinks("qrcodes")} disabled={!selected.size || busy !== null} loading={busy === "qrcodes"} title="A zip of a QR code (SVG, sharp at any size) of each selected video's share link that can be sent now, named after the video, for flyers or signs">
                <QrCode className="h-3.5 w-3.5" /> QR codes
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void downloadLinks("captions")} disabled={!selected.size || busy !== null} loading={busy === "captions"} title="A zip of the captions (SRT) of each selected video that has rendered, named after the video, to upload with it on YouTube, LinkedIn, or a course platform">
                <Captions className="h-3.5 w-3.5" /> Captions
              </Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void downloadLinks("scripts")} disabled={!selected.size || busy !== null} loading={busy === "scripts"} title="A zip of each selected video's script as a text file, named after the video, scenes apart on --- lines, which Import script in the editor reads back">
                <FileText className="h-3.5 w-3.5" /> Scripts
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
                <Button variant="secondary" className="px-2.5 py-1 text-xs" data-opens="folder" onClick={() => openTimeField("folder")} disabled={!selected.size || busy !== null}>
                  <FolderInput className="h-3.5 w-3.5" /> Move to folder
                </Button>
              )}
              {timeField === "tags" ? (
                tagsForm()
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" data-opens="tags" onClick={() => openTimeField("tags")} disabled={!selected.size || busy !== null} title="Put a tag on the selected videos, or take one off">
                  <Tag className="h-3.5 w-3.5" /> Tags
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
                <Button variant="secondary" className="px-2.5 py-1 text-xs" data-opens="golive" onClick={() => openTimeField("golive")} disabled={!selected.size || busy !== null}>
                  <Clock className="h-3.5 w-3.5" /> Schedule go-live
                </Button>
              )}
              {timeField === "expiry" ? (
                timeForm("expiry")
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" data-opens="expiry" onClick={() => openTimeField("expiry")} disabled={!selected.size || busy !== null}>
                  <TimerOff className="h-3.5 w-3.5" /> Set expiry
                </Button>
              )}
              {timeField === "password" ? (
                passwordForm()
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" data-opens="password" onClick={() => openTimeField("password")} disabled={!selected.size || busy !== null}>
                  <KeyRound className="h-3.5 w-3.5" /> Password
                </Button>
              )}
              {timeField === "settings" ? (
                settingsForm()
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" data-opens="settings" onClick={() => openTimeField("settings")} disabled={!selected.size || busy !== null} title="Let viewers of the selected videos download them, or ask them for an email before playing, or stop either">
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Download &amp; email
                </Button>
              )}
              {timeField === "cta" ? (
                ctaForm()
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" data-opens="cta" onClick={() => openTimeField("cta")} disabled={!selected.size || busy !== null} title="Put one call-to-action button on the selected videos' share pages, or take theirs off">
                  <MousePointerClick className="h-3.5 w-3.5" /> Call to action
                </Button>
              )}
              {timeField === "cover" ? (
                coverForm()
              ) : (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" data-opens="cover" onClick={() => openTimeField("cover")} disabled={!selected.size || busy !== null} title="Give the selected videos one cover picture, or take theirs off">
                  <ImageIcon className="h-3.5 w-3.5" /> Cover
                </Button>
              )}
              <Button variant="danger" className="px-2.5 py-1 text-xs" onClick={() => bulk("delete")} disabled={!selected.size || busy !== null} loading={busy === "delete"} title={`Moves the selected videos to the trash, where they can be restored for ${TRASH_RETENTION_DAYS} days`}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
                </>
              )}
              <span role="status" className="text-xs text-emerald-800" data-testid="copy-note">
                {copyNote}
              </span>
              <button type="button" onClick={stopSelecting} disabled={busy !== null} aria-label="Done selecting" aria-keyshortcuts="Escape" className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <Button ref={selectButtonRef} variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setSelecting(true)} disabled={busy === "empty" || busy === "restoreall"} title="Choose videos for one action; Shift+click a video to select, or unselect, every one from the video clicked last to it">
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
          <button
            type="button"
            onClick={() => setCommentFilter((f) => (f === "open" ? "all" : "open"))}
            aria-pressed={commentFilter === "open"}
            data-testid="open-comments-toggle"
            title="Only videos with a comment no one has resolved yet"
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${commentFilter === "open" ? "bg-sky-800 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            <MessageSquare className="h-3 w-3" /> Open comments
          </button>
          {/* Mentions only happen in a workspace; shown outside one too while the address set it, so it can be cleared. */}
          {(inWorkspace || commentFilter === "mentions") && (
            <button
              type="button"
              onClick={() => setCommentFilter((f) => (f === "mentions" ? "all" : "mentions"))}
              aria-pressed={commentFilter === "mentions"}
              data-testid="mentions-toggle"
              title="Only videos with an open comment that mentions you"
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${commentFilter === "mentions" ? "bg-sky-800 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              <AtSign className="h-3 w-3" /> Mentions me
            </button>
          )}
          {/* Shown outside a workspace too while the address set it (a link from Home, then a switch of space), so it can be cleared. */}
          {(inWorkspace || review !== "all") && (
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
          <select aria-label="Filter by shape" value={shape} onChange={(e) => setShape(e.target.value as VideoQuery["shape"])} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
            <option value="all">Any shape</option>
            <option value="landscape">Landscape 16:9 or 5:4</option>
            <option value="portrait">Portrait 9:16 or 4:5</option>
            <option value="square">Square 1:1</option>
          </select>
          <select aria-label="Filter by length" value={lengthFilter} onChange={(e) => setLengthFilter(e.target.value as VideoQuery["length"])} title="By how long a finished video runs; one still rendering, or one that failed, has no length" className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
            <option value="all">Any length</option>
            <option value="short">Under 1 minute</option>
            <option value="medium">1 to 3 minutes</option>
            <option value="long">Over 3 minutes</option>
          </select>
          <select aria-label="Filter by views" value={viewed} onChange={(e) => setViewed(e.target.value as VideoQuery["viewed"])} title="Whether a finished video's share page has been viewed yet; one still rendering, or one that failed, is in neither" className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
            <option value="all">Any views</option>
            <option value="yes">Viewed</option>
            <option value="no">Not viewed yet</option>
          </select>
          {filtersOn && (
            <button type="button" onClick={clearFilters} data-testid="clear-filters" title="Show every video again: the search and every filter back to their start" className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-slate-100">
              <X className="h-3.5 w-3.5" aria-hidden /> Clear filters
            </button>
          )}
          <span role="status" className="sr-only" data-testid="filter-note">
            {filterNote}
          </span>
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
            <a href={analyticsHref} download className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50" title="Views, watch-through, retention, clicks, and share links for the videos shown, every match and in this order" data-testid="library-analytics">
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
            <option value="commented">Recent comments</option>
            <option value="kept">Most watched to the end</option>
          </select>
          {/* A render has no length, and no share page, until it finishes, so a length filter or "Not viewed yet" leaves the
              ones in flight out: say so. */}
          {(lengthFilter !== "all" || viewed === "no") && (data?.lengthPending ?? 0) > 0 && (
            <p className="basis-full text-xs text-slate-500" data-testid="length-note">
              {data!.lengthPending === 1 ? "1 video still rendering is left out until it finishes." : `${data!.lengthPending} videos still rendering are left out until they finish.`}
            </p>
          )}
        </div>
      )}
      {/* Not over a batch's results, which a view does not keep: no view is the list shown there, and none is saved from it. */}
      {hasAny && !trash && viewSpace && <SavedViews query={batch ? "" : viewNow} canSave={!!viewNow && !batch} space={viewSpace} onEmpty={() => searchRef.current?.focus()} />}
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
          // Where the filters hide every video, the way back is one step.
          action={
            // Only where clearing shows something: the library's count leaves out the trash, and the trash's leaves out the library.
            filtersOn && (trash ? trashed > 0 : (data?.total ?? 0) > 0) ? (
              <Button variant="secondary" onClick={clearFilters} data-testid="empty-clear-filters">
                <X className="h-4 w-4" aria-hidden /> Clear filters
              </Button>
            ) : undefined
          }
          body={
            trash
              ? // Trashed videos the filters hide are still counted on the toggle, so say what hides them.
                trashed && (narrowed || toggledOn.length > 0)
                ? `Try a different search, status, folder, presenter, voice, tag, date, shape, length, or views${toggledOn.length ? `, or turn off ${toggledOn.join(" and ")}` : ""}.`
                : `Deleted videos wait here for ${TRASH_RETENTION_DAYS} days before they are removed for good.`
              : hasAny
                ? !narrowed && toggledOn.length === 1
                  ? starred
                    ? "No video is starred yet; star one from its page, or several from Select."
                    : commentFilter === "mentions"
                      ? "No open comment mentions you."
                      : "No video has an open comment."
                  : `Try a different search, status, folder, presenter, voice, tag, date, shape, length, views, ${toggledOn.length ? `share link, or turn off ${toggledOn.join(" and ")}` : "or share link"}.`
                : "Your rendered videos will show up here."
          }
        />
      ) : (
        <>
          <span role="status" className="sr-only" data-testid="card-copy-note">
            {cardNote}
          </span>
          {layout === "list" ? (
            <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200" data-testid="video-list">
              {videos.map((v) => (
                <VideoRow key={v.id} video={v} openComments={data?.openComments?.[v.id]} mentions={data?.mentions?.[v.id]} freshComments={freshComments.has(v.id)} selectable={selecting} selected={selected.has(v.id)} onToggle={(shift) => busy === null && click(v.id, shift)} shareOrigin={data?.shareOrigin} onCopyNote={cardCopyNote} />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {videos.map((v) => (
                <VideoCard key={v.id} video={v} openComments={data?.openComments?.[v.id]} mentions={data?.mentions?.[v.id]} freshComments={freshComments.has(v.id)} selectable={selecting} selected={selected.has(v.id)} onToggle={(shift) => busy === null && click(v.id, shift)} shareOrigin={data?.shareOrigin} onCopyNote={cardCopyNote} />
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
