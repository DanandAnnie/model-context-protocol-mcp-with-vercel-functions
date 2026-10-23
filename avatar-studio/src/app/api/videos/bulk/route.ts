import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { bulkVideoSchema, bulkVideos } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Bulk delete or move-to-folder for the library's multi-select. */
export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const input = bulkVideoSchema.parse(await readJson(req));
    return json(await bulkVideos(input, owner));
  } catch (err) {
    return errorResponse(err);
  }
}
