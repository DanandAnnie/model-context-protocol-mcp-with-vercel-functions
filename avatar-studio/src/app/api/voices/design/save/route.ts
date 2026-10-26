import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { saveDesignedVoice, saveDesignedVoiceSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Keep one designed preview as a voice of the account. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = saveDesignedVoiceSchema.parse(await readJson(req));
    return json({ voice: await saveDesignedVoice(input, owner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
