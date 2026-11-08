import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { renameTag, tagRenameSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Renames a tag on every library video carrying it (case aside), or takes it off them all (empty `to`). */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    return json(await renameTag(tagRenameSchema.parse(await readJson(req)), owner));
  } catch (err) {
    return errorResponse(err);
  }
}
