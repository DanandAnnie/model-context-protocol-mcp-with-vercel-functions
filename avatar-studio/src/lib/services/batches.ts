// Personalized batches (one video per CSV row). Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getAvatarProviderByName, getTranslateProviderByName } from "../providers";
import { getStore } from "../store";
import type { Translation, Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { renderLimitFor } from "../billing";
import { NotFoundError, ValidationError } from "../errors";
import { fillTemplate, parseCsv, placeholdersIn } from "../csv";
import { PUBLIC_ACCESS, owned, scheduleNotification, stripUndefined } from "./shared";
import { backgroundSchema, createVideo, rendersThisMonth, resolveRenderContext } from "./videos";

export const MAX_BATCH_ROWS = 100;

export const batchRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  /** Script with {column} placeholders. */
  scriptTemplate: z.string().trim().min(1).max(5000),
  /** Raw CSV text; the first row is the header. */
  csv: z.string().min(1).max(200_000),
  avatarId: z.string().min(1),
  voiceId: z.string().min(1),
  aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
  background: backgroundSchema.default({ type: "color", value: "#f1f5f9" }),
  captions: z.boolean().default(false),
  speed: z.number().min(0.5).max(1.5).default(1),
});

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
  return { columns: table.columns, rowCount: table.rows.length, missing, samples };
}

export async function createBatch(input: z.infer<typeof batchRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<BatchResult> {
  const table = parseCsv(input.csv);
  if (table.columns.length === 0 || table.rows.length === 0) throw new ValidationError("The CSV needs a header row and at least one data row");
  if (table.rows.length > MAX_BATCH_ROWS) throw new ValidationError(`A batch can have at most ${MAX_BATCH_ROWS} rows`);
  const missing = placeholdersIn(input.scriptTemplate).filter((c) => !table.columns.includes(c));
  if (missing.length) throw new ValidationError(`The script uses columns the CSV does not have: ${missing.join(", ")}`);

  const batchId = newId("batch");
  const labelColumn = table.columns[0];

  // Resolve avatar and voice once (they may cost provider round-trips) and reserve
  // the allowance for the whole batch before starting any row.
  const ctx = await resolveRenderContext(input, ownerId);
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
        background: input.background,
        captions: input.captions,
        speed: input.speed,
      },
      ownerId,
      ctx,
      true,
    );
    videos[i] = await getStore().put("video", { ...video, batchId, rowLabel: label });
    if (video.status === "failed") failed.push({ row: i + 1, reason: video.error ?? "The render could not be started" });
  };
  await runWithConcurrency(allowedRows, BATCH_CONCURRENCY, startRow);
  failed.sort((a, b) => a.row - b.row);
  return { batchId, videos, skipped, failed };
}

const BATCH_CONCURRENCY = 5;

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

export async function listVideos(ownerId: string = LOCAL_OWNER): Promise<Video[]> {
  const videos = await getStore().list<Video>("video", ownerId);
  videos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return videos;
}

/**
 * Fetch a video and, if it is still rendering, refresh its status from the provider.
 * Pass `PUBLIC_ACCESS` (null) for public access (share page); otherwise the video must belong to the owner.
 */
export async function getVideo(id: string, ownerId: string | null = LOCAL_OWNER, refresh = true): Promise<Video> {
  const video = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  if (!refresh || !video.providerJobId || (video.status !== "processing" && video.status !== "queued")) return video;

  try {
    const update = await getAvatarProviderByName(video.provider).getStatus(video.providerJobId);
    const next: Video = { ...video, ...stripUndefined(update), updatedAt: nowIso() };
    if (next.status !== video.status || next.videoUrl !== video.videoUrl) {
      await getStore().put("video", next);
      await scheduleNotification(video, next);
    }
    return next;
  } catch (err) {
    // Transient provider errors should not flip the job to failed; surface in logs only.
    console.error(`status refresh failed for ${id}:`, err);
    return video;
  }
}



export const MAX_FOLDER_NAME = 40;

export const videoPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    /** Folder name; an empty string moves the video back to "unfiled". */
    folder: z.string().trim().max(MAX_FOLDER_NAME).optional(),
  })
  .refine((p) => p.title !== undefined || p.folder !== undefined, "Nothing to update");

export async function updateVideo(id: string, patch: z.infer<typeof videoPatchSchema>, ownerId: string = LOCAL_OWNER): Promise<Video> {
  const existing = owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  const next: Video = { ...existing, updatedAt: nowIso() };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.folder !== undefined) {
    if (patch.folder) next.folder = patch.folder;
    else delete next.folder;
  }
  return getStore().put("video", next);
}

/**
 * Count a share-page view. Public: no owner check. Only completed videos accumulate views,
 * so a page opened while rendering is not a view. `gate` runs only for a countable view
 * (the route's per-viewer window), so an early visit does not use up the viewer's slot.
 */
export async function recordView(id: string, gate: () => boolean = () => true): Promise<{ views: number; counted: boolean }> {
  const video = await getStore().get<Video>("video", id);
  if (!video) throw new NotFoundError(`Video ${id} not found`);
  if (video.status !== "completed" || !gate()) return { views: video.views ?? 0, counted: false };
  const views = (video.views ?? 0) + 1;
  await getStore().put("video", { ...video, views, lastViewedAt: nowIso() });
  return { views, counted: true };
}

export const bulkVideoSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), ids: z.array(z.string().min(1)).min(1).max(200) }),
  z.object({ action: z.literal("move"), ids: z.array(z.string().min(1)).min(1).max(200), folder: z.string().trim().max(MAX_FOLDER_NAME) }),
]);

/** Delete or move many videos at once. Ids that are missing or belong to someone else are reported, not failed. */
export async function bulkVideos(input: z.infer<typeof bulkVideoSchema>, ownerId: string = LOCAL_OWNER): Promise<{ done: number; missing: string[] }> {
  const missing: string[] = [];
  let done = 0;
  for (const id of Array.from(new Set(input.ids))) {
    const existing = await getStore().get<Video>("video", id);
    if (!existing || (existing.ownerId ?? LOCAL_OWNER) !== ownerId) {
      missing.push(id);
      continue;
    }
    if (input.action === "delete") await getStore().remove("video", id);
    else await updateVideo(id, { folder: input.folder }, ownerId);
    done += 1;
  }
  return { done, missing };
}

export async function deleteVideo(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  owned(await getStore().get<Video>("video", id), ownerId, `Video ${id}`);
  await getStore().remove("video", id);
}

export async function applyAvatarWebhook(providerName: string, body: unknown): Promise<Video | null> {
  const provider = getAvatarProviderByName(providerName);
  const parsed = provider.parseWebhook?.(body);
  if (!parsed) return null;
  const video = await getStore().findBy<Video>("video", "providerJobId", parsed.providerJobId);
  if (!video) return null;
  const next: Video = { ...video, ...stripUndefined(parsed.update), updatedAt: nowIso() };
  await getStore().put("video", next);
  await scheduleNotification(video, next);
  return next;
}

export async function applyTranslationWebhook(providerName: string, body: unknown): Promise<Translation | null> {
  const provider = getTranslateProviderByName(providerName);
  const parsed = provider.parseWebhook?.(body);
  if (!parsed) return null;
  const item = await getStore().findBy<Translation>("translation", "providerJobId", parsed.providerJobId);
  if (!item) return null;
  const next: Translation = { ...item, ...stripUndefined(parsed.update), updatedAt: nowIso() };
  return getStore().put("translation", next);
}
