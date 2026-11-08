import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { retryTranslation } from "@/lib/services";

export const dynamic = "force-dynamic";
// As starting a dub: the provider's glossary is read, written, and checked before the job is created.
export const maxDuration = 60;

/** Tries a failed dub again with the same settings (editors only); the new job takes the failed one's place. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ translation: await retryTranslation(id, await requireEditor()) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
