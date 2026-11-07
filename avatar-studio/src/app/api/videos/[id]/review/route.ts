import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireReviewer } from "@/lib/owner";
import { recordActivity, reviewActionSchema, reviewVideo } from "@/lib/services";
import type { ActivityKind } from "@/lib/types";

export const dynamic = "force-dynamic";

const LOGGED: Partial<Record<string, ActivityKind>> = {
  request: "video.review_requested",
  approve: "video.approved",
  changes: "video.changes_requested",
};

/**
 * `{ action: "request" | "approve" | "changes" | "withdraw", note? }`. Editors ask for a review and
 * withdraw their own request; workspace owners approve or ask for changes (with a note) → `{ video }`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { owner, user, canDecide } = await requireReviewer();
    const input = reviewActionSchema.parse(await readJson(req));
    const video = await reviewVideo(id, owner, user, canDecide, input);
    const kind = LOGGED[input.action];
    if (kind) {
      try {
        await recordActivity(owner, user, kind, { subject: video.title, subjectId: id });
      } catch (err) {
        console.error(`activity ${kind} for ${owner} not recorded:`, err);
      }
    }
    return json({ video });
  } catch (err) {
    return errorResponse(err);
  }
}
