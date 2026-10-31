"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { stripPauses } from "@/lib/pauses";
import type { Voice } from "@/lib/types";
import { languageCode } from "@/lib/language";

/**
 * Plays a voice sample: provider audio when available, otherwise the
 * provider's own preview clip, otherwise the browser's Web Speech API.
 */
export function useVoicePreview() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const objectUrl = useRef<string | null>(null);
  // Each preview has its number, so one still loading when it is stopped (or another starts) never plays.
  const run = useRef(0);

  const releaseObjectUrl = () => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  };

  const stop = useCallback(() => {
    run.current++;
    audioRef.current?.pause();
    audioRef.current = null;
    releaseObjectUrl();
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setPlayingId(null);
    setBusyId(null);
  }, []);

  useEffect(() => stop, [stop]);

  const speakInBrowser = useCallback((voice: Voice, text: string, speed: number) => {
    if (!("speechSynthesis" in window)) throw new Error("This browser cannot play speech previews.");
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = speed;
    const voices = window.speechSynthesis.getVoices();
    const code = languageCode(voice.language);
    const match = (code && voices.find((v) => v.lang.toLowerCase().startsWith(code))) || voices[0];
    if (match) {
      utter.voice = match;
      utter.lang = match.lang;
    }
    utter.onend = () => setPlayingId(null);
    utter.onerror = () => setPlayingId(null);
    window.speechSynthesis.speak(utter);
  }, []);

  const play = useCallback(
    async (voice: Voice, text: string, speed = 1) => {
      if (playingId === voice.id) {
        stop();
        return;
      }
      stop();
      const id = ++run.current;
      setBusyId(voice.id);
      try {
        const res = await fetch("/api/voices/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceId: voice.id, text, speed }),
        });
        if (run.current !== id) return;
        if (res.status === 204) {
          if (voice.previewUrl) {
            const audio = new Audio(voice.previewUrl);
            audio.onended = () => setPlayingId(null);
            audioRef.current = audio;
            await audio.play();
          } else {
            speakInBrowser(voice, stripPauses(text), speed);
          }
        } else if (res.ok) {
          const blob = await res.blob();
          if (run.current !== id) return;
          objectUrl.current = URL.createObjectURL(blob);
          const audio = new Audio(objectUrl.current);
          audio.onended = () => {
            setPlayingId(null);
            releaseObjectUrl();
          };
          audioRef.current = audio;
          await audio.play();
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Preview failed");
        }
        if (run.current === id) setPlayingId(voice.id);
      } finally {
        if (run.current === id) setBusyId(null);
      }
    },
    [playingId, speakInBrowser, stop],
  );

  return { play, stop, playingId, busyId };
}
