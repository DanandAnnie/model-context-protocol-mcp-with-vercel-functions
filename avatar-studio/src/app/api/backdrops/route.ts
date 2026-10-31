import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { backdropUploadSchema, createBackdrop, listBackdrops } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Uploaded background images, newest first (metadata only). */
export async function GET() {
  try {
    return json({ backdrops: await listBackdrops(await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Upload a background image as a data URL (PNG or JPEG, 3 MB). */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = backdropUploadSchema.parse(await readJson(req));
    return json({ backdrop: await createBackdrop(input, owner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
