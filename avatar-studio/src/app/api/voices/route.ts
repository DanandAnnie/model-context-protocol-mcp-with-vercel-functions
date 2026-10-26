import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { MAX_CLONED_VOICES, listVoices } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Provider voices plus the owner's own voices (first), and how many of its own it may keep. */
export async function GET() {
  try {
    const voices = await listVoices(await requireOwner());
    // How many voices of its own the account keeps against how many it may (cloned or designed, with this provider).
    return json({ voices, own: { count: voices.filter((v) => v.source === "custom").length, limit: MAX_CLONED_VOICES } });
  } catch (err) {
    return errorResponse(err);
  }
}
