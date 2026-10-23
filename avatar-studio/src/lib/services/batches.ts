// Personalized batches (one video per CSV row). Used by API routes only.
import { z } from "zod";
import { newId } from "../ids";
import { getStore } from "../store";
import type { Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { renderLimitFor } from "../billing";
import { ValidationError } from "../errors";
import { fillTemplate, parseCsv, placeholdersIn } from "../csv";
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
  resolution: z.enum(["720p", "1080p"]).optional(),
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
        resolution: input.resolution ?? "1080p",
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
