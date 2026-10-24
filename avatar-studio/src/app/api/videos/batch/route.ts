import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { batchRequestSchema, createBatch, previewBatch } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const previewSchema = z.object({ scriptTemplate: z.string().max(5000), csv: z.string().max(200_000) });

/** PUT = preview substitutions without creating anything; POST = create one video per CSV row. */
export async function PUT(req: Request) {
  try {
    await requireEditor();
    const { scriptTemplate, csv } = previewSchema.parse(await readJson(req));
    return json(previewBatch(scriptTemplate, csv));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = batchRequestSchema.parse(await readJson(req));
    const result = await createBatch(input, owner);
    if (result.videos.length > 0 && result.failed.length === result.videos.length) {
      return json({ ...result, error: `No video could be started: ${result.failed[0].reason}` }, { status: 502 });
    }
    // The feed counts the rows that started rendering, not the ones the provider refused.
    const started = result.videos.length - result.failed.length;
    if (started > 0) await recordRequestActivity(owner, "batch.created", { subject: input.title, count: started });
    return json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
