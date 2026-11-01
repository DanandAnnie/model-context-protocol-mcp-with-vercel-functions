import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { emptyTrash, emptyTrashSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Delete every video in the trash for good (`{ "expected": n }`, the count the caller saw; another count is a `409`),
 * up to 50 a call, side records included; `remaining` is what is still there.
 */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = emptyTrashSchema.parse(await readJson(req));
    const result = await emptyTrash(input, owner);
    if (result.done > 0) await recordRequestActivity(owner, "video.purged", { count: result.done });
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
