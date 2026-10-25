// Plans and billing. The plan decides the monthly render allowance; a billing provider changes the plan.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { nowIso } from "./ids";
import { LOCAL_OWNER } from "./owner-id";
import { getStore } from "./store";
import { ValidationError } from "./errors";
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

/** Subscription states Stripe still charges, and that can be cancelled from the billing portal. */
const RENEWING = ["active", "trialing", "past_due", "unpaid"];

/**
 * Refuses (400) while a Stripe subscription still renews for this owner: deleting the plan row would leave
 * them billed with no way to reach the billing portal. The stored plan answers first; when it says the plan
 * renews, Stripe is asked too, so a cancellation whose webhook never arrived does not block for good.
 */
export async function assertNoRenewingPlan(ownerId: string): Promise<void> {
  const plan = await getPlan(ownerId);
  if (plan.plan !== "pro" || plan.provider !== "stripe" || plan.endsAt) return;
  const provider = getBillingProvider();
  const renews = provider.subscriptionRenews ? await provider.subscriptionRenews(plan).catch(() => true) : true;
  if (renews) throw new ValidationError("Cancel the Pro plan first (Settings, Manage subscription); it keeps billing otherwise");
}

/** When a cancelled subscription stops: `cancel_at`, else the period end (on the items since Stripe's 2025-03-31 API). */
function stripeEndsAt(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.cancel_at === "number") return new Date(obj.cancel_at * 1000).toISOString();
  if (!obj.cancel_at_period_end) return undefined;
  const item = ((obj.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [])[0];
  const end = typeof obj.current_period_end === "number" ? obj.current_period_end : item?.current_period_end;
  return typeof end === "number" ? new Date(end * 1000).toISOString() : undefined;
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
  /** Asks the billing provider whether the plan's subscription will charge again (for when a webhook was missed). */
  subscriptionRenews?(plan: Plan): Promise<boolean>;
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

  private async call<T>(path: string, params?: Record<string, string>): Promise<T> {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: params ? "POST" : "GET",
      headers: { Authorization: `Bearer ${this.secretKey}`, ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: params ? new URLSearchParams(params).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as T & { error?: { message?: string; code?: string } };
    if (!res.ok) throw Object.assign(new Error(body.error?.message ?? `Stripe returned ${res.status}`), { code: body.error?.code });
    return body;
  }

  async subscriptionRenews(plan: Plan): Promise<boolean> {
    if (!plan.subscriptionId) return false;
    try {
      const sub = await this.call<Record<string, unknown>>(`subscriptions/${encodeURIComponent(plan.subscriptionId)}`);
      return RENEWING.includes(String(sub.status)) && !sub.cancel_at_period_end && typeof sub.cancel_at !== "number";
    } catch (err) {
      // A subscription Stripe no longer has cannot charge; any other failure is treated as "still renews".
      if ((err as { code?: string }).code === "resource_missing") return false;
      throw err;
    }
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
  // A deleted workspace gets no plan row back from a late event (its subscription's final "deleted", say).
  if (ownerId?.startsWith("ws_") && !(await getStore().get("workspace", ownerId))) return null;
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
      const endsAt = stripeEndsAt(obj);
      const active = event.type !== "customer.subscription.deleted" && ["active", "trialing", "past_due"].includes(status);
      await setPlan(ownerId, active ? { plan: "pro", provider: "stripe", status, endsAt, subscriptionId: typeof obj.id === "string" ? obj.id : undefined } : { plan: "free", provider: "stripe" });
      return ownerId;
    }
    default:
      return null;
  }
}
