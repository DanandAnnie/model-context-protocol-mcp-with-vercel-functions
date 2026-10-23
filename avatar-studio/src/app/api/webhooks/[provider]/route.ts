import { config } from "@/lib/config";
import { errorResponse, json } from "@/lib/api-utils";
import { applyAvatarWebhook, applyTranslationWebhook } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Provider callbacks (HeyGen, D-ID). Only enabled when WEBHOOK_SECRET is set,
 * since the endpoint can change a video's status and URL. Polling on
 * GET /api/videos/:id covers deployments without it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    if (!config.webhookSecret) return json({ error: "Webhooks are disabled: set WEBHOOK_SECRET" }, { status: 503 });
    const secret = new URL(req.url).searchParams.get("secret");
    if (secret !== config.webhookSecret) return json({ error: "Forbidden" }, { status: 403 });

    const { provider } = await ctx.params;
    const body = await req.json().catch(() => null);
    const updated = provider.endsWith("-translate")
      ? await applyTranslationWebhook(provider.replace(/-translate$/, ""), body)
      : await applyAvatarWebhook(provider, body);
    return json({ ok: true, updated: updated?.id ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}
