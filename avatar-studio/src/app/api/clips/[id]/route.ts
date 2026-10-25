import { errorResponse } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { deleteClip, getClipAudio } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The clip's audio, for playback in the editor. Owner only; never cached by shared caches. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const audio = await getClipAudio(id, await requireOwner());
    return new Response(audio.bytes as BodyInit, {
      headers: {
        "Content-Type": audio.mimeType,
        "Content-Length": String(audio.bytes.byteLength),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Delete a clip and its audio. Rendered videos keep their footage. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await deleteClip((await ctx.params).id, await requireEditor());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
