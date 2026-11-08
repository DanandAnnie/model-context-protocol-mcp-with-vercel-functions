"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { COMMAND_TOPIC, RESPONSE_TOPIC, commandId, isSessionStopped, speakCommand } from "@/lib/live-commands";

/** Pinned LiveKit browser SDK, loaded only once a live session exists (never in demo mode). */
const LIVEKIT_UMD = "https://cdn.jsdelivr.net/npm/livekit-client@2.5.7/dist/livekit-client.umd.js";

export type LiveStatus = "idle" | "connecting" | "live" | "unavailable" | "error";

/** How long the avatar and LiveAvatar's agent are waited for in the room, as LiveAvatar's SDK waits. */
const PARTICIPANTS_TIMEOUT_MS = 30_000;
/** How often a page showing a LiveAvatar session keeps it alive, as LiveAvatar's SDK does. */
const KEEP_ALIVE_MS = 60_000;

interface LiveParticipant {
  identity: string;
}
interface LiveRoom {
  on(event: string, cb: (...args: unknown[]) => void): LiveRoom;
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  remoteParticipants?: Map<string, LiveParticipant>;
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
        const res = await api<{ available: boolean; sessionId?: string; url?: string; accessToken?: string; speakInRoom?: boolean; waitFor?: string[] }>(openPath, { method: "POST", body: bodyJson });
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
        // Who must be in the room before anything is said (LiveAvatar: the avatar and its agent); the avatar is the
        // first, and only its tracks are shown, so another participant's audio never replaces the presenter's.
        const required = res.waitFor ?? [];
        const presenter = required[0];
        room.on("trackSubscribed", (track, _publication, participant) => {
          const t = track as LiveTrack;
          if (presenter && (participant as LiveParticipant | undefined)?.identity !== presenter) return;
          if (videoRef.current && (t.kind === "video" || t.kind === "audio")) t.attach(videoRef.current);
        });
        // A session that ends (the room closes, a required participant leaves, LiveAvatar stops it) is no longer live,
        // so replies go back to the browser's voice instead of into an empty room.
        const lost = () => {
          setStatus((s) => (s === "live" ? "error" : s));
          void close();
        };
        room.on("disconnected", lost);
        room.on("participantDisconnected", (participant) => {
          if (required.includes((participant as LiveParticipant).identity)) lost();
        });
        room.on("dataReceived", (payload, _participant, _kind, topic) => {
          if (topic === RESPONSE_TOPIC && isSessionStopped(payload as Uint8Array)) lost();
        });
        await room.connect(res.url, res.accessToken);
        roomRef.current = room;
        // Participants already in the room are listed; later ones announce themselves (no event is lost in between).
        await waitForParticipants(room, required);
        if (cancelled) {
          await room.disconnect().catch(() => {});
          return;
        }
        setStatus("live");
      } catch (err) {
        console.error("live avatar failed:", err);
        if (!cancelled) {
          setStatus("error");
          void close();
        }
      }
    })();
    // Closing the tab ends the session too; a cleanup alone does not run when the page goes away.
    const onPageHide = () => void close();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onPageHide);
      close();
      setStatus("idle");
    };
    // `key` re-opens the session when the presenter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, openPath, bodyJson, key]);

  // While a session whose replies are said in the room is shown, it is kept alive every minute, quiet or not.
  useEffect(() => {
    if (status !== "live" || !inRoomRef.current) return;
    const timer = setInterval(() => {
      const sessionId = sessionRef.current;
      if (sessionId) void api(sessionPath(sessionId), { method: "POST", body: JSON.stringify({ keepAlive: true }) }).catch(() => {});
    }, KEEP_ALIVE_MS);
    return () => clearInterval(timer);
  }, [status, sessionPath]);

  /** Sends the text to the live presenter. Resolves false when there is no live session, so the caller speaks locally. */
  const speak = useCallback(
    async (text: string) => {
      const sessionId = sessionRef.current;
      if (!sessionId || status !== "live") return false;
      try {
        if (inRoomRef.current && roomRef.current) {
          await roomRef.current.localParticipant.publishData(speakCommand(text, commandId()), { reliable: true, topic: COMMAND_TOPIC });
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

/** Resolves once every identity is in the room; rejects after the timeout, so the page falls back to the portrait. */
function waitForParticipants(room: LiveRoom, identities: string[]): Promise<void> {
  const missing = new Set(identities);
  for (const p of room.remoteParticipants?.values() ?? []) missing.delete(p.identity);
  if (!missing.size) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${[...missing].join(", ")}`)), PARTICIPANTS_TIMEOUT_MS);
    room.on("participantConnected", (participant) => {
      missing.delete((participant as LiveParticipant).identity);
      if (missing.size) return;
      clearTimeout(timer);
      resolve();
    });
  });
}
