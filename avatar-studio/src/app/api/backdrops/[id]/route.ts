import { errorResponse } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { deleteBackdrop, getBackdropImage } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The image, for the editor's preview. Owner only; never cached by shared caches. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const image = await getBackdropImage(id, await requireOwner());
    return new Response(image.bytes as BodyInit, {
      headers: {
        "Content-Type": image.mimeType,
        "Content-Length": String(image.bytes.byteLength),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Delete a background image. Rendered videos keep their footage. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await deleteBackdrop((await ctx.params).id, await requireEditor());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
