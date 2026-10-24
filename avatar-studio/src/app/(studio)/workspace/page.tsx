"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Activity, Check, Copy, Link2, Trash2, UserMinus } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import { describeActivity } from "@/lib/activity-text";
import type { ActivityEvent } from "@/lib/types";

interface View {
  id: string;
  name: string;
  role: "owner" | "editor" | null;
  members: Array<{ userId: string; email?: string; role: "owner" | "editor"; joinedAt: string; you: boolean }>;
  invites: Array<{ token: string; email?: string; role: "owner" | "editor"; expiresAt: string }>;
}
interface Summary {
  personalId: string;
  activeId: string;
  workspaces: View[];
}

/** Members and invites of the active workspace. */
export default function WorkspacePage() {
  const router = useRouter();
  const { data, loading, error, refetch } = useApi<Summary>("/api/workspaces");
  const ws = data?.workspaces.find((w) => w.id === data.activeId) ?? null;
  const activity = useApi<{ events: ActivityEvent[] }>(ws ? "/api/activity?limit=30" : null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "editor">("editor");
  const [link, setLink] = useState<string | null>(null);
  const [mailNote, setMailNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await Promise.all([refetch(), activity.refetch()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function invite() {
    if (!ws) return;
    await run(async () => {
      const res = await api<{ url: string; emailed: boolean; emailError?: string }>(`/api/workspaces/${ws.id}/invites`, { method: "POST", body: JSON.stringify({ email: email || undefined, role }) });
      setLink(res.url);
      setMailNote(res.emailed ? `Invite emailed to ${email}.` : res.emailError ? `Email failed (${res.emailError}); share the link instead.` : email ? "Email sending is not configured; share the link." : null);
      setEmail("");
    });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", link);
    }
  }

  if (loading) return <SectionTitle title="Workspace" subtitle="Loading…" />;
  if (!ws) {
    return (
      <>
        <SectionTitle title="Workspace" subtitle="You are in your personal space." />
        <ErrorBanner message={error} />
        <EmptyState title="No workspace selected" body="Pick a workspace in the sidebar, or create one to share videos, avatars, and settings with your team." />
      </>
    );
  }
  const isOwner = ws.role === "owner";

  return (
    <>
      <SectionTitle
        title={
          name === null ? (
            <span className="inline-flex items-center gap-2">
              {ws.name}
              {isOwner && (
                <button type="button" onClick={() => setName(ws.name)} className="text-sm font-normal text-slate-500 hover:text-slate-900">
                  Rename
                </button>
              )}
            </span>
          ) : (
            <input
              autoFocus
              aria-label="Workspace name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setName(null);
                if (e.key === "Enter" && name.trim()) run(async () => {
                  await api(`/api/workspaces/${ws.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
                  setName(null);
                });
              }}
              className={`${inputClass} max-w-xs text-2xl font-semibold`}
            />
          )
        }
        subtitle={`${ws.members.length} ${ws.members.length === 1 ? "member" : "members"} · you are ${ws.role === "owner" ? "an owner" : "an editor"} · everything created here is shared with the team`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                window.confirm("Leave this workspace?") &&
                run(async () => {
                  await api(`/api/workspaces/${ws.id}/members/${data!.personalId}`, { method: "DELETE" });
                  await api("/api/workspaces/switch", { method: "POST", body: JSON.stringify({ id: data!.personalId }) });
                  router.push("/home");
                  router.refresh();
                })
              }
            >
              <UserMinus className="h-4 w-4" /> Leave
            </Button>
            {isOwner && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  window.confirm(`Delete "${ws.name}"? Its videos and settings become unreachable for everyone.`) &&
                  run(async () => {
                    await api(`/api/workspaces/${ws.id}`, { method: "DELETE" });
                    await api("/api/workspaces/switch", { method: "POST", body: JSON.stringify({ id: data!.personalId }) });
                    window.location.href = "/home";
                  })
                }
              >
                <Trash2 className="h-4 w-4" /> Delete workspace
              </Button>
            )}
          </div>
        }
      />
      <ErrorBanner message={error ?? err} />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card className="divide-y divide-slate-100">
          {ws.members.map((m) => (
            <div key={m.userId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900">
                  {m.email ?? m.userId}
                  {m.you && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-600">you</span>}
                </div>
                <div className="text-xs text-slate-500">joined {formatDate(m.joinedAt)}</div>
              </div>
              <div className="flex items-center gap-2">
                {isOwner ? (
                  <select
                    aria-label={`Role for ${m.email ?? m.userId}`}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => run(async () => { await api(`/api/workspaces/${ws.id}/members/${m.userId}`, { method: "PATCH", body: JSON.stringify({ role: e.target.value }) }); })}
                    className={`${inputClass} w-auto py-1 text-xs`}
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                  </select>
                ) : (
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">{m.role}</span>
                )}
                {isOwner && !m.you && (
                  <Button
                    variant="secondary"
                    className="px-2.5 py-1 text-xs"
                    disabled={busy}
                    aria-label={`Remove ${m.email ?? m.userId}`}
                    onClick={() => window.confirm("Remove this member?") && run(async () => { await api(`/api/workspaces/${ws.id}/members/${m.userId}`, { method: "DELETE" }); })}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </Card>
        {isOwner && (
          <div className="space-y-4">
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-slate-900">Invite someone</h3>
              <p className="mt-1 text-xs text-slate-500">Creates a link that joins this workspace. Anyone with the link can use it, so send it privately. Links expire after 7 days.</p>
              <div className="mt-3 space-y-3">
                <Field label="Email (optional)" hint="Sent automatically when EMAIL_PROVIDER is configured; otherwise kept for your records.">
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" className={inputClass} />
                </Field>
                <Field label="Role">
                  <select value={role} onChange={(e) => setRole(e.target.value as "owner" | "editor")} className={inputClass}>
                    <option value="editor">Editor: create and manage videos</option>
                    <option value="owner">Owner: also manage members</option>
                  </select>
                </Field>
                <Button onClick={invite} loading={busy}>
                  <Link2 className="h-4 w-4" /> Create invite link
                </Button>
                {link && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" data-testid="invite-link">
                    {mailNote && <div className="mb-2 font-medium">{mailNote}</div>}
                    <code className="break-all">{link}</code>
                    <Button variant="secondary" className="mt-2 px-2.5 py-1 text-xs" onClick={copy}>
                      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy link"}
                    </Button>
                  </div>
                )}
              </div>
            </Card>
            {ws.invites.length > 0 && (
              <Card className="p-5">
                <h3 className="text-sm font-semibold text-slate-900">Pending invites</h3>
                <ul className="mt-2 divide-y divide-slate-100 text-xs">
                  {ws.invites.map((i) => (
                    <li key={i.token} className="flex items-center justify-between gap-2 py-2">
                      <span className="truncate text-slate-700">
                        {i.email ?? "Link invite"} · {i.role} · expires {formatDate(i.expiresAt)}
                      </span>
                      <button type="button" disabled={busy} onClick={() => run(async () => { await api(`/api/workspaces/${ws.id}/invites/${i.token}`, { method: "DELETE" }); })} className="text-slate-500 hover:text-rose-700">
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>
      <Card className="mt-6 p-5" data-testid="activity-feed">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Activity className="h-4 w-4 text-slate-500" aria-hidden /> Activity
        </h3>
        <p className="mt-1 text-xs text-slate-500">What the team did here: videos created, trashed, and restored, members, keys, the brand kit, and shared presenters. The last 200 events are kept.</p>
        <ErrorBanner message={activity.error} />
        {activity.data && activity.data.events.length === 0 && <p className="mt-3 text-sm text-slate-500">Nothing yet. Activity shows up here as the team works.</p>}
        {activity.data && activity.data.events.length > 0 && (
          <ol className="mt-3 divide-y divide-slate-100 text-sm">
            {activity.data.events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <span className="min-w-0 break-words text-slate-800">{describeActivity(e, data?.personalId)}</span>
                <time dateTime={e.createdAt} className="shrink-0 text-xs text-slate-500">
                  {formatDate(e.createdAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
