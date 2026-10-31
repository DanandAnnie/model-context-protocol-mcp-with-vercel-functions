import { errorResponse, json } from "@/lib/api-utils";
import { toCsv } from "@/lib/csv";
import { requireEditor, requireOwner } from "@/lib/owner";
import { clearConversations, listConversations } from "@/lib/services";
import { MAX_CONVERSATIONS_PER_AGENT, MAX_OPENING_KEY, MAX_TRANSCRIPT_QUERY, conversationMatches } from "@/lib/transcripts";
import { ValidationError } from "@/lib/errors";

/** Conversations in one CSV download; up to this many, newest first. */
const CSV_LIMIT = 1000;
const CSV_COLUMNS = ["started", "last_message", "email", "name", "messages", "first_question", "last_reply"];

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Transcripts of visitor conversations with one shared presenter (newest first, every visit kept); `?format=csv` downloads up to
 * 1000 as a lead list, narrowed as the transcripts panel narrows its list by `q` (words, email, or name), `leads=1`, and
 * `first` (a "Most asked" question's `openingKey`).
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const params = new URL(req.url).searchParams;
    if (params.get("format") !== "csv") return json({ conversations: await listConversations(id, owner, MAX_CONVERSATIONS_PER_AGENT) });
    const q = params.get("q") ?? "";
    if (q.length > MAX_TRANSCRIPT_QUERY) throw new ValidationError(`A search is at most ${MAX_TRANSCRIPT_QUERY} characters`);
    const leadsOnly = params.get("leads") === "1";
    const first = params.get("first") ?? "";
    if (first.length > MAX_OPENING_KEY) throw new ValidationError(`An opening question is at most ${MAX_OPENING_KEY} characters`);
    const rows = (await listConversations(id, owner, CSV_LIMIT)).filter((c) => conversationMatches(c, q, leadsOnly, first || undefined)).map((c) => {
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
