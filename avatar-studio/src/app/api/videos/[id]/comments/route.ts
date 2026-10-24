import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { addComment, commentSchema, listComments } from "@/lib/services";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

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
    return json({ comment: await addComment((await ctx.params).id, input, owner, await userOrOwner(owner)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
