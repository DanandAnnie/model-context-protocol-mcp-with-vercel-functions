// Live-video sessions for the interactive avatar. The registry maps a short-lived public session
// id to the provider session and the presenter it was opened for, so a session cannot be driven
// from another page or agent. Per instance; sessions are also capped per client and per presenter.
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { NotFoundError, ValidationError } from "./errors";
import { liveAvatarFromConfig } from "./providers/streaming/liveavatar";
import { MockStreamingProvider } from "./providers/streaming/mock";
import type { ProviderLiveSession, StreamingProvider } from "./providers/types";
import { getStore } from "./store";
import type { Avatar } from "./types";

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const MAX_SESSIONS_PER_SCOPE = 3;

interface LiveSession {
  id: string;
  provider: ProviderLiveSession;
  /** What the session may speak for: an agent id, or `owner:<id>` for the interactive page. */
  scope: string;
  clientKey: string;
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __avatarStudioStreaming: StreamingProvider | undefined;
  // eslint-disable-next-line no-var
  var __avatarStudioLiveSessions: Map<string, LiveSession> | undefined;
}

export function getStreamingProvider(): StreamingProvider {
  if (globalThis.__avatarStudioStreaming) return globalThis.__avatarStudioStreaming;
  const p: StreamingProvider = liveAvatarFromConfig() ?? new MockStreamingProvider();
  globalThis.__avatarStudioStreaming = p;
  return p;
}

export function setStreamingProvider(p: StreamingProvider | undefined) {
  globalThis.__avatarStudioStreaming = p;
}

function sessions(): Map<string, LiveSession> {
  return (globalThis.__avatarStudioLiveSessions ??= new Map());
}

function sweep(now: number) {
  for (const [id, s] of sessions()) if (s.expiresAt <= now) sessions().delete(id);
}

/**
 * Opens a live session for a presenter. Returns null when live video is not available, so callers
 * fall back to the portrait. Enforces a small cap per client and per scope.
 */
export async function openLiveSession(input: { avatarId: string; voiceId?: string; scope: string; clientKey: string }, now = Date.now()) {
  const provider = getStreamingProvider();
  if (!provider.available) return null;
  sweep(now);
  const mine = [...sessions().values()].filter((s) => s.clientKey === input.clientKey || s.scope === input.scope);
  if (mine.filter((s) => s.clientKey === input.clientKey).length >= MAX_SESSIONS_PER_SCOPE) throw new ValidationError("Too many live sessions; close one first");
  if (mine.filter((s) => s.scope === input.scope).length >= MAX_SESSIONS_PER_SCOPE * 4) throw new ValidationError("This presenter is busy; try again shortly");
  // A custom portrait is one of the app's own avatars; a provider may have no live counterpart for it.
  const custom = !!(await getStore().get<Avatar>("avatar", input.avatarId));
  const created = await provider.createSession({ avatarId: input.avatarId, voiceId: input.voiceId, custom });
  if (!created) return null;
  const id = `live_${randomBytes(12).toString("base64url")}`;
  sessions().set(id, { id, provider: created.session, scope: input.scope, clientKey: input.clientKey, expiresAt: now + SESSION_TTL_MS });
  return {
    sessionId: id,
    url: created.url,
    accessToken: created.accessToken,
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    // The browser then speaks each reply on the room's data channel and tells the server it did.
    ...(provider.speaksInRoom ? { speakInRoom: true } : {}),
  };
}

function requireSession(sessionId: string, scope: string, now = Date.now()): LiveSession {
  sweep(now);
  const s = sessions().get(sessionId);
  if (!s || s.scope !== scope) throw new NotFoundError("Live session not found");
  s.expiresAt = now + SESSION_TTL_MS; // activity keeps it alive
  return s;
}

export async function speakLive(sessionId: string, scope: string, text: string, now = Date.now()): Promise<void> {
  const s = requireSession(sessionId, scope, now);
  await getStreamingProvider().speak(s.provider, text.slice(0, 1500));
}

export async function closeLiveSession(sessionId: string, scope: string, now = Date.now()): Promise<void> {
  sweep(now);
  const s = sessions().get(sessionId);
  if (!s || s.scope !== scope) return;
  sessions().delete(sessionId);
  await getStreamingProvider().stop(s.provider);
}

/** Test hook. */
export function resetLiveSessions() {
  sessions().clear();
}
