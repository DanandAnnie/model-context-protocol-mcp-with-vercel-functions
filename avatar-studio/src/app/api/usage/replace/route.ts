import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { replaceUses, replaceUsesSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Switches every interactive presenter, saved template (and its scenes), the brand kit's default, and (for a voice)
 * every photo avatar's default voice from one presenter or voice to another. Editors only; videos are not changed.
 */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = replaceUsesSchema.parse(await readJson(req));
    return json({ replaced: await replaceUses(input, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
