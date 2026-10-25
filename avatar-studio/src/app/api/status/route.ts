import { json } from "@/lib/api-utils";
import { getPlan, renderLimitFor } from "@/lib/billing";
import { config } from "@/lib/config";
import { UnauthorizedError } from "@/lib/errors";
import { requireOwner } from "@/lib/owner";
import { providerStatus } from "@/lib/providers";
import { rendersThisMonth } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = providerStatus();
  try {
    const owner = await requireOwner();
    const [used, limit, plan] = await Promise.all([rendersThisMonth(owner), renderLimitFor(owner), getPlan(owner)]);
    return json({
      ...status,
      renderLimitPerMonth: limit,
      usage: {
        rendersThisMonth: used,
        plan: plan.plan,
        proRendersPerMonth: config.proRendersPerMonth ?? null,
        proPriceLabel: config.proPriceLabel,
        subscriptionStatus: plan.status,
        endsAt: plan.endsAt,
        // A Stripe customer can open the billing portal even on Free (an unpaid subscription still bills there).
        billingAccount: plan.provider === "stripe" && Boolean(plan.customerId),
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) return json(status);
    throw err;
  }
}
