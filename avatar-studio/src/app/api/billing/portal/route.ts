import { errorResponse, json } from "@/lib/api-utils";
import { getBillingProvider } from "@/lib/billing";
import { ValidationError } from "@/lib/errors";
import { presentedApiKey, requireOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

/** Opens subscription management for the active owner (with the mock, downgrades immediately). */
export async function POST(req: Request) {
  try {
    if (await presentedApiKey()) return json({ error: "Sign in to change billing" }, { status: 403 });
    const owner = await requireOwner();
    const returnUrl = `${new URL(req.url).origin}/settings`;
    try {
      return json(await getBillingProvider().portal(owner, returnUrl));
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Could not open billing");
    }
  } catch (err) {
    return errorResponse(err);
  }
}
