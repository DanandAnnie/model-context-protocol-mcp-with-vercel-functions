import { z } from "zod";
import { errorResponse, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { previewVoice } from "@/lib/services";

export const dynamic = "force-dynamic";

const schema = z.object({
  voiceId: z.string().min(1),
  text: z.string().trim().min(1).max(600),
  speed: z.number().min(0.5).max(1.5).default(1),
});

/**
 * Returns synthesized audio bytes. In demo mode (or for providers without
 * standalone TTS) responds 204 with `x-tts-fallback: browser` so the client
 * uses the Web Speech API instead.
 */
export async function POST(req: Request) {
  try {
    await requireOwner();
    const { voiceId, text, speed } = schema.parse(await readJson(req));
    const result = await previewVoice(voiceId, text, speed);
    if (!result) return new Response(null, { status: 204, headers: { "x-tts-fallback": "browser" } });
    return new Response(result.audio as BodyInit, {
      status: 200,
      headers: { "Content-Type": result.mimeType, "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
