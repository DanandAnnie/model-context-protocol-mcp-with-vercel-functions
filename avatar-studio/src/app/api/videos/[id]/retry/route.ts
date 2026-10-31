import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { retryVideo } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Submit a failed render again as a new video with the same settings. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const video = await retryVideo(id, await requireEditor());
    if (video.status === "failed") return json({ video, error: video.error ?? "The render could not be started" }, { status: 502 });
    return json({ video }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
