import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { keepVoiceChangeAsClip } from "@/lib/services";

export const dynamic = "force-dynamic";
// The renderer's file is downloaded (up to 20 seconds) and stored.
export const maxDuration = 30;

/**
 * Keep a finished recording as one of the account's audio clips → `{ clip }`, `201` when made, `200` when it was kept
 * already and that clip still exists.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { clip, existing } = await keepVoiceChangeAsClip(id, await requireEditor());
    return json({ clip }, { status: existing ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
