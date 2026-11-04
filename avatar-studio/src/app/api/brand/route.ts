import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor, requireOwner } from "@/lib/owner";
import { brandKitFile, brandKitFileName, brandKitSchema, deleteBrandKit, getBrandKit, saveBrandKit } from "@/lib/services";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * The signed-in owner's brand kit (null until one is saved), or with `?format=json` the kit as a file to keep or to load
 * into another space (404 while none is saved).
 */
export async function GET(req: Request) {
  try {
    const brand = await getBrandKit(await requireOwner());
    if (new URL(req.url).searchParams.get("format") === "json") {
      if (!brand) throw new NotFoundError("No brand kit is saved yet");
      return new Response(`${JSON.stringify(brandKitFile(brand), null, 2)}\n`, {
        headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${brandKitFileName(brand)}"`, "Cache-Control": "no-store" },
      });
    }
    return json({ brand });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const owner = await requireEditor();
    const input = brandKitSchema.parse(await readJson(req));
    const brand = await saveBrandKit(input, owner);
    await recordRequestActivity(owner, "brand.saved", { subject: input.name || undefined });
    return json({ brand });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    const owner = await requireEditor();
    await deleteBrandKit(owner);
    await recordRequestActivity(owner, "brand.removed");
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
