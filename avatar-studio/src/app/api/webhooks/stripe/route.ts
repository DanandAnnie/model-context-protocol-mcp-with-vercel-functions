import { json } from "@/lib/api-utils";
import { applyStripeEvent, verifyStripeSignature } from "@/lib/billing";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Stripe events. Point the Stripe webhook at /api/webhooks/stripe with STRIPE_WEBHOOK_SECRET set. */
export async function POST(req: Request) {
  if (!config.stripeWebhookSecret) return json({ error: "Stripe webhooks are disabled: set STRIPE_WEBHOOK_SECRET" }, { status: 503 });
  const raw = await req.text();
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), config.stripeWebhookSecret)) {
    return json({ error: "Invalid signature" }, { status: 400 });
  }
  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const owner = await applyStripeEvent(event);
  return json({ received: true, applied: owner !== null });
}
