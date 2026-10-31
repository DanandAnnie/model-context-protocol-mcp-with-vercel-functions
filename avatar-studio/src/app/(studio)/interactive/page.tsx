"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Code2, Copy, CopyPlus, Link2, MessagesSquare, Pencil, Trash2 } from "lucide-react";
import { AvatarGrid } from "@/components/AvatarPicker";
import { ChatPanel, type ChatTurn } from "@/components/ChatPanel";
import { Button, Card, ErrorBanner, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { ListSearch, useListSearch } from "@/components/ListSearch";
import { MAX_CONVERSATIONS_PER_AGENT, MAX_TRANSCRIPT_QUERY, conversationTexts } from "@/lib/transcripts";
import { useLiveAvatar } from "@/hooks/useLiveAvatar";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { api, formatDate } from "@/lib/client";
import { MAX_AGENT_NOTES, type Agent, type Avatar, type BrandKit, type Conversation, type ProviderStatus, type Voice } from "@/lib/types";

/** The whole setup form, so a new presenter's draft can be put back after an edit, and an edit compared with what it loaded. */
type FormState = {
  avatar: Avatar | null;
  voice: Voice | null;
  agentName: string;
  instructions: string;
  language: string;
  greeting: string;
  starters: string;
  notes: string;
  knowledgeUrl: string;
  collectEmail: boolean;
  brandStyle: boolean;
};

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
  const [brandStyle, setBrandStyle] = useState(false);
  const [knowledgeUrl, setKnowledgeUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [greeting, setGreeting] = useState("");
  const [starters, setStarters] = useState("");
  const starterList = starters.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // A saved presenter loaded into the form: Save then changes it in place, so its link and embed keep working.
  const [editing, setEditing] = useState<Agent | null>(null);
  const editingRef = useRef<Agent | null>(null);
  editingRef.current = editing;
  // The form as the edit loaded it (what Save compares with), and the new presenter's draft to come back to.
  const loadedForm = useRef<FormState | null>(null);
  const draft = useRef<FormState | null>(null);
  // A presenter or voice the edited one was saved with that is gone from the library: Save waits for a new pick.
  const [missing, setMissing] = useState<{ avatar: string | null; voice: string | null }>({ avatar: null, voice: null });
  const [rereadPage, setRereadPage] = useState(false);
  // The presenter whose row switches the form follows: one flipped on the row while it is edited (and not in the form)
  // shows in the form too, so the form never shows a switch the presenter no longer has.
  const [switchesFor, setSwitchesFor] = useState<string | null>(null);
  const setupHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const [savedLink, setSavedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** The presenter being copied, and what the last copy left to say beside the list. */
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [listNote, setListNote] = useState<{ text: string; error?: true } | null>(null);
  const [transcriptsFor, setTranscriptsFor] = useState<Agent | null>(null);
  const [transcripts, setTranscripts] = useState<Conversation[] | null>(null);
  /** Which opening of the panel a load answers, so a slow load for one presenter never fills another's. */
  const transcriptsLoad = useRef(0);
  const transcriptSearch = useListSearch();
  const [leadsOnly, setLeadsOnly] = useState(false);
  const shownTranscripts = (transcripts ?? []).filter(
    (c) => (!leadsOnly || !!c.visitor?.email) && transcriptSearch.matches(c.id, ...conversationTexts(c)),
  );
  const leadCount = (transcripts ?? []).filter((c) => c.visitor?.email).length;

  async function openTranscripts(agent: Agent) {
    const load = ++transcriptsLoad.current;
    setTranscriptsFor(agent);
    setTranscripts(null);
    transcriptSearch.search("");
    setLeadsOnly(false);
    setSaveErr(null);
    try {
      const { conversations } = await api<{ conversations: Conversation[] }>(`/api/agents/${agent.id}/conversations`);
      if (load === transcriptsLoad.current) setTranscripts(conversations);
    } catch (e) {
      if (load !== transcriptsLoad.current) return;
      setSaveErr(e instanceof Error ? e.message : "Could not load transcripts");
      setTranscriptsFor(null);
    }
  }

  /** Closing the panel (or the presenter going) leaves any load still under way with nothing to fill. */
  function closeTranscripts() {
    transcriptsLoad.current++;
    setTranscriptsFor(null);
  }

  async function clearTranscripts(agent: Agent) {
    if (!window.confirm("Delete all saved conversations for this presenter?")) return;
    const load = transcriptsLoad.current;
    try {
      await api(`/api/agents/${agent.id}/conversations`, { method: "DELETE" });
      if (load === transcriptsLoad.current) setTranscripts([]);
    } catch (e) {
      if (load === transcriptsLoad.current) setSaveErr(e instanceof Error ? e.message : "Could not delete transcripts");
    }
  }

  // Starts from the brand kit's presenter and voice (or the presenter's own voice), else the first in each list.
  const { data: brandData, error: brandError } = useApi<{ brand: BrandKit | null }>("/api/brand");
  const startApplied = useRef(false);
  useEffect(() => {
    if (startApplied.current || !avatarData?.avatars.length || !voiceData?.voices.length || (!brandData && !brandError)) return;
    startApplied.current = true;
    const b = brandData?.brand;
    const a = (b?.defaultAvatarId ? avatarData.avatars.find((x) => x.id === b.defaultAvatarId) : undefined) ?? avatarData.avatars[0];
    const v = [b?.defaultVoiceId, a.defaultVoiceId].map((id) => (id ? voiceData.voices.find((x) => x.id === id) : undefined)).find(Boolean) ?? voiceData.voices[0];
    setAvatar((prev) => prev ?? a);
    setVoice((prev) => prev ?? v);
  }, [avatarData, voiceData, brandData, brandError]);
  /** A presenter picked by hand brings its own voice, when it has one. */
  function pickAvatar(a: Avatar) {
    setAvatar(a);
    setMissing((m) => ({ ...m, avatar: null }));
    // While a saved presenter is edited, its voice is changed only from the voice list, so a new face keeps it.
    if (editingRef.current) return;
    const own = a.defaultVoiceId ? voiceData?.voices.find((v) => v.id === a.defaultVoiceId) : undefined;
    if (own) setVoice(own);
  }

  const live = useLiveAvatar({
    enabled: !!avatar && status?.streaming !== "mock" && status !== null,
    openPath: "/api/live",
    openBody: { avatarId: avatar?.id, voiceId: voice?.id },
    sessionPath: (id) => `/api/live/${id}`,
    key: `${avatar?.id}:${voice?.id}`,
  });

  async function ask(messages: ChatTurn[]) {
    if (!avatar) throw new Error("Pick a presenter first");
    const { reply } = await api<{ reply: string }>("/api/chat", { method: "POST", body: JSON.stringify({ avatarId: avatar.id, instructions, language, messages, ...(notes.trim() ? { notes: notes.trim() } : {}), ...(brandStyle ? { brandStyle } : {}) }) });
    return reply;
  }

  const formState = (): FormState => ({ avatar, voice, agentName, instructions, language, greeting, starters, notes, knowledgeUrl, collectEmail, brandStyle });
  function setForm(f: FormState) {
    setAvatar(f.avatar);
    setVoice(f.voice);
    setAgentName(f.agentName);
    setInstructions(f.instructions);
    setLanguage(f.language);
    setGreeting(f.greeting);
    setStarters(f.starters);
    setNotes(f.notes);
    setKnowledgeUrl(f.knowledgeUrl);
    setCollectEmail(f.collectEmail);
    setBrandStyle(f.brandStyle);
  }
  // A switch flipped on the edited presenter's row is kept by Save (it is not sent unless changed in the form) and shown
  // in the form, unless the form's own value was already changed.
  useEffect(() => {
    if (!switchesFor || editingRef.current?.id !== switchesFor) return;
    const now = agentData?.agents.find((x) => x.id === switchesFor);
    const was = loadedForm.current;
    if (!now || !was) return;
    if (!!now.collectEmail !== was.collectEmail) {
      if (collectEmail === was.collectEmail) setCollectEmail(!!now.collectEmail);
      was.collectEmail = !!now.collectEmail;
    }
    if (!!now.brandStyle !== was.brandStyle) {
      if (brandStyle === was.brandStyle) setBrandStyle(!!now.brandStyle);
      was.brandStyle = !!now.brandStyle;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the presenter's stored switches only
  }, [agentData, switchesFor]);

  /** Empties the fields one presenter has and the next does not share: its name, opening line, questions, notes, and page. */
  function clearOwnFields() {
    setAgentName("");
    setKnowledgeUrl("");
    setNotes("");
    setGreeting("");
    setStarters("");
  }

  /** Loads a saved presenter into the form, to change and save in place; a new presenter's draft is kept to come back to. */
  function startEdit(agent: Agent) {
    setListNote(null);
    if (!editing) draft.current = formState();
    setSaveErr(null);
    setSavedLink(null);
    const own = avatarData?.avatars.find((a) => a.id === agent.avatarId) ?? null;
    // A saved voice that is gone is not stood in for by whatever the form showed, and one saved without a voice shows none.
    const spoken = agent.voiceId ? (voiceData?.voices.find((v) => v.id === agent.voiceId) ?? null) : null;
    const loaded: FormState = {
      avatar: own ?? avatar,
      voice: spoken,
      agentName: agent.name,
      instructions: agent.instructions,
      language: agent.language,
      greeting: agent.greeting ?? "",
      starters: (agent.starters ?? []).join("\n"),
      notes: agent.notes ?? "",
      knowledgeUrl: agent.knowledgeUrl ?? "",
      collectEmail: !!agent.collectEmail,
      brandStyle: !!agent.brandStyle,
    };
    setForm(loaded);
    loadedForm.current = loaded;
    setMissing({ avatar: own ? null : agent.avatarName, voice: agent.voiceId && !spoken ? agent.voiceId : null });
    setSwitchesFor(agent.id);
    setRereadPage(false);
    setEditing(agent);
    // The form is above the list; its heading names what is being edited, so focus goes there once it says so.
    focusAfterRender(() => {
      // At once, not smoothly: a click on the form while it still glided would land on whatever had moved under it.
      setupHeading.current?.scrollIntoView?.({ block: "start" });
      return setupHeading.current;
    });
  }

  /** Back to the new presenter's draft as it was before the edit. */
  function leaveEdit() {
    setEditing(null);
    setMissing({ avatar: null, voice: null });
    loadedForm.current = null;
    // A draft taken before the start presenter and voice were chosen keeps the ones the form has now.
    if (draft.current) setForm({ ...draft.current, avatar: draft.current.avatar ?? avatar, voice: draft.current.voice ?? voice });
    else clearOwnFields();
    draft.current = null;
    focusAfterRender(() => setupHeading.current);
  }

  function cancelEdit() {
    setSaveErr(null);
    leaveEdit();
  }

  async function saveAgent() {
    if (!avatar) return;
    const tooLong = starterList.find((s) => s.length > 80);
    if (tooLong) {
      setSaveErr(`Each suggested question is at most 80 characters ("${tooLong.slice(0, 30)}…" is ${tooLong.length})`);
      return;
    }
    if (language.trim().length < 2) {
      setSaveErr("Name the reply language (at least 2 characters), for example English.");
      return;
    }
    if (editing && (missing.avatar || missing.voice)) {
      setSaveErr(missing.avatar ? "Pick a presenter from the list before saving." : "Pick a voice before saving.");
      return;
    }
    const name = agentName.trim() || avatar.name.slice(0, 60);
    setSaving(true);
    setSaveErr(null);
    try {
      let agent: Agent;
      if (editing) {
        // Only what was changed in the form is sent, so a switch flipped on the presenter's row meanwhile, or a voice
        // the form never showed, is left as it is; the page is read again only when its address changed or asked for.
        const was = loadedForm.current!;
        const page = knowledgeUrl.trim();
        const patch: Record<string, unknown> = {};
        // Compared with what is saved, so a presenter picked again after its own was deleted is still sent.
        if (avatar.id !== editing.avatarId) patch.avatarId = avatar.id;
        if (voice && voice.id !== editing.voiceId) patch.voiceId = voice.id;
        if (name !== editing.name) patch.name = name;
        if (instructions !== was.instructions) patch.instructions = instructions;
        if (language !== was.language) patch.language = language;
        if (greeting.trim() !== was.greeting) patch.greeting = greeting.trim();
        if (notes.trim() !== was.notes) patch.notes = notes.trim();
        if (starterList.join("\n") !== (editing.starters ?? []).join("\n")) patch.starters = starterList;
        if (collectEmail !== was.collectEmail) patch.collectEmail = collectEmail;
        if (brandStyle !== was.brandStyle) patch.brandStyle = brandStyle;
        if (page !== (editing.knowledgeUrl ?? "")) patch.knowledgeUrl = page || null;
        else if (page && rereadPage) patch.knowledgeUrl = page;
        const editedId = editing.id;
        if (!Object.keys(patch).length) {
          // Nothing changed: no request, the edit just closes.
          setSavedLink(`${linkOrigin()}/talk/${editedId}`);
          leaveEdit();
          return;
        }
        ({ agent } = await api<{ agent: Agent }>(`/api/agents/${editedId}`, { method: "PATCH", body: JSON.stringify(patch) }));
        setSavedLink(`${linkOrigin()}/talk/${agent.id}`);
        // A second Edit while this one saved is left alone; only the edit that was saved is closed.
        if (editingRef.current?.id === editedId) leaveEdit();
      } else {
        ({ agent } = await api<{ agent: Agent }>("/api/agents", {
          method: "POST",
          body: JSON.stringify({ name, avatarId: avatar.id, voiceId: voice?.id, instructions, language, isPublic: true, collectEmail, brandStyle, ...(greeting.trim() ? { greeting: greeting.trim() } : {}), ...(starterList.length ? { starters: starterList } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), ...(knowledgeUrl.trim() ? { knowledgeUrl: knowledgeUrl.trim() } : {}) }),
        }));
        setSavedLink(`${linkOrigin()}/talk/${agent.id}`);
        clearOwnFields();
      }
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
    setListNote(null);
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      if (savedLink?.endsWith(agent.id)) setSavedLink(null);
      if (editingRef.current?.id === agent.id) cancelEdit();
      // Its transcripts went with it; a panel left open would offer a download that no longer exists.
      if (transcriptsFor?.id === agent.id) closeTranscripts();
      await refetchAgents();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not delete the presenter");
    }
  }

  async function duplicate(agent: Agent) {
    setDuplicating(agent.id);
    setListNote(null);
    try {
      const { agent: made } = await api<{ agent: Agent }>(`/api/agents/${agent.id}/duplicate`, { method: "POST" });
      await refetchAgents();
      setListNote({ text: `Saved a copy, "${made.name}", with its link off. Edit it, then turn its link on to share it.` });
    } catch (e) {
      setListNote({ text: e instanceof Error ? e.message : "Could not copy the presenter", error: true });
    } finally {
      setDuplicating(null);
    }
  }

  async function patchAgent(agent: Agent, patch: Partial<Pick<Agent, "isPublic" | "collectEmail" | "brandStyle">>) {
    setSaveErr(null);
    setListNote(null);
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
        {status && status.streaming === "mock" && " Live video needs LiveAvatar (LIVEAVATAR_API_KEY and LIVEAVATAR_AVATAR_ID); until then the portrait animates and the browser speaks."}
      </div>
      {avatar ? (
        <ChatPanel
          // An edit starts the try-it chat afresh, so one conversation does not run across two presenters' setups; the
          // panel is not remounted, so a live video stays attached to it.
          resetKey={editing?.id ?? "new"}
          name={avatar.name}
          imageUrl={avatar.imageUrl}
          voiceLanguage={voice?.language}
          ask={ask}
          live={live}
          emptyHint="Say hello, or ask about an open house, pricing, or how to book a showing."
          aside={
            <select
              aria-label="Voice"
              value={voice?.id ?? ""}
              onChange={(e) => {
                setVoice(voiceData?.voices.find((v) => v.id === e.target.value) ?? null);
                setMissing((m) => ({ ...m, voice: null }));
              }}
              className={`${inputClass} py-1 text-xs`}
            >
              {!voice && <option value="">{editing && !missing.voice ? "No saved voice" : "Pick a voice"}</option>}
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
          <h3 ref={setupHeading} tabIndex={-1} aria-describedby={editing ? `agent-editing${missing.avatar || missing.voice ? " agent-missing" : ""}` : undefined} className="text-sm font-semibold text-slate-900 focus:outline-none">
            {editing ? `Editing ${editing.name}` : "Presenter setup"}
          </h3>
          {editing && (
            <p id="agent-editing" className="mt-1 text-xs text-slate-600" data-testid="agent-editing">
              Saving changes {editing.name} in place: its link, embed code, and transcripts stay as they are, and only what you change here is saved. Cancel editing goes back to the presenter you were setting up.
            </p>
          )}
          {editing && (missing.avatar || missing.voice) && (
            <p id="agent-missing" className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900" data-testid="agent-missing">
              {missing.avatar && `${missing.avatar}, the presenter this one was saved with, is no longer in your library; pick another before saving. `}
              {missing.voice && "The voice this one was saved with is no longer available; pick another above the chat before saving."}
            </p>
          )}
          <div className="mt-3">
            <Field label="Who answers">
              {avatarsLoading ? (
                <Skeleton className="h-24" />
              ) : (
                // Every presenter, own and stock, in a box that scrolls once the list is long.
                <div className="max-h-80 overflow-y-auto pr-1">
                  <AvatarGrid avatars={avatarData?.avatars ?? []} selectedId={avatar?.id} onSelect={pickAvatar} compact />
                </div>
              )}
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
            <Field
              label="Reference notes (optional)"
              hintId="agent-notes-hint"
              hint="Facts the presenter answers from, such as prices, hours, and policies, in your own words. The try-it chat uses them as you type. They are kept off the public page, but the presenter may repeat anything in them to a visitor, so leave out what is not for the public."
            >
              <textarea
                aria-label="Reference notes"
                aria-describedby="agent-notes-hint agent-notes-count"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                maxLength={MAX_AGENT_NOTES}
                placeholder={"Showings run Saturdays, 10am to 2pm.\nWe answer calls within one business day."}
                className={inputClass}
              />
              <span id="agent-notes-count" className={`mt-1 block text-xs ${notes.length >= MAX_AGENT_NOTES ? "font-medium text-rose-700" : "text-slate-500"}`}>
                {notes.length} / {MAX_AGENT_NOTES}
              </span>
            </Field>
            <Field label="Knowledge page (optional)" hint="A public web page read once when the presenter is saved; its text becomes reference material for replies and is never shown to visitors.">
              <input aria-label="Knowledge page URL" value={knowledgeUrl} onChange={(e) => setKnowledgeUrl(e.target.value)} placeholder="https://…/about-us" className={inputClass} maxLength={2000} type="url" />
            </Field>
            {editing && editing.knowledgeUrl && knowledgeUrl.trim() === editing.knowledgeUrl && (
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input type="checkbox" checked={rereadPage} onChange={(e) => setRereadPage(e.target.checked)} className="h-4 w-4 accent-brand-600" />
                Read the page again when saving (it is read once; a changed address is read anyway, and a cleared one forgotten)
              </label>
            )}
          </div>
          <div className="mt-4 border-t border-slate-100 pt-4">
            {canEdit === false && <ViewOnlyNotice what="save or change agents" />}
            <ErrorBanner message={saveErr} />
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Share as" hint="Name shown to visitors.">
                <input aria-label="Agent name" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder={avatar?.name ?? "Presenter"} maxLength={60} className={`${inputClass} w-56`} />
              </Field>
              <Button
                onClick={saveAgent}
                loading={saving}
                disabled={!avatar || canEdit === false || (!!editing && !!(missing.avatar || missing.voice))}
                aria-describedby={editing && (missing.avatar || missing.voice) ? "agent-missing" : undefined}
              >
                {editing ? (
                  <>
                    <Check className="h-4 w-4" /> Save changes
                  </>
                ) : (
                  <>
                    <Link2 className="h-4 w-4" /> Save and get link
                  </>
                )}
              </Button>
              {editing && (
                <Button variant="secondary" onClick={cancelEdit} disabled={saving}>
                  Cancel editing
                </Button>
              )}
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={collectEmail} onChange={(e) => setCollectEmail(e.target.checked)} className="h-4 w-4 accent-brand-600" />
              Ask visitors for an email after the first reply (sent to your webhook as <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">lead.captured</code>)
            </label>
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={brandStyle} onChange={(e) => setBrandStyle(e.target.checked)} aria-describedby="agent-brand-style-hint" className="h-4 w-4 accent-brand-600" />
              Word replies in the brand kit&apos;s writing style
            </label>
            {/* Outside the label, so the hint is read once, as the box's description; said only once the kit is known. */}
            <p id="agent-brand-style-hint" className="ml-6 mt-0.5 text-xs text-slate-500">
              {!brandData
                ? ""
                : brandData.brand?.writingStyle
                  ? status?.script === "mock"
                    ? "The style on the Brand page, as it is at each reply, once Claude writes the replies (the demo writer does not follow it)."
                    : "The style on the Brand page, as it is at each reply; this chat tries it too."
                  : "The brand kit has no writing style yet; add one on the Brand page and replies follow it."}
            </p>
            {savedLink && (
              <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" data-testid="agent-link">
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
          <div role="status" className="empty:hidden">
            {listNote && !listNote.error && <p className="mt-2 text-xs text-emerald-800" data-testid="agent-list-note">{listNote.text}</p>}
          </div>
          {listNote?.error && <div className="mt-2"><ErrorBanner message={listNote.text} /></div>}
          <ul className="mt-3 divide-y divide-slate-100" data-testid="agent-list">
            {agentData?.agents.length === 0 && <li className="py-3 text-xs text-slate-500">Nothing shared yet.</li>}
            {agentData?.agents.map((a) => {
              const url = typeof window === "undefined" ? `/talk/${a.id}` : `${linkOrigin()}/talk/${a.id}`;
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{a.name}</div>
                    <div className="text-xs text-slate-500">
                      {a.conversations} {a.conversations === 1 ? "conversation" : "conversations"} · {a.messages} {a.messages === 1 ? "question" : "questions"} · {a.isPublic ? "link on" : "link off"} · {formatDate(a.createdAt)}
                      {a.notes && <> · has notes</>}
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
                    <Button
                      variant="secondary"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => startEdit(a)}
                      // The form needs the presenters and voices to load the saved ones; a save under way finishes first.
                      disabled={canEdit === false || saving || avatarsLoading || !voiceData}
                      aria-label={`Edit ${a.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button
                      variant="secondary"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => duplicate(a)}
                      disabled={canEdit === false || saving || (duplicating !== null && duplicating !== a.id)}
                      loading={duplicating === a.id}
                      aria-label={`Duplicate ${a.name}`}
                      title="Save a copy of the saved setup with a new link, which starts off"
                    >
                      <CopyPlus className="h-3.5 w-3.5" /> Duplicate
                    </Button>
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => openTranscripts(a)} aria-label={`Transcripts for ${a.name}`}>
                      <MessagesSquare className="h-3.5 w-3.5" /> Transcripts
                    </Button>
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => patchAgent(a, { isPublic: !a.isPublic })} disabled={saving} aria-label={`${a.isPublic ? "Turn off" : "Turn on"} link for ${a.name}`}>
                      {a.isPublic ? "Turn off" : "Turn on"}
                    </Button>
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => patchAgent(a, { collectEmail: !a.collectEmail })} disabled={saving} aria-label={`${a.collectEmail ? "Stop collecting" : "Collect"} emails for ${a.name}`} title="Ask visitors for an email after the first reply">
                      {a.collectEmail ? "Emails on" : "Emails off"}
                    </Button>
                    <Button
                      variant="secondary"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => patchAgent(a, { brandStyle: !a.brandStyle })}
                      disabled={saving}
                      aria-label={`Brand style for ${a.name}`}
                      aria-pressed={!!a.brandStyle}
                      title="Word replies in the brand kit's writing style"
                    >
                      {a.brandStyle ? "Brand style on" : "Brand style off"}
                    </Button>
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => remove(a)} disabled={saving} aria-label={`Delete ${a.name}`}>
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
                    <a
                      href={`/api/agents/${transcriptsFor.id}/conversations?${new URLSearchParams({ format: "csv", ...(transcriptSearch.needle ? { q: transcriptSearch.q.trim() } : {}), ...(leadsOnly ? { leads: "1" } : {}) })}`}
                      download
                      className="text-xs text-brand-700 hover:underline"
                      title={
                        transcriptSearch.needle || leadsOnly
                          ? "The conversations listed below, as the search and box narrow them, with each visitor's email, first question, and last reply"
                          : "Every conversation with its visitor's email, first question, and last reply"
                      }
                    >
                      {transcriptSearch.needle || leadsOnly ? "Download matches (CSV)" : "Download CSV"}
                    </a>
                  )}
                  {transcripts && transcripts.length > 0 && (
                    <button type="button" onClick={() => clearTranscripts(transcriptsFor)} className="text-xs text-slate-500 hover:text-rose-700">
                      Delete all
                    </button>
                  )}
                  <button type="button" onClick={closeTranscripts} className="text-xs text-slate-500 hover:text-slate-900">
                    Close
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-500">Newest first, up to {MAX_CONVERSATIONS_PER_AGENT} visits; each visit keeps its last 40 messages. Visitors are told conversations may be kept.</p>
              {transcripts === null ? (
                <p className="mt-3 text-xs text-slate-500">Loading…</p>
              ) : transcripts.length === 0 ? (
                <p className="mt-3 text-xs text-slate-500">No conversations yet.</p>
              ) : (
                <>
                <div className="mt-3">
                  {/* Counted against what the checkbox leaves, so a visit it hides never reads as a match or a miss. */}
                  <ListSearch
                    search={transcriptSearch}
                    label={`Search conversations with ${transcriptsFor.name}`}
                    placeholder="Search words, emails, or names"
                    shown={shownTranscripts.length}
                    total={leadsOnly ? leadCount : transcripts.length}
                    noun={leadsOnly ? "visits that left an email" : "conversations"}
                    maxLength={MAX_TRANSCRIPT_QUERY}
                  />
                  <label className="mb-3 flex items-center gap-1.5 text-xs text-slate-700">
                    <input type="checkbox" checked={leadsOnly} onChange={(e) => setLeadsOnly(e.target.checked)} disabled={leadCount === 0 && !leadsOnly} />
                    Only visits that left an email ({leadCount})
                  </label>
                </div>
                <ul className="space-y-2" data-testid="transcript-list">
                  {shownTranscripts.map((c) => (
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
                </>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
