import { errorResponse, json, readJson } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { visitorTranscript, visitorTranscriptSchema } from "@/lib/services";
import { transcriptFilename, transcriptText } from "@/lib/transcripts";

export const dynamic = "force-dynamic";

/**
 * Public: a visitor downloads their own conversation as a text file. It is a POST so the visit's id, which is their
 * token, stays out of the address, history, and logs.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const gate = rateLimit(`talk-transcript:${clientIp(req)}`, 20, 10 * 60 * 1000);
    if (!gate.allowed) return json({ error: "Too many downloads; try again later" }, { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } });
    const { agentName, conversation } = await visitorTranscript(id, visitorTranscriptSchema.parse(await readJson(req)));
    return new Response(transcriptText(agentName, conversation), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": transcriptFilename(agentName, conversation.startedAt.slice(0, 10)),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
