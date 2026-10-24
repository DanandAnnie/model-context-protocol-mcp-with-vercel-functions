"use client";
import { useParams } from "next/navigation";
import { roleArticle } from "@/lib/roles";
import { useState } from "react";
import { Building2 } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, SectionTitle } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/client";

/** Join page behind an invite link. The proxy sends signed-out visitors to login and back here. */
export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { data, loading, error } = useApi<{ workspace: { id: string; name: string; members: number }; role: string }>(`/api/invites/${token}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/invites/${token}`, { method: "POST" });
      window.location.href = "/home";
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not join");
      setBusy(false);
    }
  }

  return (
    <>
      <SectionTitle title="Workspace invite" />
      <ErrorBanner message={err} />
      {loading ? null : !data ? (
        <EmptyState icon={<Building2 className="h-8 w-8" />} title="This invite link is invalid or has expired" body={error ?? "Ask the workspace owner for a new link."} />
      ) : (
        <Card className="max-w-lg p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
              <Building2 className="h-5 w-5" />
            </span>
            <div>
              <div className="text-base font-semibold text-slate-900">{data.workspace.name}</div>
              <div className="text-xs text-slate-500">
                {data.workspace.members} {data.workspace.members === 1 ? "member" : "members"} · you would join as {roleArticle(data.role)}
              </div>
            </div>
          </div>
          <p className="mt-4 text-sm text-slate-600">Joining makes this workspace active. Everything you create in it is shared with its members.</p>
          <Button className="mt-4" onClick={join} loading={busy}>
            Join workspace
          </Button>
        </Card>
      )}
    </>
  );
}
