"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { CreditCard, Sparkles } from "lucide-react";
import { Button, Card, ErrorBanner } from "@/components/ui";
import { api, formatDate } from "@/lib/client";
import type { ProviderStatus } from "@/lib/types";

/** Current plan, allowance, and upgrade / manage actions. */
/** `canManage` is false for workspace editors: the plan is shown but only owners can change it. */
export function PlanCard({ status, onChanged, canManage = true }: { status: ProviderStatus | null; onChanged: () => void; canManage?: boolean }) {
  const params = useSearchParams();
  const flash = params.get("billing");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const usage = status?.usage;
  const plan = usage?.plan ?? "free";
  const limit = status?.renderLimitPerMonth ?? null;

  async function go(path: "checkout" | "portal") {
    setBusy(true);
    setErr(null);
    try {
      const { url } = await api<{ url: string }>(`/api/billing/${path}`, { method: "POST" });
      if (status?.billing === "mock") {
        // The mock applied the change already; refresh in place instead of leaving the page.
        onChanged();
        window.history.replaceState(null, "", url);
        setBusy(false);
        return;
      }
      window.location.href = url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Billing is unavailable");
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 p-5" data-testid="plan-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <CreditCard className="h-4 w-4 text-slate-400" /> Plan
          </h3>
          <div className="mt-2 flex items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${plan === "pro" ? "bg-brand-100 text-brand-800" : "bg-slate-100 text-slate-700"}`} data-testid="plan-name">
              {plan === "pro" ? "Pro" : "Free"}
            </span>
            <span className="text-sm text-slate-600">
              {usage ? `${usage.rendersThisMonth} of ${limit ?? "unlimited"} renders used this month` : "…"}
            </span>
          </div>
          {usage?.subscriptionStatus && plan === "pro" && (
            <div className="mt-1 text-xs text-slate-500">
              Subscription {usage.subscriptionStatus}
              {usage.endsAt ? ` · ends ${formatDate(usage.endsAt)}` : ""}
            </div>
          )}
          {flash === "upgraded" && <div className="mt-2 text-xs font-medium text-emerald-700">Welcome to Pro.</div>}
          {flash === "cancelled" && <div className="mt-2 text-xs font-medium text-slate-700">Subscription cancelled; you are on the Free plan.</div>}
        </div>
        <div className="flex flex-col items-end gap-2">
          {!canManage ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="plan-owner-only">
              Only workspace owners can change the plan.
            </div>
          ) : plan === "pro" ? (
            <Button variant="secondary" onClick={() => go("portal")} loading={busy}>
              Manage subscription
            </Button>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              {usage?.billingAccount && (
                <Button variant="secondary" onClick={() => go("portal")} loading={busy}>
                  Manage subscription
                </Button>
              )}
              <Button onClick={() => go("checkout")} loading={busy}>
                <Sparkles className="h-4 w-4" /> Upgrade to Pro
              </Button>
            </div>
          )}
          <div className="text-right text-xs text-slate-500">
            Pro: {usage?.proRendersPerMonth ? `${usage.proRendersPerMonth} renders / month` : "unlimited renders"} · {usage?.proPriceLabel ?? ""}
            {status?.billing === "mock" && <div>Demo billing: changes apply instantly, no payment.</div>}
          </div>
        </div>
      </div>
      <ErrorBanner message={err} />
    </Card>
  );
}
