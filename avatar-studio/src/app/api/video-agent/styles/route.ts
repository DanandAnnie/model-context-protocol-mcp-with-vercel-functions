import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { agentStylesAvailable, listAgentStyles } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The curated styles HeyGen's Video Agent composes in (`available: false` where the renderer has none). */
export async function GET() {
  try {
    await requireOwner();
    return json({ styles: await listAgentStyles(), available: agentStylesAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}
