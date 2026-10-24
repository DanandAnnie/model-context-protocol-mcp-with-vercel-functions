import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { listVoices } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Provider voices plus the owner's cloned voices (first). */
export async function GET() {
  try {
    return json({ voices: await listVoices(await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}
