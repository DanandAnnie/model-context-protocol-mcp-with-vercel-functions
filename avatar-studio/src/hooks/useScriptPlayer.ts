"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { languageCode } from "@/lib/language";
import { stripPauses } from "@/lib/pauses";
import type { PreviewItem } from "@/lib/script-preview";
import type { Voice } from "@/lib/types";

/**
 * Plays a video's scenes one after another, before it is made: each scene's words in its voice (the provider's audio,
 * or the browser's own speech where the provider has none to give), its recorded clip, or its silent hold. Stop ends
 * it at once, wherever it is: the request under way is cancelled and nothing more is said.
 */
export function useScriptPlayer() {
  const [scene, setScene] = useState<number | null>(null);
  // Each run has its number; a stopped run notices at its next step and ends there.
  const run = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const request = useRef<AbortController | null>(null);
  // What the step under way is waiting for, so Stop can end the wait rather than leave it hanging.
  const wake = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    run.current++;
    request.current?.abort();
    request.current = null;
    audio.current?.pause();
    audio.current = null;
    // The utterance is let go first, so the cancel's error event finds nothing to answer.
    utterance.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    wake.current?.();
    wake.current = null;
    setScene(null);
  }, []);
  useEffect(() => stop, [stop]);

  /** Waits for `start` to call its `done` (or fail), or for Stop. */
  const step = (start: (done: () => void, fail: (e: Error) => void) => void) =>
    new Promise<void>((resolve, reject) => {
      wake.current = resolve;
      start(resolve, reject);
    });

  const playAudio = (src: string, failure: string) =>
    step((done, fail) => {
      const a = new Audio(src);
      audio.current = a;
      a.onended = done;
      a.onerror = () => fail(new Error(failure));
      a.play().catch(() => fail(new Error(failure)));
    });

  const speak = (voice: Voice, text: string, speed: number) =>
    step((done, fail) => {
      if (!("speechSynthesis" in window)) return fail(new Error("This browser cannot play speech previews."));
      // Kept while it is spoken: a browser can drop an utterance nothing holds, and never say it has ended.
      const utter = new SpeechSynthesisUtterance(stripPauses(text));
      utterance.current = utter;
      utter.rate = speed;
      const code = languageCode(voice.language);
      const match = code && window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(code));
      if (match) {
        utter.voice = match;
        utter.lang = match.lang;
      }
      const end = () => utterance.current === utter && done();
      utter.onend = end;
      utter.onerror = end;
      window.speechSynthesis.speak(utter);
    });

  /** Plays the items in order; resolves when they are done or stopped, and rejects only for a run still playing. */
  const start = useCallback(
    async (items: PreviewItem[]) => {
      stop();
      const id = ++run.current;
      const live = () => run.current === id;
      try {
        for (const item of items) {
          if (!live()) return;
          setScene(item.scene);
          if (item.kind === "silence") {
            await step((done) => setTimeout(done, item.seconds * 1000));
          } else if (item.kind === "clip") {
            await playAudio(`/api/clips/${item.clipId}`, `Scene ${item.scene + 1}'s recording could not be played; it may have been deleted.`);
          } else {
            const ask = new AbortController();
            request.current = ask;
            const res = await fetch("/api/voices/preview", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ voiceId: item.voice.id, text: item.text, speed: item.speed }),
              signal: ask.signal,
            });
            if (!live()) return;
            if (res.status === 204) await speak(item.voice, item.text, item.speed);
            else if (res.ok) {
              const blob = await res.blob();
              if (!live()) return;
              const url = URL.createObjectURL(blob);
              try {
                await playAudio(url, `Scene ${item.scene + 1} could not be played.`);
              } finally {
                URL.revokeObjectURL(url);
              }
            } else throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "The preview could not be played.");
          }
        }
      } catch (e) {
        // A stopped run's cancelled request (or anything after Stop) is no failure to report.
        if (live()) throw e;
      } finally {
        if (live()) {
          wake.current = null;
          audio.current = null;
          utterance.current = null;
          request.current = null;
          setScene(null);
        }
      }
    },
    // The steps read only refs, so the first render's are as good as any.
    [stop],
  );

  return { start, stop, playingScene: scene };
}
