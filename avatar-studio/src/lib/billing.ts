// Plans and billing. The plan decides the monthly render allowance; a billing provider changes the plan.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { nowIso } from "./ids";
import { LOCAL_OWNER } from "./owner-id";
import { getStore } from "./store";
import type { Plan, PlanId } from "./types";

export const planId = (ownerId: string) => `plan_${ownerId}`;

export async function getPlan(ownerId: string = LOCAL_OWNER): Promise<Plan> {
  const p = await getStore().get<Plan>("plan", planId(ownerId));
  return p && p.ownerId === ownerId ? p : { id: planId(ownerId), ownerId, plan: "free", updatedAt: nowIso() };
}

export async function setPlan(ownerId: string, patch: Partial<Omit<Plan, "id" | "ownerId" | "updatedAt">> & { plan: PlanId }): Promise<Plan> {
  const current = await getPlan(ownerId);
  const next: Plan = { ...current, ...patch, id: planId(ownerId), ownerId, updatedAt: nowIso() };
  if (patch.plan === "free") {
    delete next.subscriptionId;
    delete next.status;
    delete next.endsAt;
  }
  return getStore().put("plan", next);
}

/** Monthly render allowance for an owner, or null when unlimited. */
export async function renderLimitFor(ownerId: string): Promise<number | null> {
  const plan = await getPlan(ownerId);
  if (plan.plan === "pro") return config.proRendersPerMonth ?? null;
  return config.renderLimitPerMonth ?? null;
}

// ---------- Providers ----------

export interface BillingProvider {
  name: string;
  /** Starts an upgrade; returns the URL to send the browser to. */
  checkout(ownerId: string, returnUrl: string): Promise<{ url: string }>;
  /** Opens subscription management (cancel, update card); returns the URL. */
  portal(ownerId: string, returnUrl: string): Promise<{ url: string }>;
}

/** Demo billing: upgrades and downgrades take effect immediately, no payment. */
export class MockBillingProvider implements BillingProvider {
  name = "mock";
  async checkout(ownerId: string, returnUrl: string) {
    await setPlan(ownerId, { plan: "pro", provider: "mock", status: "active" });
    return { url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=upgraded` };
  }
  async portal(ownerId: string, returnUrl: string) {
    await setPlan(ownerId, { plan: "free", provider: "mock" });
    return { url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=cancelled` };
  }
}

/** Stripe via its REST API (form-encoded), so no SDK dependency. */
export class StripeBillingProvider implements BillingProvider {
  name = "stripe";
  constructor(private secretKey: string, private pricePro: string) {}

  private async call<T>(path: string, params: Record<string, string>): Promise<T> {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `Stripe returned ${res.status}`);
    return body;
  }

  async checkout(ownerId: string, returnUrl: string) {
    const plan = await getPlan(ownerId);
    const params: Record<string, string> = {
      mode: "subscription",
      "line_items[0][price]": this.pricePro,
      "line_items[0][quantity]": "1",
      client_reference_id: ownerId,
      "metadata[ownerId]": ownerId,
      "subscription_data[metadata][ownerId]": ownerId,
      success_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=upgraded`,
      cancel_url: returnUrl,
      allow_promotion_codes: "true",
    };
    if (plan.customerId) params.customer = plan.customerId;
    return this.call<{ url: string }>("checkout/sessions", params);
  }

  async portal(ownerId: string, returnUrl: string) {
    const plan = await getPlan(ownerId);
    if (!plan.customerId) throw new Error("No billing account yet; upgrade first");
    return this.call<{ url: string }>("billing_portal/sessions", { customer: plan.customerId, return_url: returnUrl });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __avatarStudioBilling: BillingProvider | undefined;
}

export function getBillingProvider(): BillingProvider {
  if (globalThis.__avatarStudioBilling) return globalThis.__avatarStudioBilling;
  const p: BillingProvider =
    config.billingProvider === "stripe" && config.stripeSecretKey && config.stripePricePro
      ? new StripeBillingProvider(config.stripeSecretKey, config.stripePricePro)
      : new MockBillingProvider();
  globalThis.__avatarStudioBilling = p;
  return p;
}

export function setBillingProvider(p: BillingProvider | undefined) {
  globalThis.__avatarStudioBilling = p;
}

// ---------- Stripe webhooks ----------

/** Verifies a `Stripe-Signature` header (t=…,v1=…) against the raw body. */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=") as [string, string]));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

/** Applies a verified Stripe event to the owner's plan. Returns the owner touched, or null when ignored. */
export async function applyStripeEvent(event: StripeEvent): Promise<string | null> {
  const obj = event.data.object;
  const meta = (obj.metadata as Record<string, string> | undefined) ?? {};
  const ownerId = (obj.client_reference_id as string | undefined) ?? meta.ownerId;
  switch (event.type) {
    case "checkout.session.completed": {
      if (!ownerId) return null;
      await setPlan(ownerId, {
        plan: "pro",
        provider: "stripe",
        customerId: typeof obj.customer === "string" ? obj.customer : undefined,
        subscriptionId: typeof obj.subscription === "string" ? obj.subscription : undefined,
        status: "active",
      });
      return ownerId;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (!ownerId) return null;
      const status = String(obj.status ?? "");
      const endsAt = obj.cancel_at_period_end && typeof obj.current_period_end === "number" ? new Date(obj.current_period_end * 1000).toISOString() : undefined;
      const active = event.type !== "customer.subscription.deleted" && ["active", "trialing", "past_due"].includes(status);
      await setPlan(ownerId, active ? { plan: "pro", provider: "stripe", status, endsAt, subscriptionId: typeof obj.id === "string" ? obj.id : undefined } : { plan: "free", provider: "stripe" });
      return ownerId;
    }
    default:
      return null;
  }
}
