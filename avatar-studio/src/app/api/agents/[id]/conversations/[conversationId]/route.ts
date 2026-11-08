import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { deleteConversation, getConversation, updateVisit } from "@/lib/services";
import { z } from "zod";
import { transcriptFilename, transcriptText } from "@/lib/transcripts";
import { MAX_VISIT_NOTE } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; conversationId: string }> };

/** One visit's transcript (`{ conversation }`), or with `?format=txt` a plain-text file of it to download. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id, conversationId } = await ctx.params;
    const { agent, conversation } = await getConversation(id, conversationId, await requireOwner());
    if (new URL(req.url).searchParams.get("format") !== "txt") return json({ conversation });
    return new Response(transcriptText(agent.name, conversation), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": transcriptFilename(agent.name, conversation.startedAt.slice(0, 10)),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const patchSchema = z
  .object({ followedUp: z.boolean().optional(), note: z.string().trim().max(MAX_VISIT_NOTE).optional() })
  .refine((b) => b.followedUp !== undefined || b.note !== undefined, { message: "Send followedUp or note" });

/**
 * The owner's own fields on one visit (editors) → `{ conversation }`: `followedUp` marks it followed up or clears the
 * mark, and `note` sets its private note (an empty one removes it).
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id, conversationId } = await ctx.params;
    const owner = await requireEditor();
    const change = patchSchema.parse(await readJson(req));
    return json({ conversation: await updateVisit(id, conversationId, change, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Deletes one visit's transcript of a shared presenter (editors): `{ deleted: false }` when it has no such visit. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id, conversationId } = await ctx.params;
    return json({ deleted: await deleteConversation(id, conversationId, await requireEditor()) });
  } catch (err) {
    return errorResponse(err);
  }
}
