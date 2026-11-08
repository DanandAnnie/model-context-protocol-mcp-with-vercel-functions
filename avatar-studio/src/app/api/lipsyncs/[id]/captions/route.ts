import { errorResponse } from "@/lib/api-utils";
import { cuesToSrt, cuesToVtt } from "@/lib/captions";
import { requireOwner } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { LimitError, lipsyncCaptions } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Each download asks the renderer for a fresh link and reads the file, so they are counted per account and across accounts. */
const PER_OWNER = 120;
const PER_INSTANCE = 600;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * A finished lip sync's captions, timed to the lip-synced video: SRT, or WebVTT with `?format=vtt` (viewers too). They
 * are the renderer's own, read from it on every request and never kept.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const vtt = new URL(req.url).searchParams.get("format") === "vtt";
    // Counted only for a download that reaches the renderer, the account's own allowance first, so one account's
    // refused requests never use up the allowance every account shares.
    const admit = () => {
      for (const [key, max] of [[`lipsynccaptions:${owner}`, PER_OWNER], ["lipsynccaptions:*", PER_INSTANCE]] as const) {
        const limit = rateLimit(key, max, WINDOW_MS);
        if (!limit.allowed) throw new LimitError(`Too many caption downloads for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
      }
    };
    const { title, cues } = await lipsyncCaptions(id, owner, { admit });
    const filename = `${title.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "captions"}.${vtt ? "vtt" : "srt"}`;
    return new Response(vtt ? cuesToVtt(cues) : cuesToSrt(cues), {
      headers: {
        "Content-Type": vtt ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
