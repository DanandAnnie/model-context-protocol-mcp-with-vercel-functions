import { errorResponse, json } from "@/lib/api-utils";
import { toCsv } from "@/lib/csv";
import { requireEditor, requireOwner } from "@/lib/owner";
import { clearConversations, listConversations } from "@/lib/services";

/** Conversations in one CSV download; up to this many, newest first. */
const CSV_LIMIT = 1000;
const CSV_COLUMNS = ["started", "last_message", "email", "name", "messages", "first_question", "last_reply"];

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Transcripts of visitor conversations with one shared presenter (newest first, up to 50); `?format=csv` downloads up to 1000 as a lead list. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    if (new URL(req.url).searchParams.get("format") !== "csv") return json({ conversations: await listConversations(id, owner) });
    const rows = (await listConversations(id, owner, CSV_LIMIT)).map((c) => {
      const asked = c.messages.filter((m) => m.role === "user");
      const replies = c.messages.filter((m) => m.role === "assistant");
      return {
        started: c.startedAt,
        last_message: c.updatedAt,
        email: c.visitor?.email,
        name: c.visitor?.name,
        messages: c.messages.length,
        first_question: asked[0]?.content,
        last_reply: replies[replies.length - 1]?.content,
      };
    });
    return new Response(toCsv(CSV_COLUMNS, rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="conversations-${id.replace(/[^\w.-]+/g, "_")}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    return json({ deleted: await clearConversations((await ctx.params).id, await requireEditor()) });
  } catch (err) {
    return errorResponse(err);
  }
}
