import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { addComment, commentSchema, listComments, notifyMentions, notifyReply } from "@/lib/services";
import { afterResponse } from "@/lib/services/shared";
import { COMMENT_CSV_COLUMNS, commentRows, markMine } from "@/lib/comment-list";
import { toCsv } from "@/lib/csv";
import { formatTimestamp } from "@/lib/text";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const owner = await requireOwner();
    const id = (await ctx.params).id;
    const comments = await listComments(id, owner);
    // ?format=csv: the same notes as a spreadsheet, threads in the order they were started.
    if (new URL(req.url).searchParams.get("format") === "csv") {
      return new Response(toCsv(COMMENT_CSV_COLUMNS, commentRows(comments, formatTimestamp)), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="comments-${id.replace(/[^\w.-]+/g, "_")}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    // `you` names the caller, so a browser shared by several people keeps what each has read apart.
    const you = (await userOrOwner(owner)).id;
    return json({ comments: markMine(comments, you), you });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const owner = await requireOwner({ write: true });
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
    return json({ comment: markMine([comment], comment.authorId)[0] }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
