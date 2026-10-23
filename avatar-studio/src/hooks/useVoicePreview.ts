"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Voice } from "@/lib/types";

/**
 * Plays a voice sample: provider audio when available, otherwise the
 * provider's own preview clip, otherwise the browser's Web Speech API.
 */
export function useVoicePreview() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const objectUrl = useRef<string | null>(null);

  const releaseObjectUrl = () => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  };

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    releaseObjectUrl();
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setPlayingId(null);
  }, []);

  useEffect(() => stop, [stop]);

  const speakInBrowser = useCallback((voice: Voice, text: string, speed: number) => {
    if (!("speechSynthesis" in window)) throw new Error("This browser cannot play speech previews.");
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = speed;
    const voices = window.speechSynthesis.getVoices();
    const match =
      voices.find((v) => voice.language && v.lang.toLowerCase().startsWith(voice.language.toLowerCase().slice(0, 2))) ??
      voices[0];
    if (match) utter.voice = match;
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
      setBusyId(voice.id);
      try {
        const res = await fetch("/api/voices/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceId: voice.id, text, speed }),
        });
        if (res.status === 204) {
          if (voice.previewUrl) {
            const audio = new Audio(voice.previewUrl);
            audio.onended = () => setPlayingId(null);
            audioRef.current = audio;
            await audio.play();
          } else {
            speakInBrowser(voice, text, speed);
          }
        } else if (res.ok) {
          const blob = await res.blob();
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
        setPlayingId(voice.id);
      } finally {
        setBusyId(null);
      }
    },
    [playingId, speakInBrowser, stop],
  );

  return { play, stop, playingId, busyId };
}
