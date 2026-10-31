import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { languageCopy, languageCopySchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Copies one account may have translated an hour: each asks the script writer once per script, on-screen text, and name. */
const COPIES_PER_OWNER = 20;
const WINDOW_MS = 60 * 60 * 1000;

/** `{ language }` → `{ language, scripts, voices, overlays, names }`: the video's scenes translated and a voice in that language for each of its voices. Nothing is saved. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const body = languageCopySchema.parse(await readJson(req));
    // Counted only for a copy that passed its checks, so one refused, or asked again after a refusal, costs nothing.
    return json(await languageCopy((await ctx.params).id, body, owner, () => rateLimit(`languagecopy:${owner}`, COPIES_PER_OWNER, WINDOW_MS).allowed));
  } catch (err) {
    return errorResponse(err);
  }
}
