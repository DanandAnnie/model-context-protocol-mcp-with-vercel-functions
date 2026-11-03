import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { otherUses } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * What besides videos names each presenter and voice: interactive presenters, saved templates, the brand kit's
 * defaults, and a photo avatar's default voice, by id. The Avatars and Voices pages warn with it before a delete.
 */
export async function GET() {
  try {
    return json(await otherUses(await requireOwner()));
  } catch (err) {
    return errorResponse(err);
  }
}
