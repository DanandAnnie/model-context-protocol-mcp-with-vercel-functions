// Personalized batches (one video per CSV row). Used by API routes only.
import { z } from "zod";
import { newId } from "../ids";
import { getStore } from "../store";
import type { Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { renderLimitFor } from "../billing";
import { BULK_MAX, MAX_RETRY_AT_ONCE } from "../types";
import { NotFoundError, ValidationError } from "../errors";
import { fillTemplate, parseCsv, placeholdersIn } from "../csv";
import { shareOffline, shareState } from "../client";
import { MORE_BLINKING_NEEDS_V, accentSchema, avatarEngineSchema, listVideos, purgeDue, refreshPending, retryVideo, moreBlinkingSchema, transparentSchema, backgroundSchema, captionStyleSchema, createVideo, emotionSchema, expressivenessSchema, motionPromptSchema, pitchSchema, rendersThisMonth, resolveRenderContext } from "./videos";
import { getBrandKit } from "./brand";
import { stripPauses } from "../pauses";
import { qrFileNames, qrSvg, qrWording } from "../qr";

export const MAX_BATCH_ROWS = 100;
/** Characters that show nothing: zero-width spaces and joiners, direction marks and embeddings, a soft hyphen, a byte-order mark. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
/** What one video's script may hold, as for a video made in the editor. */
const MAX_ROW_SCRIPT = 5000;

/**
 * Rows whose filled-in script could not render: nothing to say (the placeholders' cells are empty) or more than
 * a video holds. Row numbers count data rows from 1, as the preview and the results do.
 */
export function rowScriptProblems(scriptTemplate: string, rows: Array<Record<string, string>>): { empty: number[]; tooLong: number[]; blankTemplate: boolean } {
  const empty: number[] = [];
  const tooLong: number[] = [];
  // A template with nothing to say (no words, only pauses) is the problem itself, not its rows' cells.
  if (!stripPauses(scriptTemplate).replace(INVISIBLE, "").trim()) return { empty, tooLong, blankTemplate: true };
  rows.forEach((row, i) => {
    const script = fillTemplate(scriptTemplate, row).trim();
    // Invisible characters a spreadsheet can leave in a cell (zero-width spaces, a byte-order mark) say nothing either.
    if (!stripPauses(script).replace(INVISIBLE, "").trim()) empty.push(i + 1);
    else if (script.length > MAX_ROW_SCRIPT) tooLong.push(i + 1);
  });
  return { empty, tooLong, blankTemplate: false };
}

/** The problems above in words, or null when every row is fine. */
export function rowScriptMessage({ empty, tooLong, blankTemplate }: { empty: number[]; tooLong: number[]; blankTemplate?: boolean }): string | null {
  if (blankTemplate) return "The script is empty; write what the presenter says, with {column} placeholders for each row.";
  const list = (rows: number[]) => (rows.length > 5 ? `${rows.slice(0, 5).join(", ")} and ${rows.length - 5} more` : rows.join(", "));
  const parts = [
    empty.length ? `${empty.length === 1 ? `row ${list(empty)} leaves the script empty; fill in its cells` : `rows ${list(empty)} leave the script empty; fill in their cells`}` : "",
    tooLong.length ? `${tooLong.length === 1 ? `row ${list(tooLong)} makes` : `rows ${list(tooLong)} make`} the script longer than the ${MAX_ROW_SCRIPT} characters a video holds` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join("; ").replace(/^./, (c) => c.toUpperCase())}.` : null;
}

export const batchRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  /** Script with {column} placeholders. */
  scriptTemplate: z.string().trim().min(1).max(5000),
  /** Raw CSV text; the first row is the header. */
  csv: z.string().min(1).max(200_000),
  avatarId: z.string().min(1),
  voiceId: z.string().min(1),
  aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
  resolution: z.enum(["720p", "1080p"]).default("1080p"),
  /** Behind every row; when absent, the brand kit's background (its default, else its primary colour), else light grey. */
  background: backgroundSchema.optional(),
  captions: z.boolean().default(false),
  captionStyle: captionStyleSchema.optional(),
  speed: z.number().min(0.5).max(1.5).default(1),
  pitch: pitchSchema.optional(),
  emotion: emotionSchema.optional(),
  expressiveness: expressivenessSchema,
  motionPrompt: motionPromptSchema,
  accent: accentSchema,
  avatarEngine: avatarEngineSchema,
  moreBlinking: moreBlinkingSchema,
  transparent: transparentSchema,
}).refine((b) => !b.moreBlinking || b.avatarEngine === "avatar_v", { path: ["moreBlinking"], message: MORE_BLINKING_NEEDS_V });

export interface BatchResult {
  batchId: string;
  videos: Video[];
  /** Rows not started because the allowance was reached. */
  skipped: Array<{ row: number; reason: string }>;
  /** Rows whose render could not be started by the provider (stored with status "failed"). */
  failed: Array<{ row: number; reason: string }>;
}

/** Pure preview: the substituted scripts for the first rows, plus columns the template uses but the CSV lacks. */
export function previewBatch(scriptTemplate: string, csv: string, limit = 3) {
  const table = parseCsv(csv);
  const used = placeholdersIn(scriptTemplate);
  const missing = used.filter((c) => !table.columns.includes(c));
  const samples = table.rows.slice(0, limit).map((row) => ({ label: row[table.columns[0]] ?? "", script: fillTemplate(scriptTemplate, row) }));
  // Only meaningful once every placeholder has a column; until then the missing columns are the message.
  const problem = missing.length ? null : rowScriptMessage(rowScriptProblems(scriptTemplate, table.rows));
  return { columns: table.columns, rowCount: table.rows.length, missing, samples, problem };
}

export async function createBatch(input: z.infer<typeof batchRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<BatchResult> {
  const table = parseCsv(input.csv);
  if (table.columns.length === 0 || table.rows.length === 0) throw new ValidationError("The CSV needs a header row and at least one data row");
  if (table.rows.length > MAX_BATCH_ROWS) throw new ValidationError(`A batch can have at most ${MAX_BATCH_ROWS} rows`);
  const missing = placeholdersIn(input.scriptTemplate).filter((c) => !table.columns.includes(c));
  if (missing.length) throw new ValidationError(`The script uses columns the CSV does not have: ${missing.join(", ")}`);
  // Checked for every row before any starts, as a video from the editor is: no row renders an empty or oversized script.
  const problem = rowScriptMessage(rowScriptProblems(input.scriptTemplate, table.rows));
  if (problem) throw new ValidationError(problem);

  const batchId = newId("batch");
  const labelColumn = table.columns[0];

  // Resolve avatar and voice once (they may cost provider round-trips) and reserve
  // the allowance for the whole batch before starting any row.
  const kit = input.background ? null : await getBrandKit(ownerId);
  const background = input.background ?? kit?.defaultBackground ?? (kit ? { type: "color" as const, value: kit.primaryColor } : { type: "color" as const, value: "#f1f5f9" });
  // The background goes in too: an uploaded image is looked up (and refused if it is gone) before any row starts.
  const ctx = await resolveRenderContext({ ...input, background }, ownerId);
  const limit = await renderLimitFor(ownerId);
  const used = limit ? await rendersThisMonth(ownerId) : 0;
  const allowedRows = limit ? Math.max(0, Math.min(table.rows.length, limit - used)) : table.rows.length;
  const skipped: BatchResult["skipped"] = [];
  for (let j = allowedRows; j < table.rows.length; j++) {
    skipped.push({ row: j + 1, reason: `Monthly render limit reached (${used} of ${limit}). The allowance resets on the 1st.` });
  }

  const videos: Video[] = new Array(allowedRows);
  const failed: BatchResult["failed"] = [];
  const startRow = async (i: number) => {
    const row = table.rows[i];
    const label = row[labelColumn] || `row ${i + 1}`;
    const video = await createVideo(
      {
        title: `${input.title} – ${label}`.slice(0, 120),
        script: fillTemplate(input.scriptTemplate, row),
        avatarId: input.avatarId,
        voiceId: input.voiceId,
        aspect: input.aspect,
        resolution: input.resolution,
        background,
        captions: input.captions,
        ...(input.captionStyle ? { captionStyle: input.captionStyle } : {}),
        speed: input.speed,
        ...(input.pitch ? { pitch: input.pitch } : {}),
        ...(input.emotion ? { emotion: input.emotion } : {}),
        ...(input.expressiveness ? { expressiveness: input.expressiveness } : {}),
        ...(input.motionPrompt ? { motionPrompt: input.motionPrompt } : {}),
        ...(input.accent ? { accent: input.accent } : {}),
        ...(input.avatarEngine ? { avatarEngine: input.avatarEngine } : {}),
        ...(input.moreBlinking ? { moreBlinking: true as const } : {}),
        ...(input.transparent ? { transparent: true as const } : {}),
      },
      ownerId,
      ctx,
      true,
      { batchId, rowLabel: label, batchRow: i + 1 },
    );
    videos[i] = video;
    if (video.status === "failed") failed.push({ row: i + 1, reason: video.error ?? "The render could not be started" });
  };
  await runWithConcurrency(allowedRows, BATCH_CONCURRENCY, startRow);
  failed.sort((a, b) => a.row - b.row);
  return { batchId, videos, skipped, failed };
}

/** The columns of a batch's links download, one row per recipient. */
export const BATCH_LINK_COLUMNS = ["row", "recipient", "title", "status", "share_link", "share_expires", "password_required", "email_required", "video_id", "created"] as const;

/**
 * A batch's videos as rows for a mail merge, one per recipient: in the order of the CSV it was made from (videos made
 * before rows were kept come after, oldest first). Where a row has several videos (a failed render and its retries),
 * the one kept is a ready one if there is one, else the newest. The share link is given only where a recipient can
 * open it (the video is ready and its link is on and not expired), so a blank cell means "do not send yet"; a link
 * that will expire, needs a password, or asks for an email says so in its own column.
 */
export function batchLinkRows(videos: Video[], base: string, now = Date.now()): Array<Record<(typeof BATCH_LINK_COLUMNS)[number], string | number | undefined>> {
  const origin = base.replace(/\/$/, "");
  const byId = new Map(videos.map((v) => [v.id, v]));
  // A video made before rows were kept is told apart by the first render of its retry chain.
  const rootOf = (v: Video) => {
    let id = v.id;
    for (let hops = 0, at: Video | undefined = v; at?.retryOf && hops < 100; hops++) {
      id = at.retryOf;
      at = byId.get(at.retryOf);
    }
    return id;
  };
  // A ready video first; then one no other video retried (a retry stands in for the render it replaced, even when both
  // were made in the same millisecond); then the newest.
  const retried = new Set(videos.map((v) => v.retryOf).filter(Boolean));
  const better = (a: Video, b: Video) => {
    if ((a.status === "completed") !== (b.status === "completed")) return a.status === "completed";
    if (retried.has(a.id) !== retried.has(b.id)) return !retried.has(a.id);
    return a.createdAt > b.createdAt;
  };
  const kept = new Map<string, Video>();
  for (const v of videos) {
    const key = v.batchRow !== undefined ? `row ${v.batchRow}` : `first ${rootOf(v)}`;
    const held = kept.get(key);
    if (!held || better(v, held)) kept.set(key, v);
  }
  return [...kept.values()]
    .sort((a, b) => (a.batchRow ?? Infinity) - (b.batchRow ?? Infinity) || a.createdAt.localeCompare(b.createdAt))
    .map((v) => {
      const live = v.status === "completed" && !shareOffline(v, now);
      return {
        row: v.batchRow,
        recipient: v.rowLabel,
        title: v.title,
        status: v.status,
        share_link: live ? `${origin}/share/${v.id}` : undefined,
        share_expires: live ? v.shareExpiresAt : undefined,
        password_required: live && v.shareLocked ? "yes" : undefined,
        email_required: live && v.shareGate ? "yes" : undefined,
        video_id: v.id,
        created: v.createdAt,
      };
    });
}

/** Columns of the links file for any selection of videos (the library's "Download links"). */
export const SELECTION_LINK_COLUMNS = ["title", "status", "share_state", "share_link", "share_goes_live", "share_expires", "password_required", "email_required", "folder", "video_id", "created"] as const;

export const selectionLinksSchema = z.object({ ids: z.array(z.string().min(1).max(80)).min(1).max(BULK_MAX) });

/**
 * The chosen videos as rows to send, in the order given, the link filled in only where a viewer can open it now (ready,
 * on, live, not expired), as for a batch; `share_state` says why one is blank: "failed" for a render that will never be
 * sendable (whatever its link says), else the link's "off", "expired", or "scheduled", else "not ready" while it renders.
 * A go-live time or expiry still ahead is given whatever the state, since it applies once the link is on or the render done.
 */
export function selectionLinkRows(videos: Video[], base: string, now = Date.now()): Array<Record<(typeof SELECTION_LINK_COLUMNS)[number], string | undefined>> {
  const origin = base.replace(/\/$/, "");
  return videos.map((v) => {
    const state = shareState(v, now);
    const live = v.status === "completed" && !shareOffline(v, now);
    const ahead = (iso?: string) => (iso && Date.parse(iso) > now ? iso : undefined);
    return {
      title: v.title,
      status: v.status,
      share_state: v.status === "failed" ? "failed" : live ? "live" : state === "live" ? "not ready" : state,
      share_link: live ? `${origin}/share/${v.id}` : undefined,
      share_goes_live: ahead(v.shareStartsAt),
      share_expires: ahead(v.shareExpiresAt),
      password_required: v.shareLocked ? "yes" : undefined,
      email_required: v.shareGate ? "yes" : undefined,
      folder: v.folder,
      video_id: v.id,
      created: v.createdAt,
    };
  });
}

/**
 * The links of those rows a viewer can open now, one a line in the order given, for pasting into an email or a chat, and
 * how many rows had none (not ready, failed, off, expired, or scheduled), so the page can say they were left out.
 */
export function selectionLinkText(rows: ReturnType<typeof selectionLinkRows>): { text: string; links: number; unsendable: number } {
  const links = rows.flatMap((r) => (r.share_link ? [r.share_link] : []));
  return { text: links.join("\n"), links: links.length, unsendable: rows.length - links.length };
}

/**
 * A QR code of each of those rows' links a viewer can open now, as SVG files named after the videos (in the order given,
 * no two names alike), for printing several at once, and how many rows had no link to draw.
 */
export function selectionQrFiles(rows: ReturnType<typeof selectionLinkRows>): { files: Array<{ name: string; svg: string }>; links: number; unsendable: number } {
  const sendable = rows.flatMap((r) => (r.share_link ? [{ title: r.title ?? "", link: r.share_link }] : []));
  const names = qrFileNames(sendable.map((r) => r.title));
  const files = sendable.map((r, i) => ({ name: names[i], svg: qrSvg(r.link, qrWording("share", r.title).title) }));
  return { files, links: files.length, unsendable: rows.length - files.length };
}

/**
 * The owner's videos among `ids` (not those in the trash), in the order asked, renders in flight refreshed first (up to
 * 10 at a time, as the library's list); others are left out, which the route reports in a header.
 */
export async function selectionVideos(ids: string[], ownerId: string = LOCAL_OWNER): Promise<Video[]> {
  const byId = new Map((await listVideos(ownerId, false)).map((v) => [v.id, v]));
  const chosen = Array.from(new Set(ids)).flatMap((id) => byId.get(id) ?? []);
  if (!chosen.length) throw new NotFoundError("None of those videos are in the library");
  return refreshPending(chosen);
}

/** The library's videos of one batch (not those in the trash), renders in flight refreshed first; a batch with none is not found. */
export async function batchVideos(batchId: string, ownerId: string = LOCAL_OWNER): Promise<Video[]> {
  const videos = (await listVideos(ownerId, false)).filter((v) => v.batchId === batchId);
  if (!videos.length) throw new NotFoundError("Batch not found");
  return refreshPending(videos);
}

const BATCH_CONCURRENCY = 5;

export { MAX_RETRY_AT_ONCE };
const RETRY_CONCURRENCY = 3;

export const retryManySchema = z.object({ ids: z.array(z.string().min(1).max(80)).min(1).max(MAX_RETRY_AT_ONCE, `Retry up to ${MAX_RETRY_AT_ONCE} renders at a time`) });

/** Why a video was not started again, for the page to word. */
export type RetrySkip = "not_failed" | "trashed" | "edited_cut" | "retried" | "allowance";

const RETRY_SKIP_REASONS: Record<RetrySkip, string> = {
  not_failed: "Not a failed render",
  trashed: "In the trash",
  edited_cut: "An edited cut is not retried",
  retried: "Already started again",
  allowance: "This month's render allowance is used up",
};

export interface RetryManyResult {
  /** New videos started, each with the failed render it stands in for. */
  started: Array<{ from: string; id: string }>;
  /**
   * Not started after all: refused by the renderer straight away (`id` is the new video, kept as failed, as a single
   * retry's is) or not created at all (no `id`; the allowance used up in the meantime, say).
   */
  failedAgain: Array<{ from: string; id?: string; reason: string }>;
  /** Not started, with why. */
  skipped: Array<{ id: string; code: RetrySkip; reason: string }>;
  /** Not the owner's, unknown, or deleted for good. */
  missing: string[];
}

/**
 * Start many failed renders again, as one retry each (same settings, folder, and batch row), in the order given.
 * A failed render already retried is left alone (its newest copy is the one to retry), so selecting the same failed
 * cards twice does not pay for them twice. The month's allowance is checked for all of them before any starts, and
 * the ones past it are skipped; each start checks it again, so requests running side by side cannot pass it.
 */
export async function retryVideos(ids: string[], ownerId: string = LOCAL_OWNER): Promise<RetryManyResult> {
  const result: RetryManyResult = { started: [], failedAgain: [], skipped: [], missing: [] };
  const skip = (id: string, code: RetrySkip) => result.skipped.push({ id, code, reason: RETRY_SKIP_REASONS[code] });
  const retried = new Set((await listVideos(ownerId, false)).map((v) => v.retryOf).filter(Boolean));
  const eligible: string[] = [];
  const now = Date.now();
  for (const id of Array.from(new Set(ids))) {
    const v = await getStore().get<Video>("video", id);
    if (!v || (v.ownerId ?? LOCAL_OWNER) !== ownerId || purgeDue(v, now)) result.missing.push(id);
    else if (v.deletedAt) skip(id, "trashed");
    else if (v.status !== "failed") skip(id, "not_failed");
    else if (v.directed?.editOf) skip(id, "edited_cut");
    else if (retried.has(id)) skip(id, "retried");
    else eligible.push(id);
  }
  const limit = await renderLimitFor(ownerId);
  const allowed = limit ? Math.max(0, Math.min(eligible.length, limit - (await rendersThisMonth(ownerId)))) : eligible.length;
  for (const id of eligible.slice(allowed)) skip(id, "allowance");
  const outcomes: Array<{ from: string; id?: string; reason?: string }> = new Array(allowed);
  await runWithConcurrency(allowed, RETRY_CONCURRENCY, async (i) => {
    const from = eligible[i];
    try {
      const video = await retryVideo(from, ownerId);
      outcomes[i] = video.status === "failed" ? { from, id: video.id, reason: video.error ?? "The render could not be started" } : { from, id: video.id };
    } catch (err) {
      outcomes[i] = { from, reason: err instanceof Error ? err.message : "The render could not be started" };
    }
  });
  for (const o of outcomes) {
    if (o.reason) result.failedAgain.push({ from: o.from, ...(o.id ? { id: o.id } : {}), reason: o.reason });
    else result.started.push({ from: o.from, id: o.id! });
  }
  return result;
}

async function runWithConcurrency(count: number, concurrency: number, task: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const i = next++;
      await task(i);
    }
  });
  await Promise.all(workers);
}
