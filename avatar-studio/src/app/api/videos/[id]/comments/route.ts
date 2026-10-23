import { errorResponse, json, readJson } from "@/lib/api-utils";
import { currentUser, requireOwner } from "@/lib/owner";
import { addComment, commentSchema, listComments } from "@/lib/services";
import type { User } from "@/lib/workspaces";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** The person behind the request; a script with an API key is credited to the key's owner. */
async function commentAuthor(owner: string): Promise<User> {
  try {
    return await currentUser();
  } catch {
    return { id: owner };
  }
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    return json({ comments: await listComments((await ctx.params).id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const owner = await requireOwner();
    const input = commentSchema.parse(await readJson(req));
    return json({ comment: await addComment((await ctx.params).id, input, owner, await commentAuthor(owner)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
