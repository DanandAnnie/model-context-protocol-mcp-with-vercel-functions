import { HeyGenClient } from "../heygen-client";
import type { StreamingProvider } from "../types";

/** HeyGen Interactive Avatar streaming (LiveKit). Untested against the live API; shapes follow the v1 docs. */
export class HeyGenStreamingProvider implements StreamingProvider {
  readonly name = "heygen";
  readonly available = true;
  private client: HeyGenClient;
  constructor(apiKey: string) {
    this.client = new HeyGenClient(apiKey);
  }
  async createSession({ avatarId, voiceId }: { avatarId: string; voiceId?: string }) {
    const s = await this.client.streamingNew(avatarId, voiceId);
    await this.client.streamingStart(s.session_id);
    return { providerSessionId: s.session_id, url: s.url, accessToken: s.access_token };
  }
  async speak(providerSessionId: string, text: string) {
    await this.client.streamingSpeak(providerSessionId, text);
  }
  async stop(providerSessionId: string) {
    await this.client.streamingStop(providerSessionId).catch(() => {});
  }
}
