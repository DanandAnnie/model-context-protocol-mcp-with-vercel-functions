"use client";
import { useEffect, useState } from "react";
import { Check, Code2, Copy, Link2, MessagesSquare, Trash2 } from "lucide-react";
import { AvatarGrid } from "@/components/AvatarPicker";
import { ChatPanel, type ChatTurn } from "@/components/ChatPanel";
import { Button, Card, ErrorBanner, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { useLiveAvatar } from "@/hooks/useLiveAvatar";
import { api, formatDate } from "@/lib/client";
import type { Agent, Avatar, Conversation, ProviderStatus, Voice } from "@/lib/types";

const DEFAULT_INSTRUCTIONS = "You represent a real estate team. Help visitors with open houses, listings, and how to book a showing. Be warm and concise.";

/**
 * Interactive avatar: converse with a presenter here, then save it as a shareable agent that
 * visitors can talk to at /talk/:id without signing in. Replies come from the script provider;
 * the browser speaks them. A streaming renderer can replace the portrait behind /api/chat and /api/talk.
 */
export default function InteractivePage() {
  const canEdit = useCanEdit();
  const { data: avatarData, loading: avatarsLoading } = useApi<{ avatars: Avatar[] }>("/api/avatars");
  const { data: voiceData } = useApi<{ voices: Voice[] }>("/api/voices");
  const { data: status } = useApi<ProviderStatus>("/api/status");
  const { data: agentData, refetch: refetchAgents } = useApi<{ agents: Agent[]; shareOrigin?: string }>("/api/agents");
  // Public links use the server's public origin (APP_URL when set), not whichever host this tab is on.
  const linkOrigin = () => agentData?.shareOrigin || window.location.origin;
  const [avatar, setAvatar] = useState<Avatar | null>(null);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [language, setLanguage] = useState("English");
  const [agentName, setAgentName] = useState("");
  const [collectEmail, setCollectEmail] = useState(false);
  const [knowledgeUrl, setKnowledgeUrl] = useState("");
  const [greeting, setGreeting] = useState("");
  const [starters, setStarters] = useState("");
  const starterList = starters.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedLink, setSavedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [transcriptsFor, setTranscriptsFor] = useState<Agent | null>(null);
  const [transcripts, setTranscripts] = useState<Conversation[] | null>(null);

  async function openTranscripts(agent: Agent) {
    setTranscriptsFor(agent);
    setTranscripts(null);
    setSaveErr(null);
    try {
      const { conversations } = await api<{ conversations: Conversation[] }>(`/api/agents/${agent.id}/conversations`);
      setTranscripts(conversations);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not load transcripts");
      setTranscriptsFor(null);
    }
  }

  async function clearTranscripts(agent: Agent) {
    if (!window.confirm("Delete all saved conversations for this presenter?")) return;
    try {
      await api(`/api/agents/${agent.id}/conversations`, { method: "DELETE" });
      setTranscripts([]);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not delete transcripts");
    }
  }

  useEffect(() => {
    if (!avatar && avatarData?.avatars.length) setAvatar(avatarData.avatars[0]);
  }, [avatarData, avatar]);
  useEffect(() => {
    if (!voice && voiceData?.voices.length) setVoice(voiceData.voices[0]);
  }, [voiceData, voice]);

  const live = useLiveAvatar({
    enabled: !!avatar && status?.streaming !== "mock" && status !== null,
    openPath: "/api/live",
    openBody: { avatarId: avatar?.id, voiceId: voice?.id },
    sessionPath: (id) => `/api/live/${id}`,
    key: `${avatar?.id}:${voice?.id}`,
  });

  async function ask(messages: ChatTurn[]) {
    if (!avatar) throw new Error("Pick a presenter first");
    const { reply } = await api<{ reply: string }>("/api/chat", { method: "POST", body: JSON.stringify({ avatarId: avatar.id, instructions, language, messages }) });
    return reply;
  }

  async function saveAgent() {
    if (!avatar) return;
    const tooLong = starterList.find((s) => s.length > 80);
    if (tooLong) {
      setSaveErr(`Each suggested question is at most 80 characters ("${tooLong.slice(0, 30)}…" is ${tooLong.length})`);
      return;
    }
    setSaving(true);
    setSaveErr(null);
    try {
      const { agent } = await api<{ agent: Agent }>("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: agentName.trim() || avatar.name, avatarId: avatar.id, voiceId: voice?.id, instructions, language, isPublic: true, collectEmail, ...(greeting.trim() ? { greeting: greeting.trim() } : {}), ...(starterList.length ? { starters: starterList } : {}), ...(knowledgeUrl.trim() ? { knowledgeUrl: knowledgeUrl.trim() } : {}) }),
      });
      setSavedLink(`${linkOrigin()}/talk/${agent.id}`);
      setAgentName("");
      setKnowledgeUrl("");
      setGreeting("");
      setStarters("");
      await refetchAgents();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not save the presenter");
    } finally {
      setSaving(false);
    }
  }

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      window.prompt("Copy this link", text);
    }
  }

  async function remove(agent: Agent) {
    if (!window.confirm(`Delete "${agent.name}"? Its public link stops working.`)) return;
    setSaveErr(null);
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      if (savedLink?.endsWith(agent.id)) setSavedLink(null);
      await refetchAgents();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not delete the presenter");
    }
  }

  async function patchAgent(agent: Agent, patch: Partial<Pick<Agent, "isPublic" | "collectEmail">>) {
    setSaveErr(null);
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refetchAgents();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not update the presenter");
    }
  }

  return (
    <>
      <SectionTitle
        title="Interactive avatar"
        subtitle="Talk to a presenter in real time, then share it: visitors get a public page where it answers in character."
      />
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
        {status?.script === "mock"
          ? "Demo: replies are scripted. Set SCRIPT_PROVIDER=anthropic for real conversations."
          : "Live: replies are generated by the configured AI model. Keep instructions specific for the best answers."}
        {status && status.streaming === "mock" && " Live video needs AVATAR_PROVIDER=heygen; until then the portrait animates and the browser speaks."}
      </div>
      {avatar ? (
        <ChatPanel
          name={avatar.name}
          imageUrl={avatar.imageUrl}
          voiceLanguage={voice?.language}
          ask={ask}
          live={live}
          emptyHint="Say hello, or ask about an open house, pricing, or how to book a showing."
          aside={
            <select aria-label="Voice" value={voice?.id ?? ""} onChange={(e) => setVoice(voiceData?.voices.find((v) => v.id === e.target.value) ?? null)} className={`${inputClass} py-1 text-xs`}>
              {voiceData?.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.language ? ` · ${v.language}` : ""}
                </option>
              ))}
            </select>
          }
        />
      ) : (
        <Skeleton className="h-[480px]" />
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">Presenter setup</h3>
          <div className="mt-3">
            <Field label="Who answers">
              {avatarsLoading ? <Skeleton className="h-24" /> : <AvatarGrid avatars={avatarData?.avatars.slice(0, 6) ?? []} selectedId={avatar?.id} onSelect={setAvatar} compact />}
            </Field>
          </div>
          <div className="mt-4 space-y-3">
            <Field label="Instructions" hint="What the presenter knows and how it should behave. Visitors never see this text.">
              <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} maxLength={2000} className={inputClass} />
            </Field>
            <Field label="Opening line (optional)" hint="Shown as the presenter's first message on the talk page, before the visitor types.">
              <input aria-label="Opening line" value={greeting} onChange={(e) => setGreeting(e.target.value)} placeholder="Hi, I'm here to help with open houses and showings. What are you looking for?" className={inputClass} maxLength={200} />
            </Field>
            <Field label="Suggested questions (optional)" hint="Up to three, one per line and 80 characters each, offered as chips until the visitor's first message.">
              <textarea aria-label="Suggested questions" value={starters} onChange={(e) => setStarters(e.target.value)} rows={3} placeholder={"What are your hours?\nHow do I book a showing?"} className={inputClass} maxLength={300} />
            </Field>
            <Field label="Reply language">
              <input value={language} onChange={(e) => setLanguage(e.target.value)} className={inputClass} maxLength={40} />
            </Field>
            <Field label="Knowledge page (optional)" hint="A public web page read once when the presenter is saved; its text becomes reference material for replies and is never shown to visitors.">
              <input aria-label="Knowledge page URL" value={knowledgeUrl} onChange={(e) => setKnowledgeUrl(e.target.value)} placeholder="https://…/about-us" className={inputClass} maxLength={2000} type="url" />
            </Field>
          </div>
          <div className="mt-4 border-t border-slate-100 pt-4">
            {canEdit === false && <ViewOnlyNotice what="save or change agents" />}
            <ErrorBanner message={saveErr} />
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Share as" hint="Name shown to visitors.">
                <input aria-label="Agent name" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder={avatar?.name ?? "Presenter"} maxLength={60} className={`${inputClass} w-56`} />
              </Field>
              <Button onClick={saveAgent} loading={saving} disabled={!avatar || canEdit === false}>
                <Link2 className="h-4 w-4" /> Save and get link
              </Button>
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={collectEmail} onChange={(e) => setCollectEmail(e.target.checked)} className="h-4 w-4 accent-brand-600" />
              Ask visitors for an email after the first reply (sent to your webhook as <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">lead.captured</code>)
            </label>
            {savedLink && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" data-testid="agent-link">
                <code className="break-all">{savedLink}</code>
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => copy(savedLink, "new")}>
                  {copied === "new" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} {copied === "new" ? "Copied" : "Copy"}
                </Button>
              </div>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">Shared presenters</h3>
          <p className="mt-1 text-xs text-slate-500">Each one has a public page and a one-line website embed (a floating launcher that opens the chat). Turn a link off to pause it without deleting the setup.</p>
          <ul className="mt-3 divide-y divide-slate-100" data-testid="agent-list">
            {agentData?.agents.length === 0 && <li className="py-3 text-xs text-slate-500">Nothing shared yet.</li>}
            {agentData?.agents.map((a) => {
              const url = typeof window === "undefined" ? `/talk/${a.id}` : `${linkOrigin()}/talk/${a.id}`;
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{a.name}</div>
                    <div className="text-xs text-slate-500">
                      {a.conversations} {a.conversations === 1 ? "conversation" : "conversations"} · {a.messages} {a.messages === 1 ? "message" : "messages"} · {a.isPublic ? "link on" : "link off"} · {formatDate(a.createdAt)}
                      {a.knowledgeUrl && <> · knows {(() => { try { return new URL(a.knowledgeUrl).hostname; } catch { return "a page"; } })()}</>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => copy(url, a.id)} aria-label={`Copy link for ${a.name}`}>
                      {copied === a.id ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} Link
                    </Button>
                    <Button
                      variant="secondary"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => copy(`<script src="${linkOrigin()}/embed/agent.js?id=${a.id}" async></script>`, `embed-${a.id}`)}
                      aria-label={`Copy embed code for ${a.name}`}
                      title="Paste before </body> on your site to add a floating chat launcher"
                    >
                      {copied === `embed-${a.id}` ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Code2 className="h-3.5 w-3.5" />} Embed
                    </Button>
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => openTranscripts(a)} aria-label={`Transcripts for ${a.name}`}>
                      <MessagesSquare className="h-3.5 w-3.5" /> Transcripts
                    </Button>
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => patchAgent(a, { isPublic: !a.isPublic })} aria-label={`${a.isPublic ? "Turn off" : "Turn on"} link for ${a.name}`}>
                      {a.isPublic ? "Turn off" : "Turn on"}
                    </Button>
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => patchAgent(a, { collectEmail: !a.collectEmail })} aria-label={`${a.collectEmail ? "Stop collecting" : "Collect"} emails for ${a.name}`} title="Ask visitors for an email after the first reply">
                      {a.collectEmail ? "Emails on" : "Emails off"}
                    </Button>
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => remove(a)} aria-label={`Delete ${a.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {transcriptsFor && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4" data-testid="transcripts">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-900">Conversations with {transcriptsFor.name}</h4>
                <div className="flex gap-2">
                  {transcripts && transcripts.length > 0 && (
                    <a href={`/api/agents/${transcriptsFor.id}/conversations?format=csv`} download className="text-xs text-brand-700 hover:underline" title="Every conversation with its visitor's email, first question, and last reply">
                      Download CSV
                    </a>
                  )}
                  {transcripts && transcripts.length > 0 && (
                    <button type="button" onClick={() => clearTranscripts(transcriptsFor)} className="text-xs text-slate-500 hover:text-rose-700">
                      Delete all
                    </button>
                  )}
                  <button type="button" onClick={() => setTranscriptsFor(null)} className="text-xs text-slate-500 hover:text-slate-900">
                    Close
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-500">Newest first, up to 50 visits; each visit keeps its last 40 messages. Visitors are told conversations may be kept.</p>
              {transcripts === null ? (
                <p className="mt-3 text-xs text-slate-500">Loading…</p>
              ) : transcripts.length === 0 ? (
                <p className="mt-3 text-xs text-slate-500">No conversations yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {transcripts.map((c) => (
                    <li key={c.id}>
                      <details className="rounded-lg border border-slate-200 bg-white">
                        <summary className="cursor-pointer select-none px-3 py-2 text-xs text-slate-700">
                          {formatDate(c.startedAt)} · {c.messages.length} {c.messages.length === 1 ? "message" : "messages"}
                          {c.visitor?.email && <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800">{c.visitor.name ? `${c.visitor.name} · ` : ""}{c.visitor.email}</span>} · <span className="text-slate-500">{c.messages[0]?.content.slice(0, 80)}</span>
                        </summary>
                        <ol className="space-y-1.5 border-t border-slate-100 px-3 py-2 text-xs">
                          {c.messages.map((m, i) => (
                            <li key={i} className={m.role === "user" ? "text-slate-900" : "text-slate-600"}>
                              <span className="mr-1 font-medium">{m.role === "user" ? "Visitor" : transcriptsFor.name}:</span>
                              {m.content}
                            </li>
                          ))}
                        </ol>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
