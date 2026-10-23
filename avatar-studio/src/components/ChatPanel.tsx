"use client";
import { useEffect, useRef, useState } from "react";
import { MessageSquare, Send, Volume2, VolumeX } from "lucide-react";
import { Button, ErrorBanner, inputClass } from "@/components/ui";
import { portraitSvg } from "@/lib/stock";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Portrait plus conversation. Replies are spoken with Web Speech while the portrait animates.
 * `ask` sends the transcript (last 20 turns) and returns the presenter's reply.
 */
export function ChatPanel({
  name,
  imageUrl,
  voiceLanguage,
  ask,
  emptyHint = "Say hello to get started.",
  dark = false,
  compact = false,
  aside,
}: {
  name: string;
  imageUrl: string;
  voiceLanguage?: string;
  ask: (messages: ChatTurn[]) => Promise<string>;
  emptyHint?: string;
  dark?: boolean;
  /** Single column with a small portrait, for the website embed. */
  compact?: boolean;
  /** Extra controls rendered under the portrait (e.g. a voice picker). */
  aside?: React.ReactNode;
}) {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);
  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  function speak(text: string) {
    if (muted || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find((v) => voiceLanguage && v.lang.toLowerCase().startsWith(voiceLanguage.toLowerCase().slice(0, 2)));
    if (match) utter.voice = match;
    utter.onstart = () => setSpeaking(true);
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utter);
  }

  async function send() {
    const content = draft.trim();
    if (!content || busy) return;
    const next: ChatTurn[] = [...messages, { role: "user", content }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    setErr(null);
    try {
      const reply = await ask(next.slice(-20));
      setMessages([...next, { role: "assistant", content: reply }]);
      speak(reply);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The presenter could not answer");
      setMessages(messages);
      setDraft(content);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    setMessages([]);
    setErr(null);
  }

  // Not the shared Card: its bg-white would compete with the dark surface in the stylesheet order.
  const card = `rounded-xl border shadow-sm ${dark ? "border-slate-800 bg-slate-900 text-slate-100" : "border-slate-200 bg-white"}`;
  const bubbleBot = dark ? "bg-slate-800 text-slate-100" : "bg-slate-100 text-slate-900";
  const muted500 = dark ? "text-slate-400" : "text-slate-500";

  return (
    <div className={compact ? "grid gap-3" : "grid gap-6 lg:grid-cols-[320px_1fr]"}>
      <div className={`overflow-hidden ${card}`}>
        <div className={`relative ${compact ? "aspect-[16/7]" : "aspect-[4/5]"} ${dark ? "bg-slate-800" : "bg-slate-100"}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt={name}
            className={`h-full w-full object-cover transition-transform duration-300 ${speaking ? "scale-[1.03]" : ""}`}
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.dataset.fallback) {
                img.dataset.fallback = "1";
                img.src = portraitSvg(name, name.length);
              }
            }}
          />
          <div className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-3 py-2 text-xs text-white ${speaking ? "bg-gradient-to-t from-brand-700/80" : "bg-gradient-to-t from-slate-900/70"}`}>
            <span className="font-medium">{name}</span>
            <span className="inline-flex items-center gap-1.5" aria-live="polite">
              <span className={`h-2 w-2 rounded-full ${speaking ? "animate-pulse bg-emerald-400" : busy ? "animate-pulse bg-amber-300" : "bg-slate-300"}`} />
              {speaking ? "Speaking" : busy ? "Thinking" : "Listening"}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">{aside}</div>
          <button
            type="button"
            onClick={() => {
              setMuted((m) => !m);
              window.speechSynthesis?.cancel();
              setSpeaking(false);
            }}
            aria-label={muted ? "Unmute" : "Mute"}
            className={`rounded-lg p-2 ${dark ? "text-slate-300 hover:bg-slate-800" : "text-slate-600 hover:bg-slate-100"}`}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div className={`flex flex-col ${compact ? "min-h-[300px]" : "min-h-[480px]"} ${card}`}>
        <div className={`flex items-center justify-between border-b px-4 py-3 ${dark ? "border-slate-800" : "border-slate-100"}`}>
          <h3 className={`flex items-center gap-2 text-sm font-semibold ${dark ? "text-slate-100" : "text-slate-900"}`}>
            <MessageSquare className="h-4 w-4 text-slate-400" /> Conversation
          </h3>
          <button type="button" onClick={reset} className={`text-xs ${muted500} hover:underline`} disabled={!messages.length}>
            Start over
          </button>
        </div>
        <ErrorBanner message={err} />
        <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" data-testid="chat-log" aria-live="polite">
          {messages.length === 0 && <p className={`text-sm ${muted500}`}>{emptyHint}</p>}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ${m.role === "user" ? "bg-brand-600 text-white" : bubbleBot}`} data-role={m.role}>
                {m.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className={`rounded-2xl px-3.5 py-2 text-sm ${bubbleBot} ${muted500}`}>…</div>
            </div>
          )}
        </div>
        <form
          className={`flex items-center gap-2 border-t px-4 py-3 ${dark ? "border-slate-800" : "border-slate-100"}`}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input aria-label="Your message" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message" maxLength={2000} className={inputClass} />
          <Button type="submit" loading={busy} disabled={!draft.trim()}>
            <Send className="h-4 w-4" /> Send
          </Button>
        </form>
      </div>
    </div>
  );
}
