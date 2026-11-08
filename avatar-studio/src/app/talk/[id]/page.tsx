"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { Download, Sparkles } from "lucide-react";
import { ChatPanel, type ChatTurn } from "@/components/ChatPanel";
import { useApi } from "@/hooks/useApi";
import { useLiveAvatar } from "@/hooks/useLiveAvatar";
import { api } from "@/lib/client";
import { Button, inputClass } from "@/components/ui";

interface PublicAgent {
  id: string;
  name: string;
  language: string;
  avatar: { id: string; name: string; imageUrl: string };
  voiceLanguage?: string;
  greeting?: string;
  starters?: string[];
  collectEmail: boolean;
  liveVideo: boolean;
  brand: { name: string; logoUrl?: string; primaryColor: string; accentColor?: string } | null;
}

/** The file name a download was given: the presenter's own name (`filename*`) where it can be read, else the ASCII one. */
function downloadName(disposition: string): string {
  const own = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (own) {
    try {
      return decodeURIComponent(own);
    } catch {
      // Not percent-encoded as it should be: the plain name below.
    }
  }
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? "conversation.txt";
}

/** Public page where visitors talk to a shared presenter. No sign-in; the owner's instructions stay server-side. */
export default function TalkPage() {
  return (
    <Suspense>
      <TalkInner />
    </Suspense>
  );
}

function TalkInner() {
  const { id } = useParams<{ id: string }>();
  const query = useSearchParams();
  const embed = query.get("embed") === "1";
  // Opened by the website launcher on its own: live video waits for the visitor's first question.
  const openedByItself = query.get("auto") === "1";
  const { data, loading, error } = useApi<{ agent: PublicAgent }>(`/api/talk/${id}`);
  const agent = data?.agent;
  const accent = agent?.brand?.accentColor ?? agent?.brand?.primaryColor;

  // One transcript per visit: the first turn returns an id that later turns send back.
  const conversationId = useRef<string | undefined>(undefined);
  const [turns, setTurns] = useState(0);
  // Set once a turn of this visit made it into the transcript, so there is something to download.
  const [recorded, setRecorded] = useState(false);
  const [lead, setLead] = useState<{ email: string; name: string }>({ email: "", name: "" });
  const [leadState, setLeadState] = useState<"idle" | "sending" | "done" | "dismissed">("idle");
  const [leadErr, setLeadErr] = useState<string | null>(null);
  // Bumped by "Start over", so a reply that lands afterwards does not bring the old visit back.
  const visit = useRef(0);
  async function ask(messages: ChatTurn[]) {
    const asked = visit.current;
    const res = await api<{ reply: string; conversationId: string; at?: string }>(`/api/talk/${id}`, { method: "POST", body: JSON.stringify({ messages, conversationId: conversationId.current }) });
    if (asked !== visit.current) return res.reply;
    conversationId.current = res.conversationId;
    setTurns((n) => n + 1);
    if (res.at) setRecorded(true);
    // The reply's time names it in this visit, so the visitor can rate it.
    return { reply: res.reply, ref: res.at ? `${res.conversationId} ${res.at}` : undefined };
  }
  /** Saves a rating on a reply; `ref` is the visit and the reply's time, so a reply from before "Start over" still rates its own visit. */
  async function rate(ref: string, rating: "up" | "down" | null) {
    const [visit, at] = ref.split(" ");
    await api(`/api/talk/${id}/rate`, { method: "POST", body: JSON.stringify({ conversationId: visit, at, rating }) });
  }
  async function sendLead() {
    if (!conversationId.current) return;
    setLeadState("sending");
    setLeadErr(null);
    try {
      await api(`/api/talk/${id}/lead`, { method: "POST", body: JSON.stringify({ conversationId: conversationId.current, email: lead.email, name: lead.name || undefined }) });
      setLeadState("done");
    } catch (e) {
      setLeadErr(e instanceof Error ? e.message : "Could not send");
      setLeadState("idle");
    }
  }
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  /** Downloads this visit's conversation as a text file; the visit's id goes in the body, not the address. */
  async function downloadConversation() {
    if (!conversationId.current) return;
    // A download still under way when the visitor starts over saves nothing and says nothing on the new visit.
    const asked = visit.current;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch(`/api/talk/${id}/transcript`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: conversationId.current }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not download the conversation");
      const blob = await res.blob();
      if (asked !== visit.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName(res.headers.get("Content-Disposition") ?? "");
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (asked === visit.current) setSaveErr(e instanceof Error ? e.message : "Could not download the conversation");
    } finally {
      if (asked === visit.current) setSaving(false);
    }
  }
  const showLead = !!agent?.collectEmail && turns >= 1 && leadState !== "dismissed";
  const live = useLiveAvatar({
    enabled: !!agent?.liveVideo && (!openedByItself || turns > 0),
    openPath: `/api/talk/${id}/live`,
    openBody: {},
    sessionPath: (sid) => `/api/talk/${id}/live/${sid}`,
    key: id,
  });

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      {accent && <div className="h-1.5" style={{ background: accent }} aria-hidden />}
      <header className={`mx-auto flex max-w-5xl items-center justify-between px-6 ${embed ? "py-3" : "py-5"}`}>
        {agent?.brand && (agent.brand.name || agent.brand.logoUrl) ? (
          <div className="flex items-center gap-3 text-sm font-medium text-slate-200" data-testid="talk-brand">
            {agent.brand.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={agent.brand.logoUrl} alt={agent.brand.name ? `${agent.brand.name} logo` : "Logo"} className="h-8 max-w-[140px] object-contain" />
            )}
            {agent.brand.name && <span>{agent.brand.name}</span>}
          </div>
        ) : (
          <Link href="/" className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            Avatar Studio
          </Link>
        )}
      </header>
      <section className={`mx-auto max-w-5xl ${embed ? "px-4 pb-6" : "px-6 pb-16"}`}>
        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : !agent ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center">
            <h1 className="text-lg font-semibold">This presenter is not available</h1>
            {/* A missing or switched-off presenter answers with the heading's own words; other errors (the network) say what went wrong. */}
            <p className="mt-2 text-sm text-slate-400">{error && error !== "This presenter is not available" ? error : "The link may have been turned off or deleted."}</p>
          </div>
        ) : (
          <>
            <h1 className={`mb-1 font-semibold ${embed ? "text-base" : "text-xl"}`} data-testid="talk-name">
              Talk with {agent.name}
            </h1>
            <p className={`text-sm text-slate-400 ${embed ? "mb-3" : "mb-5"}`}>Ask a question and {agent.avatar.name} will answer in {agent.language}. Replies are generated by AI; conversations may be kept by the presenter&apos;s owner.</p>
            <ChatPanel
              name={agent.avatar.name}
              imageUrl={agent.avatar.imageUrl}
              voiceLanguage={agent.voiceLanguage}
              ask={ask}
              rate={rate}
              live={live}
              dark
              compact={embed}
              emptyHint={`Say hello to ${agent.avatar.name}.`}
              opening={agent.greeting}
              starters={agent.starters}
              onReset={() => {
                visit.current += 1;
                conversationId.current = undefined;
                setTurns(0);
                setRecorded(false);
                setLeadState("idle");
                setSaveErr(null);
                setSaving(false);
              }}
            />
            {recorded && (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <button type="button" onClick={downloadConversation} disabled={saving} className="inline-flex items-center gap-1.5 text-slate-300 hover:text-white disabled:opacity-60">
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  {saving ? "Preparing…" : "Download this conversation"}
                </button>
                {saveErr && (
                  <span role="alert" className="text-rose-300">
                    {saveErr}
                  </span>
                )}
              </div>
            )}
            {showLead && (
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4" data-testid="lead-form">
                {leadState === "done" ? (
                  <p className="text-sm text-slate-200">Thanks. {agent.name} will follow up at {lead.email}.</p>
                ) : (
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      sendLead();
                    }}
                  >
                    <div className="w-full text-sm text-slate-200">Want a follow-up? Leave your email and {agent.name} will get back to you.</div>
                    <input aria-label="Your name" value={lead.name} onChange={(e) => setLead({ ...lead, name: e.target.value })} placeholder="Name (optional)" maxLength={80} className={`${inputClass} w-40`} />
                    <input aria-label="Your email" type="email" required value={lead.email} onChange={(e) => setLead({ ...lead, email: e.target.value })} placeholder="you@example.com" maxLength={200} className={`${inputClass} min-w-[200px] flex-1`} />
                    <Button type="submit" loading={leadState === "sending"} disabled={!lead.email.trim()}>
                      Send
                    </Button>
                    <button type="button" onClick={() => setLeadState("dismissed")} className="text-xs text-slate-400 hover:text-slate-200">
                      No thanks
                    </button>
                    {leadErr && <div className="w-full text-xs text-rose-300">{leadErr}</div>}
                  </form>
                )}
              </div>
            )}
            {!embed && agent.brand && (agent.brand.name || agent.brand.logoUrl) && (
              <p className="mt-10 text-xs text-slate-500">
                Made with <Link href="/" className="underline hover:text-slate-300">Avatar Studio</Link>
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
