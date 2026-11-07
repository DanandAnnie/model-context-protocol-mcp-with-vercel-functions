import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { suggestTitles } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Titles suggested from the video's title and script: `{ titles }`. Nothing is saved. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    return json({ titles: await suggestTitles((await ctx.params).id, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
