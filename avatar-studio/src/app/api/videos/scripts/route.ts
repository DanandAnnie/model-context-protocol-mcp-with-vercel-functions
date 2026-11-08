import { strToU8, zipSync } from "fflate";
import { errorResponse, readJson } from "@/lib/api-utils";
import { ConflictError } from "@/lib/errors";
import { requireOwner } from "@/lib/owner";
import { selectionLinksSchema, selectionScriptFiles, selectionVideos } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * The scripts of the library's selected videos (`{ "ids": [...] }`, up to 200) as a zip of one text file each, named
 * after the videos, as the editor's Download script writes them, so Import script reads each back scene for scene;
 * refused when none of them has a script to save (a cinematic shot, a HeyGen-directed video, or a render of a HeyGen
 * studio template has none of its own, nor does a video with no words).
 */
export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const { ids } = selectionLinksSchema.parse(await readJson(req));
    const videos = await selectionVideos(ids, owner);
    // Ids left out (trashed or deleted since the page loaded, another owner's, unknown), so the page can say so.
    const omitted = new Set(ids).size - videos.length;
    const { files, missing } = selectionScriptFiles(videos);
    if (!files.length) throw new ConflictError("None of the selected videos has a script to save: a cinematic shot, a HeyGen-directed video, or a render of a HeyGen studio template has none of its own, nor does a video with no words.");
    const zip = zipSync(Object.fromEntries(files.map((f) => [f.name, strToU8(f.text)])));
    return new Response(zip, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="scripts-${new Date().toISOString().slice(0, 10)}.zip"`,
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
