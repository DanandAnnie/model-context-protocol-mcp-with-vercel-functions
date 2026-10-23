import { errorResponse, json } from "@/lib/api-utils";
import { getBillingProvider } from "@/lib/billing";
import { ValidationError } from "@/lib/errors";
import { presentedApiKey, requireOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

/** Starts an upgrade to Pro for the active owner. Browser sessions only. */
export async function POST(req: Request) {
  try {
    if (await presentedApiKey()) return json({ error: "Sign in to change billing" }, { status: 403 });
    const owner = await requireOwner();
    const returnUrl = `${new URL(req.url).origin}/settings`;
    try {
      return json(await getBillingProvider().checkout(owner, returnUrl));
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Could not start checkout");
    }
  } catch (err) {
    return errorResponse(err);
  }
}
