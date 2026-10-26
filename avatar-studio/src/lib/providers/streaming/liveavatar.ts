import { config } from "../../config";
import type { ProviderLiveSession, StreamingProvider } from "../types";

const API = "https://api.liveavatar.com/v1/sessions";
/** LiveAvatar's success code inside its `{ code, data, message }` envelope. */
const OK = 1000;

/**
 * HeyGen's LiveAvatar, which replaces HeyGen's v1 streaming API (retired October 31, 2026). The server creates a
 * session token with the account's key (`POST /v1/sessions/token`, FULL mode, so LiveAvatar voices what it is told)
 * and starts it (`POST /v1/sessions/start`, the token as bearer); the browser joins the LiveKit room and speaks each
 * reply as an `avatar.speak_text` command on the room's `agent-control` data channel. The session token stays on the
 * server, for keep-alive and stop. Shapes follow LiveAvatar's published web SDK and two open-source clients; not yet
 * run against the live API.
 */
export class LiveAvatarStreamingProvider implements StreamingProvider {
  readonly name = "liveavatar";
  readonly available = true;
  readonly speaksInRoom = true;
  constructor(
    private apiKey: string,
    private options: { avatarId?: string; voiceId?: string } = {},
  ) {}

  async createSession({ avatarId, custom }: { avatarId: string; voiceId?: string; custom: boolean }) {
    // LiveAvatar's avatars are its own: a configured one, or a library presenter whose id it may know. A custom
    // portrait has no LiveAvatar counterpart, so it stays an animated portrait.
    const avatar = this.options.avatarId ?? (custom ? undefined : avatarId);
    if (!avatar) return null;
    const token = await this.call<{ session_id: string; session_token: string }>("/token", { "X-API-KEY": this.apiKey }, {
      mode: "FULL",
      avatar_id: avatar,
      ...(this.options.voiceId ? { avatar_persona: { voice_id: this.options.voiceId } } : {}),
    });
    const session: ProviderLiveSession = { id: token.session_id, secret: token.session_token };
    try {
      const started = await this.call<{ livekit_url?: string; livekit_client_token?: string }>("/start", this.bearer(session), { session_id: session.id });
      if (!started.livekit_url || !started.livekit_client_token) throw new Error("LiveAvatar started the session without a room");
      return { session, url: started.livekit_url, accessToken: started.livekit_client_token };
    } catch (err) {
      await this.stop(session);
      throw err;
    }
  }

  /** The browser said the reply in the room; the session is kept alive so LiveAvatar does not end it as idle. */
  async speak(session: ProviderLiveSession) {
    // Already said: a failed keep-alive must not make the page say the reply a second time.
    await this.call("/keep-alive", this.bearer(session), { session_id: session.id }).catch((err) => console.error("LiveAvatar keep-alive failed:", err));
  }

  async stop(session: ProviderLiveSession) {
    await this.call("/stop", this.bearer(session), { session_id: session.id }).catch(() => {});
  }

  private bearer(session: ProviderLiveSession) {
    return { Authorization: `Bearer ${session.secret ?? ""}` };
  }

  private async call<T>(path: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: { code?: number; data?: T; message?: string } = {};
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: reported below with the status.
    }
    if (!res.ok || (json.code !== undefined && json.code !== OK)) throw new Error(`LiveAvatar ${path} failed: ${res.status} ${json.message ?? text.slice(0, 300)}`);
    return (json.data ?? {}) as T;
  }
}

/** The configured LiveAvatar provider, or null when live video is off or has no key. */
export function liveAvatarFromConfig(): LiveAvatarStreamingProvider | null {
  if (!config.streamingEnabled || !config.liveAvatarApiKey) return null;
  return new LiveAvatarStreamingProvider(config.liveAvatarApiKey, { avatarId: config.liveAvatarAvatarId, voiceId: config.liveAvatarVoiceId });
}
