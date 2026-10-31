import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { deleteConversation, getConversation, setFollowedUp } from "@/lib/services";
import { z } from "zod";
import { transcriptText } from "@/lib/transcripts";
import { graphemes, wellFormed } from "@/lib/text";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; conversationId: string }> };

/** Percent-encodes a value for `filename*` (RFC 8187), where `encodeURIComponent` leaves ', (, ), and * as they are. */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The download's name: an ASCII slug for every client, and the presenter's own name for those that read `filename*`. */
function attachmentName(name: string, date: string): string {
  const agentName = wellFormed(name);
  const slug = agentName.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "") || "presenter";
  // Joiners stay, so an emoji sequence keeps its picture; the cut falls between letters and keeps the name within 200 bytes.
  const named = agentName.replace(/(?:(?!\u200D)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\/:*?"<>|])+/gu, "-").trim();
  let own = "";
  for (const g of graphemes(named)) {
    if (new TextEncoder().encode(own + g).length > 200) break;
    own += g;
  }
  own ||= "presenter";
  return `attachment; filename="conversation-${slug}-${date}.txt"; filename*=UTF-8''${rfc5987(`conversation-${own}-${date}.txt`)}`;
}

/** One visit's transcript (`{ conversation }`), or with `?format=txt` a plain-text file of it to download. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id, conversationId } = await ctx.params;
    const { agent, conversation } = await getConversation(id, conversationId, await requireOwner());
    if (new URL(req.url).searchParams.get("format") !== "txt") return json({ conversation });
    return new Response(transcriptText(agent.name, conversation), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": attachmentName(agent.name, conversation.startedAt.slice(0, 10)),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const patchSchema = z.object({ followedUp: z.boolean() });

/** Marks one visit followed up (`{ followedUp: true }`) or clears the mark (editors) → `{ conversation }`. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id, conversationId } = await ctx.params;
    const owner = await requireEditor();
    const { followedUp } = patchSchema.parse(await readJson(req));
    return json({ conversation: await setFollowedUp(id, conversationId, followedUp, owner) });
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
