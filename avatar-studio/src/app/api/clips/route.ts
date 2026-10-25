import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { clipUploadSchema, createClip, listClips } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Audio clips scenes can lip-sync to, newest first (metadata only). */
export async function GET() {
  try {
    return json({ clips: await listClips(await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Upload a clip as a data URL: WAV (length read from the file) or MP3 (with `durationSec`). */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = clipUploadSchema.parse(await readJson(req));
    return json({ clip: await createClip(input, owner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
