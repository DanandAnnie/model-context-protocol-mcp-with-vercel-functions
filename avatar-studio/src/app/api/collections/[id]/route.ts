import { errorResponse, json, readJson } from "@/lib/api-utils";
import { publicOrigin } from "@/lib/config";
import { collectionJson } from "@/lib/collection-json";
import { requireEditor } from "@/lib/owner";
import { stopSharingFolder, updateCollection } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Stops sharing a folder: its link answers "not found" from then on; the videos and their own links are untouched. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { id } = await ctx.params;
    await stopSharingFolder(id, owner);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Changes the folder's page: `{ "title" }` (its heading, up to 100 characters; empty shows the folder's name again),
 * `{ "note" }` (up to 500 characters; empty takes it off), `{ "order" }` (newest, oldest, or title), or any of them
 * together. Editors only.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { id } = await ctx.params;
    // The service checks the body, so a title or note that is too long is answered in words.
    const collection = await updateCollection(id, await readJson(req), owner);
    return json({ collection: collectionJson(collection, publicOrigin(req)) });
  } catch (err) {
    return errorResponse(err);
  }
}
