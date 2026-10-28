"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { api } from "@/lib/client";
import { MAX_AGENT_MESSAGE, type AgentMessage, type Video } from "@/lib/types";

/** What the go-ahead button says to the agent. */
const GO_AHEAD = "Looks good, go ahead and make the video.";

/**
 * The conversation with HeyGen's Video Agent about a directed video under review: its messages and storyboard frames,
 * asked again every few seconds while the video is being made, and, while the agent waits, an answer to send (feedback,
 * or the go-ahead to render). After the render starts it stays as the record of what was agreed.
 */
export function AgentConversation({ video, canEdit, onAnswered }: { video: Video; canEdit: boolean; onAnswered: () => void }) {
  const id = useId();
  const making = video.status === "processing" || video.status === "queued";
  const [data, setData] = useState<{ waiting: boolean; progress?: number; messages: AgentMessage[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read when each look ends, so asking stops once the video is made.
  const makingNow = useRef(making);
  useEffect(() => {
    makingNow.current = making;
  }, [making]);
  // Asked every few seconds while the agent works, less often while it waits for an answer, not while the tab is
  // hidden, and again after a failed look (a limit, trouble at HeyGen), more slowly each time, rather than given up.
  const lookNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const next = (ms: number) => {
      if (timer) clearTimeout(timer);
      if (!stopped && makingNow.current) timer = setTimeout(look, ms);
    };
    async function look() {
      if (stopped) return;
      if (document.visibilityState === "hidden") return next(4000);
      try {
        const got = await api<{ waiting: boolean; progress?: number; messages: AgentMessage[] }>(`/api/videos/${video.id}/agent`);
        if (stopped) return;
        failures = 0;
        setData(got);
        setError(null);
        next(got.waiting ? 10_000 : 4000);
      } catch (e) {
        if (stopped) return;
        failures++;
        setError(e instanceof Error ? e.message : "The conversation could not be read");
        next(Math.min(4000 * 2 ** failures, 60_000));
      }
    }
    lookNow.current = () => void look();
    void look();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [video.id]);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState<"answer" | "go" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  // After an answer the form goes; the focus moves to the status line once it says what happened (it is hidden while empty).
  const focusNote = useRef(false);
  useEffect(() => {
    if (!note || !focusNote.current) return;
    focusNote.current = false;
    noteRef.current?.focus();
  }, [note]);
  /** Says something in the status line, cleared first so the same words said again are heard again. */
  const say = (text: string) => {
    setNote("");
    requestAnimationFrame(() => setNote(text));
  };
  const waiting = !!data?.waiting && making;
  const messages = data?.messages ?? [];
  // A new message from the agent is announced (by its latest one, as HeyGen keeps only the 40 latest); the first look is
  // not, as it is the page arriving.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const last = [...data.messages].reverse().find((m) => m.from === "agent");
    const key = last ? `${last.at ?? ""}|${last.text}` : "";
    if (seen.current !== null && key !== seen.current && last) say(data.waiting ? "HeyGen's Video Agent answered and is waiting for you." : "HeyGen's Video Agent answered.");
    seen.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function send(text: string, kind: "answer" | "go") {
    setSending(kind);
    setErr(null);
    try {
      await api(`/api/videos/${video.id}/agent`, { method: "POST", body: JSON.stringify({ text }) });
      if (kind === "answer") setAnswer("");
      say(kind === "go" ? "Sent. HeyGen's Video Agent is making the video." : "Sent. HeyGen's Video Agent is working on your answer.");
      onAnswered();
      lookNow.current();
      // The form goes once the agent works on the answer: the focus goes to what was said, not off the page.
      focusNote.current = true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The answer could not be sent");
      if (kind === "answer") box.current?.focus();
    } finally {
      setSending(null);
    }
  }

  return (
    <Card className="p-5" data-testid="agent-conversation">
      <h3 className="text-sm font-semibold text-slate-900">Review with HeyGen&apos;s Video Agent</h3>
      <p className="mt-1 text-xs text-slate-500">
        {making
          ? "The agent drafts a storyboard and waits for you: ask for changes, or tell it to go ahead and make the video."
          : "What you and HeyGen's Video Agent agreed before it made the video."}
      </p>
      <p ref={noteRef} tabIndex={-1} className="mt-2 text-xs text-slate-600 focus:outline-none empty:hidden" role="status">
        {note}
      </p>
      {/* A finished video's conversation may be gone at HeyGen: said plainly, as there is nothing to do about it. */}
      {!making && error ? <p className="mt-3 text-xs text-slate-500">The conversation is no longer available at HeyGen.</p> : <ErrorBanner message={error ?? err} />}
      {messages.length > 0 && (
        <ol className="mt-3 space-y-3" aria-label="Conversation">
          {messages.map((m, i) => (
            <li key={i} className={`min-w-0 rounded-lg p-3 text-sm ${m.from === "you" ? "ml-6 bg-brand-50 text-slate-800" : m.error ? "mr-6 bg-rose-50 text-rose-800" : "mr-6 bg-slate-50 text-slate-800"}`}>
              <span className="block text-xs font-medium text-slate-600">{m.from === "you" ? "You" : "HeyGen's agent"}</span>
              {m.text && <p className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</p>}
              {m.attachments?.map((a, j) => {
                // A picture is shown for a thumbnail, or for an image itself; a link only to an https page (a demo's drawn
                // storyboard is a data URL a browser will not open as a page).
                const picture = a.thumbnailUrl ?? (a.kind === "image" ? a.url : undefined);
                const link = [a.url, a.thumbnailUrl].find((u) => u?.startsWith("https://"));
                const name = a.kind === "image" ? "storyboard" : a.kind;
                const shown = picture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={picture} alt={name === "storyboard" ? "Storyboard" : `The ${name}`} referrerPolicy="no-referrer" className="h-auto w-full" />
                ) : (
                  <span className="block p-2 text-xs font-medium text-brand-700">Open the {name}</span>
                );
                if (!picture && !link) return null;
                return link ? (
                  <a key={j} href={link} target="_blank" rel="noopener noreferrer" className="mt-2 block max-w-xs overflow-hidden rounded border border-slate-200 bg-white" aria-label={`Open the ${name} in a new tab`}>
                    {shown}
                  </a>
                ) : (
                  <div key={j} className="mt-2 max-w-xs overflow-hidden rounded border border-slate-200 bg-white">
                    {shown}
                  </div>
                );
              })}
            </li>
          ))}
        </ol>
      )}
      {making && !waiting && <p className="mt-3 text-xs text-slate-600">{data ? `HeyGen's Video Agent is working${typeof data.progress === "number" ? ` (${data.progress}%)` : ""}…` : "Reading the conversation…"}</p>}
      {waiting && canEdit && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim().length >= 2) void send(answer.trim(), "answer");
          }}
        >
          <label htmlFor={`${id}-answer`} className="block text-sm font-medium text-slate-800">
            Your answer
          </label>
          <textarea
            ref={box}
            id={`${id}-answer`}
            className={`${inputClass} min-h-20`}
            maxLength={MAX_AGENT_MESSAGE}
            value={answer}
            disabled={!!sending}
            placeholder="Ask for changes: another scene, a shorter intro, a warmer tone…"
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="secondary" loading={sending === "answer"} disabled={!!sending || answer.trim().length < 2}>
              Send
            </Button>
            <Button type="button" loading={sending === "go"} disabled={!!sending} onClick={() => void send(GO_AHEAD, "go")}>
              Looks good, make the video
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
