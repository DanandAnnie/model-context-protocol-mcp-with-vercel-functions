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

/**
 * Subscription states Stripe can still charge, cancellable from the billing portal. Wider than the states that
 * give Pro (an unpaid or incomplete subscription is Free in the app but may still bill).
 */
const RENEWING = ["active", "trialing", "past_due", "unpaid", "incomplete"];

const CANCEL_FIRST = "A Stripe subscription can still bill this account; cancel it first under Settings, Manage subscription";

/**
 * Refuses (400) while a Stripe subscription can still bill this owner: deleting the plan row would leave them
 * billed with no way to reach the billing portal. For anyone who has been a Stripe customer, Stripe itself is
 * asked about every subscription of theirs, so a missed webhook neither blocks a cancelled plan nor lets a renewing
 * one through; without an answer from Stripe the stored plan decides, and a failed lookup refuses.
 */
export async function assertNoRenewingPlan(ownerId: string): Promise<void> {
  const plan = await getPlan(ownerId);
  if (plan.provider !== "stripe") return;
  const storedRenews = plan.plan === "pro" && !plan.endsAt;
  const provider = getBillingProvider();
  if (!plan.customerId || !provider.customerRenews) {
    if (storedRenews) throw new ValidationError(CANCEL_FIRST);
    return;
  }
  let renews: boolean;
  try {
    renews = await provider.customerRenews(plan.customerId);
  } catch {
    throw new ValidationError("Could not check the subscription with Stripe; try again in a moment");
  }
  if (renews) throw new ValidationError(CANCEL_FIRST);
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
  /** Asks the billing provider whether any of the customer's subscriptions can charge again (for when a webhook was missed). */
  customerRenews?(customerId: string): Promise<boolean>;
  /** Cancels a subscription at once (one that belongs to a workspace deleted while it was being bought). */
  cancelSubscription?(subscriptionId: string): Promise<void>;
}

/**
 * A plan Stripe has billed is left alone by demo billing (a deployment whose Stripe settings went missing, say):
 * rewriting it would hide the Stripe customer from the deletion check while Stripe may still charge them.
 */
async function refuseStripePlan(ownerId: string): Promise<void> {
  const plan = await getPlan(ownerId);
  if (plan.provider === "stripe") throw new ValidationError("This plan is billed through Stripe, which is not configured here");
}

/** Demo billing: upgrades and downgrades take effect immediately, no payment. */
export class MockBillingProvider implements BillingProvider {
  name = "mock";
  async checkout(ownerId: string, returnUrl: string) {
    await refuseStripePlan(ownerId);
    await setPlan(ownerId, { plan: "pro", provider: "mock", status: "active" });
    return { url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=upgraded` };
  }
  async portal(ownerId: string, returnUrl: string) {
    await refuseStripePlan(ownerId);
    await setPlan(ownerId, { plan: "free", provider: "mock" });
    return { url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=cancelled` };
  }
}

/** Stripe via its REST API (form-encoded), so no SDK dependency. */
export class StripeBillingProvider implements BillingProvider {
  name = "stripe";
  constructor(private secretKey: string, private pricePro: string) {}

  private async call<T>(path: string, params?: Record<string, string>, method?: "DELETE"): Promise<T> {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: method ?? (params ? "POST" : "GET"),
      headers: { Authorization: `Bearer ${this.secretKey}`, ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: params ? new URLSearchParams(params).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as T & { error?: { message?: string; code?: string } };
    if (!res.ok) throw Object.assign(new Error(body.error?.message ?? `Stripe returned ${res.status}`), { code: body.error?.code });
    return body;
  }

  async customerRenews(customerId: string): Promise<boolean> {
    try {
      const subs = await this.call<{ data: Array<Record<string, unknown>>; has_more?: boolean }>(
        `subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`,
      );
      if (subs.data.some((s) => RENEWING.includes(String(s.status)) && !s.cancel_at_period_end && typeof s.cancel_at !== "number")) return true;
      // Past the first page nothing has been checked; the app makes one subscription per checkout, so this is a guard.
      if (subs.has_more) throw new Error("Too many Stripe subscriptions to check");
      return false;
    } catch (err) {
      // A customer Stripe no longer has cannot be billed, nor can a test-mode one looked up with a live key. A live
      // customer looked up with a test key ("a similar object exists in live mode") may be billing, so that stays an error.
      const e = err as { code?: string; message?: string };
      if (e.code === "resource_missing" && !/exists in live mode/i.test(e.message ?? "")) return false;
      throw err;
    }
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    try {
      await this.call(`subscriptions/${encodeURIComponent(subscriptionId)}`, undefined, "DELETE");
    } catch (err) {
      // Already gone is what was asked for; anything else is thrown so the webhook fails and Stripe retries it.
      if ((err as { code?: string }).code !== "resource_missing") throw err;
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
  // A workspace deleted while its checkout was open (deletion is allowed then: nothing billed yet).
  const orphaned = Boolean(ownerId?.startsWith("ws_")) && !(await getStore().get("workspace", ownerId!));
  switch (event.type) {
    case "checkout.session.completed": {
      if (!ownerId) return null;
      const subscription = typeof obj.subscription === "string" ? obj.subscription : undefined;
      // Nobody can reach a deleted workspace's billing portal, so its new subscription is cancelled here. If that
      // fails, the ids are recorded and the error fails the webhook, so Stripe retries it.
      const cancel = getBillingProvider().cancelSubscription;
      if (orphaned && subscription && cancel) {
        try {
          await cancel.call(getBillingProvider(), subscription);
          return null;
        } catch (err) {
          await setPlan(ownerId, { plan: "pro", provider: "stripe", customerId: typeof obj.customer === "string" ? obj.customer : undefined, subscriptionId: subscription, status: "active" });
          throw err;
        }
      }
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
      // A deleted workspace gets no plan row back from its subscription's later events; one that can still bill
      // (its checkout event missed) is cancelled at Stripe, failing the webhook for a retry if that fails.
      if (orphaned) {
        const provider = getBillingProvider();
        if (event.type === "customer.subscription.updated" && RENEWING.includes(status) && typeof obj.id === "string" && provider.cancelSubscription) {
          await provider.cancelSubscription(obj.id);
        }
        return null;
      }
      const endsAt = stripeEndsAt(obj);
      const active = event.type !== "customer.subscription.deleted" && ["active", "trialing", "past_due"].includes(status);
      // The customer comes along when the event carries it (a missed or late checkout event would otherwise leave none).
      const customer = typeof obj.customer === "string" ? { customerId: obj.customer } : {};
      await setPlan(ownerId, active ? { plan: "pro", provider: "stripe", status, endsAt, subscriptionId: typeof obj.id === "string" ? obj.id : undefined, ...customer } : { plan: "free", provider: "stripe", ...customer });
      return ownerId;
    }
    default:
      return null;
  }
}
