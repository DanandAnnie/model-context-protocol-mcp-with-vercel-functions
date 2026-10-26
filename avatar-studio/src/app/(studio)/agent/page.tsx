"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FileText, PencilLine, Sparkles, X } from "lucide-react";
import { Button, Card, ErrorBanner, Field, SectionTitle, inputClass } from "@/components/ui";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { api } from "@/lib/client";
import { AGENT_DRAFT_KEY } from "@/lib/agent-draft";
import { documentText } from "@/lib/document-text";
import type { Avatar, Video, Voice } from "@/lib/types";

const LENGTHS = [
  { sec: 30, label: "About 30 seconds" },
  { sec: 60, label: "About 1 minute" },
  { sec: 90, label: "About 90 seconds" },
  { sec: 120, label: "About 2 minutes" },
  { sec: 180, label: "About 3 minutes" },
];
const LANGUAGES = ["English", "Spanish", "French", "German", "Portuguese", "Italian", "Dutch", "Japanese", "Chinese", "Korean", "Hindi", "Arabic"];
const ORIENTATIONS = [
  { value: "auto", label: "Let the agent choose" },
  { value: "landscape", label: "Landscape (16:9)" },
  { value: "portrait", label: "Portrait (9:16)" },
  { value: "square", label: "Square (1:1)" },
] as const;
const EXAMPLES = [
  "A 45-second welcome video for new customers of our dental clinic: what to expect at the first visit, and how to book.",
  "A TikTok explaining three quick tips for staging a home before a showing, upbeat and friendly.",
  "A one-minute product update for our team: the new dashboard ships Monday, what changes, and where to send feedback.",
];

export default function VideoAgentPage() {
  const router = useRouter();
  const canEdit = useCanEdit();
  const { data: avatarData } = useApi<{ avatars: Avatar[] }>("/api/avatars");
  const { data: voiceData } = useApi<{ voices: Voice[] }>("/api/voices");
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  // An attached document, read to its words in the browser; only those are sent.
  const [doc, setDoc] = useState<{ name: string; text: string; truncated: boolean } | null>(null);
  const [reading, setReading] = useState(false);
  const [docErr, setDocErr] = useState<string | null>(null);
  // The focus follows the control that replaces the one pressed: Remove once a file is attached, the file field once
  // removed or refused (it is disabled while a file is read, which drops the focus, so this waits for the read to end).
  const fileInput = useRef<HTMLInputElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current || reading) return;
    moveFocus.current = false;
    (doc ? removeButton.current : fileInput.current)?.focus();
  }, [doc, reading]);
  async function attach(file: File | undefined) {
    if (!file) return;
    setReading(true);
    setDocErr(null);
    try {
      const read = await documentText(file, navigator.language);
      moveFocus.current = true;
      setDoc({ name: file.name.slice(0, 200), ...read });
    } catch (e) {
      moveFocus.current = true;
      setDoc(null);
      setDocErr(e instanceof Error ? e.message : `${file.name} could not be read`);
    } finally {
      setReading(false);
    }
  }
  const [avatarId, setAvatarId] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [orientation, setOrientation] = useState<(typeof ORIENTATIONS)[number]["value"]>("auto");
  const [lengthSec, setLengthSec] = useState(60);
  const [language, setLanguage] = useState("English");
  const [busy, setBusy] = useState<"generate" | "plan" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const urlOk = !url.trim() || /^https?:\/\/\S+$/.test(url.trim());
  const ready = prompt.trim().length >= 3 && urlOk && canEdit !== false && !busy && !reading;

  async function run(mode: "generate" | "plan") {
    setBusy(mode);
    setErr(null);
    const body = { prompt, mode, orientation, lengthSec, language, ...(url.trim() ? { url: url.trim() } : {}), ...(doc ? { document: { name: doc.name, text: doc.text } } : {}), ...(avatarId ? { avatarId } : {}), ...(voiceId ? { voiceId } : {}) };
    try {
      if (mode === "plan") {
        const { draft } = await api<{ draft: unknown }>("/api/video-agent", { method: "POST", body: JSON.stringify(body) });
        // The editor picks the plan up once, like a template; the browser's own unsent draft is left alone until then.
        try {
          window.sessionStorage.setItem(AGENT_DRAFT_KEY, JSON.stringify(draft));
        } catch {
          throw new Error("This browser blocks page storage, so the plan cannot be opened in the editor. Use Generate video instead.");
        }
        router.push("/create?plan=agent");
        return;
      }
      const { video } = await api<{ video: Video }>("/api/video-agent", { method: "POST", body: JSON.stringify(body) });
      router.push(`/videos/${video.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The video agent could not make that video");
      setBusy(null);
    }
  }

  return (
    <>
      <SectionTitle title="Video Agent" subtitle="Describe the video you want. The agent writes the script, splits it into scenes, frames them, and picks a format, with your brand kit applied." />
      {canEdit === false && <ViewOnlyNotice what="make videos" />}
      <ErrorBanner message={err} />
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-5">
          <div className="space-y-4">
            <Field label="What should the video be?" hint="The topic, who it is for, the tone, and anything it must say. Up to 10,000 characters.">
              <textarea
                className={`${inputClass} min-h-40`}
                value={prompt}
                maxLength={10_000}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="A one-minute explainer for first-time buyers on how our pre-approval works…"
              />
            </Field>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Example prompts">
              {EXAMPLES.map((ex, i) => (
                <button key={i} type="button" className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-left text-xs text-slate-600 hover:bg-slate-50" onClick={() => setPrompt(ex)}>
                  {ex.length > 64 ? `${ex.slice(0, 63)}…` : ex}
                </button>
              ))}
            </div>
            <Field label="Reference page (optional)" hint="A public web page the agent reads and writes from, using only its facts.">
              <input className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" />
            </Field>
            {!urlOk && <p className="text-xs text-red-600">Enter a full address starting with http:// or https://</p>}
            {/* Not a Field: a label around the attached file would hand every click on it to the Remove button. */}
            <div>
              <span id="agent-document-label" className="mb-1.5 block text-sm font-medium text-slate-700">
                Document (optional)
              </span>
              {doc ? (
                <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" data-testid="agent-document">
                  <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate">
                    {doc.name} · {doc.text.length.toLocaleString()} characters{doc.truncated ? " (the start of it; the rest was left out)" : ""}
                  </span>
                  <button
                    ref={removeButton}
                    type="button"
                    onClick={() => {
                      moveFocus.current = true;
                      setDoc(null);
                    }}
                    aria-label={`Remove ${doc.name}`}
                    className="rounded p-1 text-slate-500 hover:bg-slate-200"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <input
                  ref={fileInput}
                  type="file"
                  aria-label="Attach a document"
                  aria-describedby={docErr ? "agent-document-error agent-document-hint" : "agent-document-hint"}
                  aria-invalid={docErr ? true : undefined}
                  accept=".pdf,.docx,.pptx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown"
                  disabled={reading || canEdit === false}
                  onChange={(e) => {
                    void attach(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                  className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                />
              )}
              <span id="agent-document-hint" className="mt-1 block text-xs text-slate-500">
                A PDF, Word, PowerPoint, or text file the agent writes from, using only its facts. It is read in your browser; only its name and words are sent.
              </span>
            </div>
            {/* Always present, so screen readers hear each change: reading, then what was attached. */}
            <p className="text-xs text-slate-500" role="status">
              {reading ? "Reading the document…" : doc ? `${doc.name} attached, ${doc.text.length.toLocaleString()} characters.` : ""}
            </p>
            {docErr && (
              <p id="agent-document-error" className="text-xs text-red-600" role="alert">
                {docErr}
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={() => run("generate")} loading={busy === "generate"} disabled={!ready} className="flex-1">
                <Sparkles className="h-4 w-4" /> Generate video
              </Button>
              <Button variant="secondary" onClick={() => run("plan")} loading={busy === "plan"} disabled={!ready} className="flex-1">
                <PencilLine className="h-4 w-4" /> Review in editor first
              </Button>
            </div>
            {busy && (
              <p className="text-sm text-slate-500" role="status">
                {busy === "plan" ? "Planning the scenes…" : "Planning the scenes and starting the render…"}
              </p>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Options</h2>
          <div className="space-y-4">
            <Field label="Presenter">
              <select className={inputClass} value={avatarId} onChange={(e) => setAvatarId(e.target.value)}>
                <option value="">Brand kit default</option>
                {avatarData?.avatars.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Voice">
              <select className={inputClass} value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                <option value="">The presenter&apos;s or brand kit&apos;s voice</option>
                {voiceData?.voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Format">
              <select className={inputClass} value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)}>
                {ORIENTATIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <Field label="Length">
                <select className={inputClass} value={lengthSec} onChange={(e) => setLengthSec(Number(e.target.value))}>
                  {LENGTHS.map((l) => (
                    <option key={l.sec} value={l.sec}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Language">
                <select className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGUAGES.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
