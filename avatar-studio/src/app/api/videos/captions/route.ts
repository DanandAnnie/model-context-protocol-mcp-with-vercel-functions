import { strToU8, zipSync } from "fflate";
import { errorResponse, readJson } from "@/lib/api-utils";
import { ConflictError } from "@/lib/errors";
import { requireOwner } from "@/lib/owner";
import { selectionCaptionFiles, selectionLinksSchema, selectionVideos } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * The captions of the library's selected videos (`{ "ids": [...] }`, up to 200) as a zip of one SRT file each, or
 * WebVTT with `?format=vtt`, named after the videos, for uploading with the videos elsewhere; refused when none of them
 * has captions (still rendering, failed, or with no script of its own, as a cinematic shot or a HeyGen-directed video).
 */
export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const { ids } = selectionLinksSchema.parse(await readJson(req));
    const videos = await selectionVideos(ids, owner);
    // Ids left out (trashed or deleted since the page loaded, another owner's, unknown), so the page can say so.
    const omitted = new Set(ids).size - videos.length;
    const vtt = new URL(req.url).searchParams.get("format") === "vtt";
    const { files, missing } = selectionCaptionFiles(videos, vtt);
    if (!files.length) throw new ConflictError("None of the selected videos has captions: a video has them once it has rendered, if it has a script of its own (a cinematic shot or a HeyGen-directed video has none).");
    const zip = zipSync(Object.fromEntries(files.map((f) => [f.name, strToU8(f.text)])));
    return new Response(zip, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="captions-${new Date().toISOString().slice(0, 10)}.zip"`,
        "Cache-Control": "no-store",
        "X-Files": String(files.length),
        "X-Omitted": String(omitted),
        "X-Missing": String(missing),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
