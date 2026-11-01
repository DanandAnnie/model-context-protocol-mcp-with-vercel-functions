import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { retryManySchema, retryVideos } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Start many failed renders again (`{ "ids": [...] }`, up to 50), each as a single retry would, reporting every id. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const { ids } = retryManySchema.parse(await readJson(req));
    return json(await retryVideos(ids, owner));
  } catch (err) {
    return errorResponse(err);
  }
}
