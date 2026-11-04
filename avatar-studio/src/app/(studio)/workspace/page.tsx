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
import { EXPIRED_INVITE_DAYS, MEMBER_SORT_KEY, PEOPLE_SEARCH_FROM, bulkInviteSummary, memberSortFrom, shownMemberSort, steadyMembers, type MemberOrder, type MemberSort, peopleMatchLine, personMatches, seatLine, seatsLeft, splitEmails, type BulkInviteAnswer, type Seats } from "@/lib/invite-text";
import { roleArticle } from "@/lib/roles";
import type { ActivityEvent, WorkspaceRole } from "@/lib/types";

interface View {
  id: string;
  name: string;
  role: WorkspaceRole | null;
  members: Array<{ userId: string; email?: string; role: WorkspaceRole; joinedAt: string; you: boolean }>;
  invites: Array<{ token: string; email?: string; role: WorkspaceRole; expiresAt: string }>;
  /** Invites that lapsed in the last 30 days, for owners to send again or dismiss. */
  expiredInvites?: Array<{ token: string; email?: string; role: WorkspaceRole; expiresAt: string }>;
  /** Members and pending invites against the workspace's limit. */
  seats?: Seats;
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
  // The invite last resent or renewed, and what the status line says about it (cleared first so a repeat is heard again).
  const [resent, setResent] = useState<{ token: string; text: string } | null>(null);
  const [inviteStatus, setInviteStatus] = useState("");
  // Seats left for invites (members and pending invites against the limit); only owners get the count.
  const left = ws?.seats ? seatsLeft(ws.seats) : Infinity;
  const full = left === 0;
  // Say so when the workspace fills or frees a seat, after whatever the last action said.
  const wasFull = useRef<boolean | null>(null);
  useEffect(() => {
    if (!ws?.seats) return;
    if (wasFull.current !== null && wasFull.current !== full) {
      const said = full ? "The workspace is now full." : "A seat is free again.";
      setInviteStatus((s) => (s ? `${s} ${said}` : said));
    }
    wasFull.current = full;
  }, [full, ws?.seats]);
  // What the last batch of invites did, and which pending invite's link was just copied.
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  // What is typed into Find, over members and invites (the box shows once the workspace has PEOPLE_SEARCH_FROM of them).
  const [findText, setFindText] = useState("");
  // How the member list is ordered; remembered by this browser (read after mounting, so the server render keeps the default).
  const [memberSort, setMemberSort] = useState<MemberSort>("role");
  // The order the member list was last drawn in, kept while only a member's details change (see steadyMembers).
  const memberOrder = useRef<MemberOrder | null>(null);
  useEffect(() => {
    try {
      setMemberSort(memberSortFrom(window.localStorage.getItem(MEMBER_SORT_KEY)));
    } catch {
      // Storage blocked (a private window, say): the default order it is.
    }
  }, []);
  function chooseMemberSort(next: MemberSort) {
    setMemberSort(next);
    try {
      window.localStorage.setItem(MEMBER_SORT_KEY, next);
    } catch {
      // Not remembered, but the order still holds for this visit.
    }
  }
  const findBox = useRef<HTMLInputElement>(null);
  // A pending invite's role while its change is being saved, by token.
  const [pendingRole, setPendingRole] = useState<Record<string, WorkspaceRole>>({});
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
    // aria-disabled rather than disabled when full, so the button that took the last seat keeps the focus.
    if (!ws || full) return;
    const emails = splitEmails(email);
    setBatchNote(null);
    if (emails.length > 1) {
      // Several addresses: one invite each; their links are on the Pending invites list.
      setInviteStatus("");
      await run(async () => {
        const res = await api<BulkInviteAnswer>(`/api/workspaces/${ws.id}/invites`, { method: "POST", body: JSON.stringify({ emails, role }) });
        const note = bulkInviteSummary(res);
        setLink(null);
        setBatchNote(note);
        setInviteStatus(note);
        setEmail("");
        // The new invites are on Pending invites, which a search could hide.
        setFindText("");
      });
      return;
    }
    await run(async () => {
      const res = await api<{ url: string; emailed: boolean; emailError?: string }>(`/api/workspaces/${ws.id}/invites`, { method: "POST", body: JSON.stringify({ email: emails[0], role }) });
      setLink(res.url);
      setMailNote(res.emailed ? `Invite emailed to ${emails[0]}.` : res.emailError ? `Email failed (${res.emailError}); share the link instead.` : emails[0] ? "Email sending is not configured; share the link." : null);
      setEmail("");
      setFindText("");
    });
  }

  /** Resends a pending invite: a fresh 7-day expiry on the same link, and the email again when it names an address. */
  async function resend(i: { token: string; email?: string }) {
    // aria-disabled rather than disabled while busy, so the focused button keeps the focus.
    if (!ws || busy) return;
    setInviteStatus("");
    setBatchNote(null);
    await run(async () => {
      const res = await api<{ url: string; emailed: boolean; emailError?: string; invite: { expiresAt: string } }>(`/api/workspaces/${ws.id}/invites/${i.token}`, { method: "POST" });
      const until = `The link now expires ${formatDate(res.invite.expiresAt)}.`;
      setLink(res.url);
      setCopied(false);
      const note = res.emailed
        ? `Invite emailed to ${i.email} again. ${until}`
        : res.emailError
          ? `Email failed (${res.emailError}); share the link instead. ${until}`
          : i.email
            ? `Email sending is not configured; share the link. ${until}`
            : `Link renewed. ${until}`;
      setMailNote(note);
      setResent({ token: i.token, text: res.emailed ? "Sent again" : "Renewed" });
      setInviteStatus(note);
    });
  }

  /** Changes the role a pending invite will grant; its link, address, and expiry stay, and nothing is emailed. */
  async function changeInviteRole(i: { token: string; email?: string; role: WorkspaceRole }, next: WorkspaceRole) {
    // aria-disabled rather than disabled while busy, so the select keeps the focus; the value stays as it was.
    if (!ws || busy || next === i.role) return;
    setInviteStatus("");
    setBatchNote(null);
    // Shown while it saves, so the select does not snap back to the old role until the list reloads.
    setPendingRole((p) => ({ ...p, [i.token]: next }));
    await run(async () => {
      await api(`/api/workspaces/${ws.id}/invites/${i.token}`, { method: "PATCH", body: JSON.stringify({ role: next }) });
      setInviteStatus(i.email ? `${i.email} will join as ${roleArticle(next)}.` : `The link invite now joins people as ${roleArticle(next)}.`);
    });
    // Saved (and reloaded) or refused: either way the row shows the stored role again.
    setPendingRole(({ [i.token]: _done, ...rest }) => rest);
  }

  /** Sends an expired invite again: a new link with the same address and role, and the email when it names one. */
  async function inviteAgain(i: { token: string; email?: string; role: WorkspaceRole }) {
    if (!ws || busy || full) return;
    setInviteStatus("");
    setBatchNote(null);
    await run(async () => {
      const res = await api<{ url: string; emailed: boolean; emailError?: string; invite: { token: string; expiresAt: string } }>(`/api/workspaces/${ws.id}/invites/${i.token}/again`, { method: "POST" });
      const until = `The new link expires ${formatDate(res.invite.expiresAt)}.`;
      const note = res.emailed
        ? `Invited ${i.email} again. ${until}`
        : res.emailError
          ? `Email failed (${res.emailError}); share the new link instead. ${until}`
          : i.email
            ? `Invited ${i.email} again; email sending is not configured, so share the new link. ${until}`
            : `New ${i.role} link made. ${until}`;
      setLink(res.url);
      setCopied(false);
      setMailNote(note);
      setResent({ token: res.invite.token, text: res.emailed ? "Sent again" : "New link" });
      setInviteStatus(note);
    });
    // The row is gone; the new link's Copy button is where the focus goes next.
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="invite-link"] button')?.focus());
  }

  /** Takes an expired invite off the list, says so, and moves the focus to the next one (or the invite button). */
  async function dismissExpired(i: { token: string; email?: string; role: WorkspaceRole }, next?: string) {
    if (!ws || busy) return;
    setInviteStatus("");
    await run(async () => {
      await api(`/api/workspaces/${ws.id}/invites/${i.token}`, { method: "DELETE" });
      setInviteStatus(`Expired invite ${i.email ? `to ${i.email}` : `(${i.role} link)`} dismissed`);
    });
    requestAnimationFrame(() => {
      const target = (next && document.querySelector<HTMLButtonElement>(`[data-again="${next}"]`)) || document.querySelector<HTMLButtonElement>('[data-testid="create-invite"]');
      target?.focus();
    });
  }

  /** Copies a pending invite's link (the same one the invite email carries). */
  async function copyInvite(token: string, said: string) {
    const url = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setInviteStatus("");
      setTimeout(() => setInviteStatus(said), 0);
      setTimeout(() => setCopiedToken((t) => (t === token ? null : t)), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
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
  const pasted = splitEmails(email);
  // Repeats are skipped by the server, so they take no seat.
  const pastedUnique = new Set(pasted.map((e) => e.toLowerCase())).size;
  // Find: each list as filtered by what is typed; the box shows once there are enough people to look through.
  const expiredAll = ws.expiredInvites ?? [];
  // Kept while something is typed, so the box never vanishes under a search (or comes back holding an old one).
  const searchable = ws.members.length + ws.invites.length + expiredAll.length >= PEOPLE_SEARCH_FROM || findText !== "";
  const finding = searchable && findText.trim() !== "";
  // "Last active" needs the times; until they arrive (or if they could not be read) the list is drawn owners first.
  const memberSortShown = shownMemberSort(memberSort, !!lastActive.data);
  const steady = steadyMembers(memberOrder.current, ws.members, memberSortShown, lastActive.data?.lastActive);
  memberOrder.current = steady.order;
  const shownMembers = finding ? steady.members.filter((m) => personMatches(findText, m.email ?? m.userId)) : steady.members;
  const shownInvites = finding ? ws.invites.filter((i) => personMatches(findText, i.email ?? "Link invite")) : ws.invites;
  const shownExpired = finding ? expiredAll.filter((i) => personMatches(findText, i.email ?? "Link invite")) : expiredAll;
  const noneFound = <T,>(shown: T[], what: string) =>
    finding && shown.length === 0 ? <p className="py-2 text-xs text-slate-500">No {what} matches “{findText.trim()}”.</p> : null;

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
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {ws.members.length > 1 ? (
          <select
            aria-label="Sort members"
            value={memberSortShown}
            onChange={(e) => chooseMemberSort(memberSortFrom(e.target.value))}
            data-testid="member-sort"
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700"
          >
            <option value="role">Owners first</option>
            <option value="name">Name A–Z</option>
            <option value="active" disabled={!lastActive.data} title={lastActive.data ? undefined : lastActive.error ? "Could not read when members were last active" : "Reading when members were last active…"}>
              Last active
            </option>
            <option value="joined">Newest joined</option>
          </select>
        ) : (
          <span />
        )}
        {/* Members (and, for owners, invites) as a spreadsheet, for records. */}
        <a
          href={`/api/workspaces/${ws.id}/people`}
          download
          data-testid="people-csv"
          aria-label={isOwner ? "Download CSV of the members and invites" : "Download CSV of the members"}
          className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
        >
          <Download className="h-3.5 w-3.5" aria-hidden /> Download CSV
        </a>
      </div>
      {searchable && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            ref={findBox}
            type="search"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && findText) {
                e.preventDefault();
                setFindText("");
              }
            }}
            placeholder={isOwner ? "Find a member or invite by email" : "Find a member by email"}
            aria-label={isOwner ? "Find a member or invite" : "Find a member"}
            aria-describedby="people-found"
            autoComplete="off"
            spellCheck={false}
            className={`${inputClass} max-w-sm`}
            data-testid="people-search"
          />
          {finding && (
            <button
              type="button"
              onClick={() => {
                // The button goes with the search, so the focus goes back to the box rather than to the page.
                setFindText("");
                findBox.current?.focus();
              }}
              className="text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              Clear
            </button>
          )}
          <p id="people-found" className="sr-only" role="status" data-testid="people-found">
            {finding ? peopleMatchLine({ members: [shownMembers.length, ws.members.length], pending: [shownInvites.length, ws.invites.length], expired: [shownExpired.length, expiredAll.length] }, findText, { invites: isOwner }) : ""}
          </p>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card className="divide-y divide-slate-100">
          {finding && shownMembers.length === 0 && <p className="px-5 py-3 text-sm text-slate-500">No member matches “{findText.trim()}”.</p>}
          {shownMembers.map((m) => (
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
                    // aria-disabled rather than disabled while busy, so the select keeps the focus; the value stays as it was.
                    aria-disabled={busy || undefined}
                    onChange={(e) => {
                      if (busy) return;
                      const role = e.target.value;
                      void run(async () => { await api(`/api/workspaces/${ws.id}/members/${m.userId}`, { method: "PATCH", body: JSON.stringify({ role }) }); });
                    }}
                    className={`${inputClass} w-auto py-1 text-xs aria-disabled:cursor-wait aria-disabled:opacity-60`}
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
              {/* Mounted with the card, so what an invite, resend, or copy did is announced even when the
                  Pending invites list only appears with the answer. */}
              <p className="sr-only" role="status" data-testid="invite-status">
                {inviteStatus}
              </p>
              <p className="mt-1 text-xs text-slate-500">Creates a link that joins this workspace. Anyone with the link can use it, so send it privately. Links expire after 7 days.</p>
              {ws.seats && (
                <p className={`mt-2 text-xs ${left <= 5 ? "font-medium text-amber-800" : "text-slate-600"}`} id="seats-line" data-testid="seats">
                  {seatLine(ws.seats)}{" "}
                  {full
                    ? "The workspace is full: remove a member or revoke a pending invite to invite someone."
                    : left <= 5
                      ? `Room for ${left} more.`
                      : null}
                </p>
              )}
              <div className="mt-3 space-y-3">
                <Field
                  label="Email addresses (optional)"
                  hint={`Sent automatically when EMAIL_PROVIDER is configured; otherwise kept for your records. Paste up to 20, separated by commas or new lines, to invite each with their own link.`}
                >
                  <textarea
                    rows={2}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="teammate@example.com"
                    autoComplete="off"
                    inputMode="email"
                    spellCheck={false}
                    className={`${inputClass} resize-y`}
                  />
                </Field>
                <Field label="Role">
                  <select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} className={inputClass}>
                    <option value="editor">Editor: create and manage videos</option>
                    <option value="viewer">Viewer: watch and comment only</option>
                    <option value="owner">Owner: also manage members</option>
                  </select>
                </Field>
                <Button onClick={invite} loading={busy} data-testid="create-invite" aria-disabled={full || undefined} aria-describedby={[ws.seats && "seats-line", !full && pastedUnique > left && "seats-note"].filter(Boolean).join(" ") || undefined}>
                  <Link2 className="h-4 w-4" /> {pasted.length > 1 ? `Invite ${pasted.length} people` : "Create invite link"}
                </Button>
                {!full && pastedUnique > left && (
                  <p id="seats-note" className="text-xs text-amber-800" data-testid="seats-over">
                    That is {pastedUnique} addresses and there is room for {left} more; addresses that are members or already invited do not count.
                  </p>
                )}
                {batchNote && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-900" data-testid="invite-batch">
                    {batchNote}
                  </div>
                )}
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
                {noneFound(shownInvites, "pending invite")}
                <ul hidden={shownInvites.length === 0} className="mt-2 divide-y divide-slate-100 text-xs">
                  {shownInvites.map((i) => (
                    <li key={i.token} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-2">
                      {/* Only the address truncates: the select sits outside it, so a long address never clips it. */}
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 text-slate-700">
                        <span className="min-w-0 max-w-full truncate">{i.email ?? "Link invite"}</span>
                        <span aria-hidden="true">·</span>
                        <select
                          aria-label={`Role for the invite ${i.email ? `to ${i.email}` : "link"}, expiring ${formatDate(i.expiresAt)}`}
                          title="The role this invite gives when it is accepted"
                          value={pendingRole[i.token] ?? i.role}
                          aria-disabled={busy || undefined}
                          onChange={(e) => changeInviteRole(i, e.target.value as WorkspaceRole)}
                          data-testid="invite-role"
                          className="shrink-0 rounded border border-slate-200 bg-white px-1 py-0.5 text-xs text-slate-700 aria-disabled:cursor-wait aria-disabled:opacity-60"
                        >
                          <option value="editor">editor</option>
                          <option value="viewer">viewer</option>
                          <option value="owner">owner</option>
                        </select>
                        <span className="whitespace-nowrap">
                          · expires {formatDate(i.expiresAt)}
                          {resent?.token === i.token && (
                            <span className="ml-1 font-medium text-emerald-700" data-testid="invite-resent">
                              · {resent.text}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <button
                          type="button"
                          onClick={() => copyInvite(i.token, i.email ? `Invite link for ${i.email} copied` : `${i.role[0].toUpperCase()}${i.role.slice(1)} invite link copied`)}
                          aria-label={`Copy the invite link for ${i.email ?? `the ${i.role} link invite`}, expiring ${formatDate(i.expiresAt)}`}
                          className="text-slate-500 hover:text-indigo-700"
                        >
                          {copiedToken === i.token ? "Copied" : "Copy link"}
                        </button>
                        <button
                          type="button"
                          aria-disabled={busy}
                          onClick={() => resend(i)}
                          aria-label={`${i.email ? `Resend the invite to ${i.email}` : `Renew the ${i.role} link invite`}, expiring ${formatDate(i.expiresAt)}`}
                          title={i.email ? "Email it again, with a fresh 7-day expiry" : "A fresh 7-day expiry for the same link"}
                          className="text-slate-500 hover:text-indigo-700 aria-disabled:cursor-wait aria-disabled:opacity-60"
                        >
                          {i.email ? "Resend" : "Renew"}
                        </button>
                        <button type="button" disabled={busy} onClick={() => run(async () => { await api(`/api/workspaces/${ws.id}/invites/${i.token}`, { method: "DELETE" }); })} className="text-slate-500 hover:text-rose-700">
                          Revoke
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {(ws.expiredInvites?.length ?? 0) > 0 && (
              <Card className="p-5" data-testid="expired-invites">
                <h3 className="text-sm font-semibold text-slate-900">Expired invites</h3>
                <p className="mt-1 text-xs text-slate-500">Links that lapsed in the last {EXPIRED_INVITE_DAYS} days. Invite again sends a new link; the old one stays dead.</p>
                {noneFound(shownExpired, "expired invite")}
                <ul hidden={shownExpired.length === 0} className="mt-2 divide-y divide-slate-100 text-xs">
                  {shownExpired.map((i, n, all) => (
                    <li key={i.token} className="flex items-center justify-between gap-2 py-2">
                      <span className="truncate text-slate-500">
                        {i.email ?? "Link invite"} · {i.role} · expired {formatDate(i.expiresAt)}
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <button
                          type="button"
                          aria-disabled={busy || full}
                          data-again={i.token}
                          title={full ? "The workspace is full" : undefined}
                          onClick={() => inviteAgain(i)}
                          aria-label={`Invite again: ${i.email ?? `${i.role} link invite`}, expired ${formatDate(i.expiresAt)}`}
                          className="text-slate-500 hover:text-indigo-700 aria-disabled:cursor-wait aria-disabled:opacity-60"
                        >
                          Invite again
                        </button>
                        <button
                          type="button"
                          aria-disabled={busy}
                          onClick={() => dismissExpired(i, (all[n + 1] ?? all[n - 1])?.token)}
                          aria-label={`Dismiss the expired invite ${i.email ? `to ${i.email}` : `(${i.role} link)`}, expired ${formatDate(i.expiresAt)}`}
                          className="text-slate-500 hover:text-rose-700 aria-disabled:cursor-wait aria-disabled:opacity-60"
                        >
                          Dismiss
                        </button>
                      </span>
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
          What the team did here: videos made, trashed, restored, and deleted for good, batches, reviews and approvals, members and invites, keys, the brand kit, shared presenters, and presenters or voices replaced. The last 200 events are kept.
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
