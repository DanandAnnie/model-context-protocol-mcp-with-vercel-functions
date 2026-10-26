import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { brandImportSchema, importBrandFromWebsite } from "@/lib/services";

export const dynamic = "force-dynamic";

/** `{ url }` → `{ suggestion }`: a brand name, logo, and colours read from that public web page, for the form to review. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const limit = rateLimit(`brand-import:${owner}`, 10, 60_000);
    if (!limit.allowed) return json({ error: "Too many website imports; try again in a minute" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    const input = brandImportSchema.parse(await readJson(req));
    return json({ suggestion: await importBrandFromWebsite(input) });
  } catch (err) {
    return errorResponse(err);
  }
}
