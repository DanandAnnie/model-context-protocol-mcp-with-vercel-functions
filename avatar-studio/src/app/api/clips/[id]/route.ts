import { errorResponse, json, readJson } from "@/lib/api-utils";
import { attachmentDisposition } from "@/lib/attachment";
import { requireEditor, requireOwner } from "@/lib/owner";
import { clipEditSchema, deleteClip, editClip, getClipAudio } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The clip's audio, for playback in the editor, or saved under its name with `?download`. Owner only; never cached by shared caches. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const audio = await getClipAudio(id, await requireOwner());
    // `?download` saves the file under its name instead of playing it in the page. That name can change, so a
    // download is checked again every time rather than served from the browser's cache under an old name.
    const download = new URL(req.url).searchParams.has("download");
    return new Response(audio.bytes as BodyInit, {
      headers: {
        "Content-Type": audio.mimeType,
        "Content-Length": String(audio.bytes.byteLength),
        "Cache-Control": download ? "private, no-cache" : "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        ...(download ? { "Content-Disposition": attachmentDisposition(audio.name, audio.mimeType, "clip") } : {}),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Rename a clip or set the words it says: `{ name?, transcript? }` (`transcript: null` or blank forgets them) → `{ clip }`. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const owner = await requireEditor();
    const input = clipEditSchema.parse(await readJson(req));
    return json({ clip: await editClip((await ctx.params).id, input, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Delete a clip and its audio. Rendered videos keep their footage. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await deleteClip((await ctx.params).id, await requireEditor());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
