import { config } from "@/lib/config";
import { NotFoundError } from "@/lib/errors";
import { emailPreview } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long a mail client's image proxy (or a CDN) may keep the answer: well inside the renderer link's lifetime. */
const MAX_AGE_SEC = 300;

/**
 * The picture an email shows for a shared video, linked to its share page: a redirect to the renderer's animated GIF of
 * it, or to its cover when there is no GIF or the link asks for an email first. Public under the share page's rules: an
 * offline, password-protected, or unfinished video answers 404. A fixed address, so an email sent today still shows a
 * picture after the renderer's own link has expired.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const preview = await emailPreview(id);
    if (!preview) return notFound();
    return new Response(null, {
      status: 302,
      headers: { Location: new URL(preview.url, config.appUrl).href, "Cache-Control": `public, max-age=${MAX_AGE_SEC}` },
    });
  } catch (err) {
    if (err instanceof NotFoundError) return notFound();
    console.error(`email preview for ${id} failed:`, err);
    return new Response("Preview unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}
