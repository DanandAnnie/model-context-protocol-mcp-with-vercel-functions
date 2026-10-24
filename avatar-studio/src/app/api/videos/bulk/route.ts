import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { bulkVideoSchema, bulkVideos, recordActivity } from "@/lib/services";
import type { ActivityKind } from "@/lib/types";

const BULK_ACTIVITY: Partial<Record<string, ActivityKind>> = { delete: "video.trashed", restore: "video.restored", purge: "video.purged" };

export const dynamic = "force-dynamic";

/** Bulk trash, restore, purge, move-to-folder, or share-link switch for the library's multi-select. */
export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const input = bulkVideoSchema.parse(await readJson(req));
    const result = await bulkVideos(input, owner);
    const kind = BULK_ACTIVITY[input.action];
    if (kind && result.done > 0) await recordActivity(owner, await userOrOwner(owner), kind, { count: result.done });
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
