import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { readBrandKitFile } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Reads a brand kit file (as `GET /api/brand?format=json` gives one) for the signed-in space, saving nothing: answers
 * `{ kit, leftOut }`, the kit checked as a save would check it, with the default presenter, voice, or background this
 * space does not have left out and named. Editors only, as saving is.
 */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    return json(await readBrandKitFile(await readJson(req, "The brand kit file is too large: use a smaller logo"), owner));
  } catch (err) {
    return errorResponse(err);
  }
}
