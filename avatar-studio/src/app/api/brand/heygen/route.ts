import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { agentBrandSchema, getAgentBrand, importAgentBrand, removeAgentBrand } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The account's HeyGen brand kit for directed videos (null when none is in use), asked about again while HeyGen reads the page. */
export async function GET() {
  try {
    return json({ kit: await getAgentBrand(await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** `{ url }` → `{ kit }`: HeyGen imports that public page as the account's brand kit, in place of the one it had. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const limit = rateLimit(`agent-brand:${owner}`, 5, 60_000);
    if (!limit.allowed) return json({ error: "Too many brand kit imports; try again in a minute" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    const input = agentBrandSchema.parse(await readJson(req));
    return json({ kit: await importAgentBrand(input, owner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Stops dressing directed videos in the account's HeyGen brand kit. */
export async function DELETE() {
  try {
    await removeAgentBrand(await requireEditor());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
