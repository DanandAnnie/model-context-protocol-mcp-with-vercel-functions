import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { brandKitSchema, deleteBrandKit, getBrandKit, recordActivity, saveBrandKit } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The signed-in owner's brand kit (null until one is saved). */
export async function GET() {
  try {
    return json({ brand: await getBrandKit(await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const owner = await requireOwner();
    const input = brandKitSchema.parse(await readJson(req));
    const brand = await saveBrandKit(input, owner);
    await recordActivity(owner, await userOrOwner(owner), "brand.saved", { subject: input.name || undefined });
    return json({ brand });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    const owner = await requireOwner();
    await deleteBrandKit(owner);
    await recordActivity(owner, await userOrOwner(owner), "brand.removed");
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
