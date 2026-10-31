import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { cloneVoice, cloneVoiceSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Clone a voice from recorded or uploaded samples (data URLs). */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = cloneVoiceSchema.parse(await readJson(req));
    return json({ voice: await cloneVoice(input, owner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
