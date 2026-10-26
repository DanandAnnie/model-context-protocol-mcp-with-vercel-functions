"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { COMMAND_TOPIC, speakCommand } from "@/lib/live-commands";

/** Pinned LiveKit browser SDK, loaded only once a live session exists (never in demo mode). */
const LIVEKIT_UMD = "https://cdn.jsdelivr.net/npm/livekit-client@2.5.7/dist/livekit-client.umd.js";

export type LiveStatus = "idle" | "connecting" | "live" | "unavailable" | "error";

interface LiveRoom {
  on(event: string, cb: (...args: unknown[]) => void): LiveRoom;
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  localParticipant: { publishData(data: Uint8Array, options: { reliable: boolean; topic: string }): Promise<void> };
}

interface LiveTrack {
  kind: string;
  attach(el: HTMLMediaElement): HTMLMediaElement;
}
declare global {
  interface Window {
    LivekitClient?: { Room: new (opts?: Record<string, unknown>) => LiveRoom };
  }
}

function loadLiveKit(): Promise<NonNullable<Window["LivekitClient"]>> {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LIVEKIT_UMD;
    s.async = true;
    s.onload = () => (window.LivekitClient ? resolve(window.LivekitClient) : reject(new Error("LiveKit failed to load")));
    s.onerror = () => reject(new Error("LiveKit failed to load"));
    document.head.appendChild(s);
  });
}

/**
 * Live video for a presenter. Opens a session through `openPath`, joins the LiveKit room, and
 * routes replies to the stream. When the server reports no live video, status is "unavailable"
 * and the caller keeps the portrait and browser speech.
 */
export function useLiveAvatar(opts: { enabled: boolean; openPath: string; openBody: Record<string, unknown>; sessionPath: (sessionId: string) => string; key: string }) {
  const [status, setStatus] = useState<LiveStatus>("idle");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<string | null>(null);
  const roomRef = useRef<LiveRoom | null>(null);
  /** Whether replies are spoken in the room (LiveAvatar) rather than sent from the server. */
  const inRoomRef = useRef(false);
  const { enabled, openPath, sessionPath, key } = opts;
  const bodyJson = JSON.stringify(opts.openBody);

  const close = useCallback(async () => {
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    await roomRef.current?.disconnect().catch(() => {});
    roomRef.current = null;
    if (sessionId) await fetch(sessionPath(sessionId), { method: "DELETE", keepalive: true }).catch(() => {});
  }, [sessionPath]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setStatus("connecting");
    (async () => {
      try {
        const res = await api<{ available: boolean; sessionId?: string; url?: string; accessToken?: string; speakInRoom?: boolean }>(openPath, { method: "POST", body: bodyJson });
        if (cancelled) return;
        if (!res.available || !res.sessionId || !res.url || !res.accessToken) {
          setStatus("unavailable");
          return;
        }
        sessionRef.current = res.sessionId;
        inRoomRef.current = !!res.speakInRoom;
        const lk = await loadLiveKit();
        if (cancelled) return;
        const room = new lk.Room({ adaptiveStream: true });
        room.on("trackSubscribed", (track) => {
          const t = track as LiveTrack;
          if (videoRef.current && (t.kind === "video" || t.kind === "audio")) t.attach(videoRef.current);
        });
        room.on("disconnected", () => setStatus((s) => (s === "live" ? "error" : s)));
        await room.connect(res.url, res.accessToken);
        if (cancelled) {
          await room.disconnect().catch(() => {});
          return;
        }
        roomRef.current = room;
        setStatus("live");
      } catch (err) {
        console.error("live avatar failed:", err);
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      close();
      setStatus("idle");
    };
    // `key` re-opens the session when the presenter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, openPath, bodyJson, key]);

  /** Sends the text to the live presenter. Resolves false when there is no live session, so the caller speaks locally. */
  const speak = useCallback(
    async (text: string) => {
      const sessionId = sessionRef.current;
      if (!sessionId || status !== "live") return false;
      try {
        if (inRoomRef.current && roomRef.current) {
          await roomRef.current.localParticipant.publishData(speakCommand(text, crypto.randomUUID()), { reliable: true, topic: COMMAND_TOPIC });
          // Said: the server only keeps the session alive, so its answer never makes the page say it again.
          void api(sessionPath(sessionId), { method: "POST", body: JSON.stringify({ text }) }).catch(() => {});
          return true;
        }
        await api(sessionPath(sessionId), { method: "POST", body: JSON.stringify({ text }) });
        return true;
      } catch {
        return false;
      }
    },
    [sessionPath, status],
  );

  return { status, videoRef, speak, close };
}
