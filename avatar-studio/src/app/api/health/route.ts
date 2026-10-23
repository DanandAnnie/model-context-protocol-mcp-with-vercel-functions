import { json } from "@/lib/api-utils";
import { providerStatus } from "@/lib/providers";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Public liveness check for uptime monitors: store reachable plus the configured backends. */
export async function GET() {
  const started = Date.now();
  let store: "ok" | "error" = "ok";
  try {
    await getStore().list("plan", "__health__");
  } catch {
    store = "error";
  }
  const status = providerStatus();
  const body = {
    ok: store === "ok",
    store,
    persistence: status.persistence,
    providers: { avatar: status.avatar, tts: status.tts, script: status.script, translate: status.translate, email: status.email, billing: status.billing, streaming: status.streaming },
    latencyMs: Date.now() - started,
    time: new Date().toISOString(),
  };
  return json(body, { status: body.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
