import { errorResponse } from "@/lib/api-utils";
import { proofreadSrt } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The proofread lines as SRT, read by the dubbing provider; public, but only with the job's secret. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const srt = await proofreadSrt(id, new URL(req.url).searchParams.get("token") ?? "");
    return new Response(srt, { headers: { "Content-Type": "application/x-subrip; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  } catch (err) {
    return errorResponse(err);
  }
}
