"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Activity, Check, Copy, Download, Link2, Trash2, UserMinus } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api, formatDate } from "@/lib/client";
import { ACTIVITY_AREAS, ACTIVITY_AREA_LABELS, ACTIVITY_KEPT, ACTIVITY_PAGE, activityFilterPhrase, canShowMoreActivity, nextActivityLimit, activitySeenKey, activitySeenMark, describeActivity, newActivityCount, newActivityIds, parseActivityArea, type ActivityArea } from "@/lib/activity-text";
import { readSeenMark } from "@/lib/comment-list";
import { roleArticle } from "@/lib/roles";
import type { ActivityEvent, WorkspaceRole } from "@/lib/types";

interface View {
  id: string;
  name: string;
  role: WorkspaceRole | null;
  members: Array<{ userId: string; email?: string; role: WorkspaceRole; joinedAt: string; you: boolean }>;
  invites: Array<{ token: string; email?: string; role: WorkspaceRole; expiresAt: string }>;
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
  const [area, setArea] = useState<ActivityArea | null>(null);
  // Whose events were picked: a member's user id, or the workspace id for scripts with an API key.
  const [picked, setPicked] = useState<string | null>(null);
  // The people the Who select offers, as it names them and as the feed's lines speak of them. A member with no
  // email is named by their id, as in the member list above, so two of them can be told apart.
  const people = ws
    ? [
        ...ws.members.map((m) => ({ id: m.userId, option: m.you ? "You" : (m.email ?? m.userId), phrase: m.you ? "you" : (m.email ?? m.userId) })),
        { id: ws.id, option: "Scripts with an API key", phrase: "a script with an API key" },
      ]
    : [];
  // The person in effect: one who has since left (or a pick from another workspace) no longer filters, so the
  // select, the list, the wording, and the download never disagree. Their events stay under Anyone.
  const actor = picked && people.some((p) => p.id === picked) ? picked : null;
  const filterQuery = `${area ? `&area=${area}` : ""}${actor ? `&actor=${encodeURIComponent(actor)}` : ""}`;
  // How many lines are asked for: a page at first, another with each Show more; a new filter starts over.
  // Kept with the filters it was asked under, so a change of filter asks for one page only, in one request; picking a
  // filter (even the one shown before) starts over.
  const [more, setMore] = useState<{ filters: string; limit: number } | null>(null);
  const limit = more && more.filters === filterQuery ? more.limit : ACTIVITY_PAGE;
  // When each member last did something here, from every kept event, for the member list.
  const lastActive = useApi<{ lastActive: Record<string, string> }>(ws ? "/api/activity?summary=1" : null);
  const activity = useApi<{ events: ActivityEvent[]; links?: Record<string, string>; area: ActivityArea | null; actor: string | null; limit?: number }>(ws ? `/api/activity?limit=${limit}${filterQuery}` : null);
  // A list is shown only under the filters it was fetched for, so switching never flashes the previous one.
  const events = activity.data && (activity.data.area ?? null) === area && (activity.data.actor ?? null) === actor ? activity.data.events : null;
  // The length the list shown was answered for (the server echoes it): while a longer one loads, the button and the
  // "30+" count go by the list on screen, so Show more stays where it is, busy, with the focus on it.
  const shownLimit = events ? (activity.data?.limit ?? limit) : limit;
  // What is new since this browser last showed this reader the whole feed of this workspace: the mark is read once
  // per workspace and kept for the visit, so the New badges stay while the page is open, then moved forward below.
  const seenKey = ws && data ? activitySeenKey(data.personalId, ws.id) : null;
  const [seen, setSeen] = useState<{ key: string; at: string | null } | null>(null);
  useEffect(() => {
    if (seenKey && seen?.key !== seenKey) setSeen({ key: seenKey, at: readSeenMark(seenKey) });
  }, [seenKey, seen?.key]);
  const fresh = seen && seen.key === seenKey && events ? newActivityIds(events, seen.at, data?.personalId) : new Set<string>();
  useEffect(() => {
    // Only the unfiltered feed moves the mark: a filtered one leaves out events that are still unseen.
    if (!seenKey || !events || area || actor || seen?.key !== seenKey) return;
    try {
      window.localStorage.setItem(seenKey, activitySeenMark(events, data?.personalId, readSeenMark(seenKey)));
    } catch {
      // Not kept: the same lines are new next time too.
    }
  }, [seenKey, events, area, actor, seen?.key, data?.personalId]);
  // A link to /workspace#activity (Home's notice) arrives before the card exists; bring it into view once it does.
  const scrolledToActivity = useRef(false);
  useEffect(() => {
    if (scrolledToActivity.current || !events || window.location.hash !== "#activity") return;
    scrolledToActivity.current = true;
    const card = document.getElementById("activity");
    card?.scrollIntoView({ block: "start" });
    card?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
  }, [events]);
  const whoPhrase = actor ? (people.find((p) => p.id === actor)?.phrase ?? null) : null;
  // An action that ends after the filter changed refetches the filter shown now, not the one it began under.
  const refetchActivity = useRef(activity.refetch);
  useEffect(() => {
    refetchActivity.current = activity.refetch;
  }, [activity.refetch]);
  // Set once the reader picks a filter, so the count is announced for Everything too but not on first load.
  const [filtered, setFiltered] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("editor");
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
      await Promise.all([refetch(), refetchActivity.current(), lastActive.refetch()]);
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
        subtitle={`${ws.members.length} ${ws.members.length === 1 ? "member" : "members"} · you are ${roleArticle(ws.role)} · ${ws.role === "viewer" ? "you can watch and comment; owners and editors create and change things" : "everything created here is shared with the team"}`}
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
                onClick={() => {
                  const typed = window.prompt(
                    `Delete "${ws.name}" for good? Its videos, translations, avatars, voices, audio clips, templates, presenters and their conversations, viewer emails, brand kit, and settings are deleted for everyone, and its API keys stop working. Cancel its Stripe subscription first. This cannot be undone.\n\nType the workspace name to confirm.`,
                  );
                  if (typed === null) return;
                  if (typed.trim() !== ws.name) return setErr("The name did not match, so nothing was deleted.");
                  void run(async () => {
                    await api(`/api/workspaces/${ws.id}`, { method: "DELETE" });
                    await api("/api/workspaces/switch", { method: "POST", body: JSON.stringify({ id: data!.personalId }) });
                    window.location.href = "/home";
                  });
                }}
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
                <div className="text-xs text-slate-500">
                  joined {formatDate(m.joinedAt)}
                  {lastActive.data?.lastActive && (
                    <span data-testid="member-last-active">
                      {" · "}
                      {lastActive.data.lastActive[m.userId] ? `last active ${formatDate(lastActive.data.lastActive[m.userId])}` : `no activity in the last ${ACTIVITY_KEPT} events`}
                    </span>
                  )}
                </div>
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
                    <option value="viewer">Viewer</option>
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
                  <select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} className={inputClass}>
                    <option value="editor">Editor: create and manage videos</option>
                    <option value="viewer">Viewer: watch and comment only</option>
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
      <Card id="activity" className="mt-6 scroll-mt-6 p-5" data-testid="activity-feed">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 tabIndex={-1} className="flex items-center gap-2 text-sm font-semibold text-slate-900 focus:outline-none">
            <Activity className="h-4 w-4 text-slate-500" aria-hidden /> Activity
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {/* Every kept event under the filter shown, as a spreadsheet to hand on or keep. */}
            {events && events.length > 0 && (
              <a
                href={`/api/activity?format=csv${filterQuery}`}
                download
                data-testid="activity-csv"
                aria-label={area || whoPhrase ? `Download CSV of the activity shown${activityFilterPhrase(area, whoPhrase)}` : "Download CSV of all activity"}
                className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                <Download className="h-3.5 w-3.5" aria-hidden /> Download CSV
              </a>
            )}
            <select
              aria-label="Activity by"
              className={`${inputClass} w-auto max-w-[14rem]`}
              value={actor ?? ""}
              onChange={(e) => {
                setPicked(e.target.value || null);
                setMore(null);
                setFiltered(true);
              }}
            >
              <option value="">Anyone</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.option}
                </option>
              ))}
            </select>
            <select
              aria-label="Activity area"
              className={`${inputClass} w-auto max-w-full`}
              value={area ?? ""}
              onChange={(e) => {
                setArea(parseActivityArea(e.target.value));
                setMore(null);
                setFiltered(true);
              }}
            >
              <option value="">Everything</option>
              {ACTIVITY_AREAS.map((a) => (
                <option key={a} value={a}>
                  {ACTIVITY_AREA_LABELS[a]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          What the team did here: videos made, trashed, restored, and deleted for good, batches, reviews and approvals, members, keys, the brand kit, shared presenters, and presenters or voices replaced. The last 200 events are kept.
        </p>
        <ErrorBanner message={activity.error} />
        <p className="sr-only" role="status">
          {filtered && events ? `${events.length === 0 ? "No" : events.length} ${events.length === 1 ? "event" : "events"} shown${activityFilterPhrase(area, whoPhrase)}` : ""}
        </p>
        {events && events.length === 0 && (
          <p className="mt-3 text-sm text-slate-500">
            {area || actor ? `Nothing${activityFilterPhrase(area, whoPhrase, true)} yet. The feed keeps the last 200 events.` : "Nothing yet. Activity shows up here as the team works."}
          </p>
        )}
        {fresh.size > 0 && (
          <p className="mt-2 text-xs font-medium text-sky-800" data-testid="activity-new-count">
            {/* Only the newest 30 lines load: when every one is new, there may be more. */}
            {newActivityCount(fresh.size, events?.length ?? 0, shownLimit)} new since your last visit
          </p>
        )}
        {events && events.length > 0 && (
          <ol className="mt-3 divide-y divide-slate-100 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                {/* Read before the sentence; the pill beside the time is for the eye. */}
                {fresh.has(e.id) && <span className="sr-only">New: </span>}
                {activity.data?.links?.[e.id] ? (
                  // The sentence itself is the link, so its name says where it goes ("You created “Launch”").
                  <Link href={activity.data.links[e.id]} className="min-w-0 break-words text-slate-800 underline decoration-slate-500 underline-offset-2 hover:text-brand-700 hover:decoration-brand-500">
                    {describeActivity(e, data?.personalId)}
                  </Link>
                ) : (
                  <span className="min-w-0 break-words text-slate-800">{describeActivity(e, data?.personalId)}</span>
                )}
                <span className="flex shrink-0 items-center gap-2">
                  {fresh.has(e.id) && (
                    <span aria-hidden className="rounded bg-sky-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-sky-800" data-testid="activity-new">
                      New
                    </span>
                  )}
                  <time dateTime={e.createdAt} className="text-xs text-slate-500">
                    {formatDate(e.createdAt)}
                  </time>
                </span>
              </li>
            ))}
          </ol>
        )}
        {events && canShowMoreActivity(events.length, shownLimit) && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              loading={activity.loading}
              aria-describedby="activity-shown"
              onClick={() => {
                setMore({ filters: filterQuery, limit: nextActivityLimit(shownLimit) });
                setFiltered(true);
              }}
            >
              Show more
            </Button>
            <span id="activity-shown" className="text-xs text-slate-500">
              Showing the newest {events.length}.
            </span>
          </div>
        )}
      </Card>
    </>
  );
}
