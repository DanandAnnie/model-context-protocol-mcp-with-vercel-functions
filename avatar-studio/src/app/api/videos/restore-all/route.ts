import { errorResponse, json } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { restoreAll } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Bring every video in the trash back to the library (up to 200 a call); `remaining` is what is still there. */
export async function POST() {
  try {
    const owner = await requireEditor();
    const result = await restoreAll(owner);
    if (result.done > 0) await recordRequestActivity(owner, "video.restored", { count: result.done });
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
