"use client";
import { useEffect, useRef, useState } from "react";
import { MessageSquare, Mic, Send, Square, ThumbsDown, ThumbsUp, Volume2, VolumeX } from "lucide-react";
import { Button, ErrorBanner, inputClass } from "@/components/ui";
import { languageCode, languageTag } from "@/lib/language";
import { portraitSvg } from "@/lib/stock";
import type { LiveStatus } from "@/hooks/useLiveAvatar";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A reply as the host's `ask` answers it: the text, and, when the host lets visitors rate replies, what names it. */
export type ChatReply = string | { reply: string; ref?: string };

/** A turn as the panel keeps it: a rateable reply carries its `ref` and the visitor's rating. */
type ShownTurn = ChatTurn & { ref?: string; rating?: "up" | "down" };

// Minimal typing for the Web Speech API recogniser (Chrome, Edge, Safari); absent elsewhere.
interface Recognizer {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognizerCtor = new () => Recognizer;

function recognizerCtor(): RecognizerCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const MIC_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in the browser and try again.",
  "service-not-allowed": "Speech recognition is not available in this browser.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs a network connection.",
};

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
  opening,
  starters = [],
  dark = false,
  compact = false,
  aside,
  onReset,
  resetKey,
  live,
  rate,
}: {
  name: string;
  imageUrl: string;
  voiceLanguage?: string;
  ask: (messages: ChatTurn[]) => Promise<ChatReply>;
  emptyHint?: string;
  /** The presenter's first message, shown before the visitor says anything and kept in the transcript. */
  opening?: string;
  /** Suggested questions offered as chips until the visitor's first message. */
  starters?: string[];
  dark?: boolean;
  /** Single column with a small portrait, for the website embed. */
  compact?: boolean;
  /** Extra controls rendered under the portrait (e.g. a voice picker). */
  aside?: React.ReactNode;
  /** Called when the visitor starts over, so the host can drop its transcript id. */
  onReset?: () => void;
  /**
   * The conversation starts afresh whenever this changes (the host loaded another setup), without remounting, so a live
   * video already attached to the panel stays attached; a reply still on its way to the old conversation is dropped.
   */
  resetKey?: string;
  /** Live video session; when connected, replies are spoken by the stream instead of the browser. */
  live?: { status: LiveStatus; videoRef: React.RefObject<HTMLVideoElement | null>; speak: (text: string) => Promise<boolean> };
  /** Saves a visitor's rating of a reply `ask` gave a `ref` (`null` takes it back); replies then show thumbs up and down. */
  rate?: (ref: string, rating: "up" | "down" | null) => Promise<void>;
}) {
  const openingTurns: ChatTurn[] = opening ? [{ role: "assistant", content: opening }] : [];
  const [messages, setMessages] = useState<ShownTurn[]>(openingTurns);
  // Each reply's ratings are sent one after another, so quick clicks reach the server in the order they were made.
  const ratingQueue = useRef(new Map<string, Promise<unknown>>());
  /** Per reply, the rating the server last confirmed and the newest click, so a failed save rolls back only when it is the last. */
  const ratingSaved = useRef(new Map<string, "up" | "down" | null>());
  const ratingClicks = useRef(new Map<string, number>());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [canListen, setCanListen] = useState(false);
  const [listening, setListening] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const recognizer = useRef<Recognizer | null>(null);
  const heard = useRef("");
  // Bumped by each fresh start, so a reply that arrives for the conversation before it is not shown or spoken.
  const round = useRef(0);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);
  /** Drop the recogniser without letting its final `onend` send what was heard. */
  function dropRecognizer() {
    const rec = recognizer.current;
    recognizer.current = null;
    heard.current = "";
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.abort();
    }
  }

  useEffect(() => {
    setCanListen(recognizerCtor() !== null);
    return () => {
      window.speechSynthesis?.cancel();
      dropRecognizer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function speak(text: string) {
    if (muted || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const code = languageCode(voiceLanguage);
    const match = code ? window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(code)) : undefined;
    if (match) {
      utter.voice = match;
      utter.lang = match.lang;
    }
    utter.onstart = () => setSpeaking(true);
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utter);
  }

  /** Push-to-talk: one utterance is transcribed into the box and sent when it ends. */
  function toggleListening() {
    if (listening) {
      recognizer.current?.stop();
      return;
    }
    const Ctor = recognizerCtor();
    if (!Ctor) return;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    setErr(null);
    heard.current = "";
    const rec = new Ctor();
    rec.lang = languageTag(voiceLanguage) ?? navigator.language ?? "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let text = "";
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      setDraft(text);
      if (final) heard.current = text;
    };
    rec.onerror = (e) => {
      if (e.error !== "aborted" && e.error !== "no-speech") setErr(MIC_ERRORS[e.error] ?? "Could not hear you. Try again.");
    };
    rec.onend = () => {
      setListening(false);
      recognizer.current = null;
      const text = heard.current.trim();
      heard.current = "";
      // The newest `send`, not the one from when listening started, so what changed meanwhile (a rating) is kept.
      if (text) void sendRef.current(text);
    };
    recognizer.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      recognizer.current = null;
      setErr("Could not start the microphone.");
    }
  }

  async function send(text = draft) {
    const content = text.trim();
    if (!content || busy) return;
    const asked: ShownTurn = { role: "user", content };
    const next: ShownTurn[] = [...messages, asked];
    setMessages((now) => [...now, asked]);
    // A chip sends its own text; whatever the visitor had typed stays in the box.
    setDraft((d) => (d.trim() === content ? "" : d));
    setBusy(true);
    setErr(null);
    const asked0 = round.current;
    try {
      // The last 20 turns; once the transcript outgrows that, the window starts at a visitor turn so the
      // model never sees a mid-conversation reply as the presenter's opening.
      const recent = next.slice(-20);
      const firstUser = recent.findIndex((m) => m.role === "user");
      const answer = await ask((next.length > 20 && firstUser > 0 ? recent.slice(firstUser) : recent).map(({ role, content }) => ({ role, content })));
      if (asked0 !== round.current) return;
      const { reply, ref } = typeof answer === "string" ? { reply: answer, ref: undefined } : answer;
      // Added to the transcript as it is now, so a reply rated while this one was on its way keeps its rating.
      setMessages((now) => [...now, { role: "assistant", content: reply, ...(ref ? { ref } : {}) }]);
      if (!(live && (await live.speak(reply)))) speak(reply);
    } catch (e) {
      if (asked0 !== round.current) return;
      setErr(e instanceof Error ? e.message : "The presenter could not answer");
      setMessages((now) => now.filter((x) => x !== asked));
      // Put the failed text back unless the visitor has something of their own in the box.
      setDraft((d) => (d.trim() ? d : content));
    } finally {
      setBusy(false);
    }
  }

  const sendRef = useRef(send);
  sendRef.current = send;

  /** Rates reply `i` (the same thumb again takes the rating back), at once on the page and then through `rate`. */
  function rateReply(i: number, value: "up" | "down") {
    const m = messages[i];
    if (!rate || !m?.ref) return;
    const ref = m.ref;
    const rating = m.rating === value ? null : value;
    const asked0 = round.current;
    const show = (r: "up" | "down" | null | undefined) =>
      setMessages((now) =>
        now.map((x) => {
          if (x.ref !== ref) return x;
          const { rating: _was, ...rest } = x;
          return r ? { ...rest, rating: r } : rest;
        }),
      );
    show(rating);
    const click = (ratingClicks.current.get(ref) ?? 0) + 1;
    ratingClicks.current.set(ref, click);
    const sent = (ratingQueue.current.get(ref) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => rate(ref, rating))
      .then(
        () => void ratingSaved.current.set(ref, rating),
        (e: unknown) => {
          if (asked0 !== round.current || ratingClicks.current.get(ref) !== click) return;
          show(ratingSaved.current.get(ref) ?? null);
          setErr(e instanceof Error ? e.message : "Your rating could not be saved");
        },
      );
    ratingQueue.current.set(ref, sent);
  }

  /** Clears the conversation, the recogniser, and speech; a reply on its way is dropped. */
  function startAfresh() {
    round.current += 1;
    window.speechSynthesis?.cancel();
    dropRecognizer();
    setListening(false);
    setSpeaking(false);
    setMessages(openingTurns);
    setErr(null);
  }

  function reset() {
    startAfresh();
    onReset?.();
  }

  const firstKey = useRef(resetKey);
  useEffect(() => {
    if (resetKey === firstKey.current) return;
    firstKey.current = resetKey;
    startAfresh();
    setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of setup starts afresh
  }, [resetKey]);

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
          {live && (
            <video
              ref={live.videoRef}
              autoPlay
              playsInline
              aria-label={`${name}, live video`}
              className={`absolute inset-0 h-full w-full bg-slate-950 object-cover transition-opacity ${live.status === "live" ? "opacity-100" : "pointer-events-none opacity-0"}`}
            />
          )}
          <div className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-3 py-2 text-xs text-white ${speaking ? "bg-gradient-to-t from-brand-700/80" : "bg-gradient-to-t from-slate-900/70"}`}>
            <span className="font-medium">
              {name}
              {live?.status === "live" && <span className="ml-2 rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">Live</span>}
              {live?.status === "connecting" && <span className="ml-2 text-slate-300">connecting…</span>}
            </span>
            <span className="inline-flex items-center gap-1.5" aria-live="polite">
              <span className={`h-2 w-2 rounded-full ${speaking ? "animate-pulse bg-emerald-400" : busy ? "animate-pulse bg-amber-300" : "bg-slate-300"}`} />
              {speaking ? "Speaking" : busy ? "Thinking" : listening ? "Hearing you" : "Listening"}
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
          <button type="button" onClick={reset} className={`text-xs ${muted500} hover:underline`} disabled={messages.length <= openingTurns.length}>
            Start over
          </button>
        </div>
        <ErrorBanner message={err} />
        <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" data-testid="chat-log" aria-live="polite">
          {messages.length === 0 && <p className={`text-sm ${muted500}`}>{emptyHint}</p>}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className="max-w-[80%]">
                <div className={`rounded-2xl px-3.5 py-2 text-sm ${m.role === "user" ? "bg-brand-600 text-white" : bubbleBot}`} data-role={m.role} data-opening={opening && i === 0 ? "true" : undefined}>
                  {m.content}
                </div>
                {rate && m.ref && (
                  <div className="mt-1 flex gap-1" role="group" aria-label="Rate this reply">
                    {(["up", "down"] as const).map((value) => {
                      const Icon = value === "up" ? ThumbsUp : ThumbsDown;
                      const on = m.rating === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => rateReply(i, value)}
                          aria-pressed={on}
                          aria-label={value === "up" ? "Helpful" : "Not helpful"}
                          title={value === "up" ? "Helpful" : "Not helpful"}
                          className={`rounded p-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${on ? (dark ? "bg-slate-700 text-white" : "bg-slate-200 text-slate-900") : dark ? "text-slate-400 hover:bg-slate-800" : "text-slate-500 hover:bg-slate-100"}`}
                        >
                          <Icon className="h-3.5 w-3.5" fill={on ? "currentColor" : "none"} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className={`rounded-2xl px-3.5 py-2 text-sm ${bubbleBot} ${muted500}`}>…</div>
            </div>
          )}
        </div>
        {starters.length > 0 && messages.length === openingTurns.length && (
          <div className="flex flex-wrap gap-2 px-4 pb-3" data-testid="chat-starters" role="group" aria-label="Suggested questions">
            {starters.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => send(s)}
                disabled={busy || listening}
                className={`rounded-full border px-3 py-1 text-xs ${dark ? "border-slate-700 text-slate-200 hover:bg-slate-800" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <form
          className={`flex items-center gap-2 border-t px-4 py-3 ${dark ? "border-slate-800" : "border-slate-100"}`}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            aria-label="Your message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={listening ? "Listening…" : "Type a message"}
            maxLength={2000}
            className={inputClass}
          />
          {canListen && (
            <button
              type="button"
              onClick={toggleListening}
              disabled={busy}
              aria-label={listening ? "Stop listening" : "Speak a question"}
              aria-pressed={listening}
              title={listening ? "Stop listening" : "Speak a question"}
              className={`rounded-lg p-2 ${listening ? "animate-pulse bg-rose-600 text-white" : dark ? "text-slate-300 hover:bg-slate-800" : "text-slate-600 hover:bg-slate-100"} disabled:opacity-50`}
            >
              {listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
          )}
          <Button type="submit" loading={busy} disabled={!draft.trim() || listening}>
            <Send className="h-4 w-4" /> Send
          </Button>
        </form>
      </div>
    </div>
  );
}
