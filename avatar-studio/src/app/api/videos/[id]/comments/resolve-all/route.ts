import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { resolveAllComments, resolveAllSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
// Up to 200 threads, written a few at a time.
export const maxDuration = 60;

/**
 * `{ ids }`, the threads the caller was shown as open, are marked done, as anyone who can comment may resolve one
 * → `{ resolved, failed, open }`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireOwner({ write: true });
    const { id } = await ctx.params;
    const { ids } = resolveAllSchema.parse(await readJson(req));
    return json(await resolveAllComments(id, ids, owner, await userOrOwner(owner)));
  } catch (err) {
    return errorResponse(err);
  }
}
