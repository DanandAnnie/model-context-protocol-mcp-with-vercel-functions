// Personalized batches (one video per CSV row). Used by API routes only.
import { z } from "zod";
import { newId } from "../ids";
import { getStore } from "../store";
import type { Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { renderLimitFor } from "../billing";
import { ValidationError } from "../errors";
import { fillTemplate, parseCsv, placeholdersIn } from "../csv";
import { backgroundSchema, captionStyleSchema, createVideo, emotionSchema, pitchSchema, rendersThisMonth, resolveRenderContext } from "./videos";
import { getBrandKit } from "./brand";
import { stripPauses } from "../pauses";

export const MAX_BATCH_ROWS = 100;
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
  if (!stripPauses(scriptTemplate).trim()) return { empty, tooLong, blankTemplate: true };
  rows.forEach((row, i) => {
    const script = fillTemplate(scriptTemplate, row).trim();
    if (!stripPauses(script).trim()) empty.push(i + 1);
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
      },
      ownerId,
      ctx,
      true,
      { batchId, rowLabel: label },
    );
    videos[i] = video;
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
