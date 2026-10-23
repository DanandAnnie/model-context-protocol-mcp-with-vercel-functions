import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { addSubtitles, removeSubtitles, subtitleSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
/** A translation runs through the script provider. */
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

/** Translates the script into `language` and keeps it as a subtitle track. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const owner = await requireOwner();
    const { language } = subtitleSchema.parse(await readJson(req));
    return json({ video: await addSubtitles((await ctx.params).id, language, owner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Removes the track for `?language=`. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const owner = await requireOwner();
    const { language } = subtitleSchema.parse({ language: new URL(req.url).searchParams.get("language") ?? "" });
    return json({ video: await removeSubtitles((await ctx.params).id, language, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
