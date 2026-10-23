import { config } from "@/lib/config";
import { errorResponse, json } from "@/lib/api-utils";
import { applyAvatarWebhook } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Provider callbacks (HeyGen, D-ID). Polling on GET /api/videos/:id also
 * works, so a missed webhook never strands a job.
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await ctx.params;
    if (config.webhookSecret) {
      const secret = new URL(req.url).searchParams.get("secret");
      if (secret !== config.webhookSecret) return json({ error: "Forbidden" }, { status: 403 });
    }
    const body = await req.json().catch(() => null);
    const base = provider.replace(/-translate$/, "");
    const updated = await applyAvatarWebhook(base, body);
    return json({ ok: true, updated: updated?.id ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}
