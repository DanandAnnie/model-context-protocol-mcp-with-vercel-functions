import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { backdropRenameSchema, deleteBackdrop, getBackdropImage, renameBackdrop } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The image, for the editor's preview. Owner only; never cached by shared caches, and checked again on every use so a deleted image goes at once. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const image = await getBackdropImage(id, await requireOwner());
    return new Response(image.bytes as BodyInit, {
      headers: {
        "Content-Type": image.mimeType,
        "Content-Length": String(image.bytes.byteLength),
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Rename a background image: `{ name }` → `{ backdrop }`. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const owner = await requireEditor();
    const { name } = backdropRenameSchema.parse(await readJson(req));
    return json({ backdrop: await renameBackdrop((await ctx.params).id, name, owner) });
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
