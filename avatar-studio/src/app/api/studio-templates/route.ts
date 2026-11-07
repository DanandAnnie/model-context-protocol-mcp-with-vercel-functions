import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { listStudioTemplates, studioTemplatesAvailable } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The renderer's API-ready HeyGen Studio templates, to fill and render. */
export async function GET() {
  try {
    await requireOwner();
    return json({ templates: await listStudioTemplates(), available: studioTemplatesAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}
