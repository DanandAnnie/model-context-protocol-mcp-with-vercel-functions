import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { addComment, commentSchema, listComments, notifyMentions, notifyReply } from "@/lib/services";
import { afterResponse } from "@/lib/services/shared";
import { markMine } from "@/lib/comment-list";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const owner = await requireOwner();
    const comments = await listComments((await ctx.params).id, owner);
    return json({ comments: markMine(comments, (await userOrOwner(owner)).id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const owner = await requireOwner();
    const input = commentSchema.parse(await readJson(req));
    const comment = await addComment((await ctx.params).id, input, owner, await userOrOwner(owner));
    // Mentioned teammates, and for a reply the others in its thread, are emailed after the response, so a
    // slow mail provider never holds up the comment.
    // A mentioned member in the thread whose mention email did not go gets the reply email instead.
    if (comment.mentions?.length || comment.parentId) {
      await afterResponse(async () => {
        const mailed = new Set<string>();
        await notifyMentions(comment, mailed).catch((err) => console.error(`mention emails for comment ${comment.id} failed:`, err));
        await notifyReply(comment, mailed);
      });
    }
    return json({ comment: { ...comment, mine: true } }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
