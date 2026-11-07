import { z } from "zod";
import { errorResponse, json } from "@/lib/api-utils";
import { ValidationError } from "@/lib/errors";
import { publicNotifySettings, retirePreviousSecret, rotateNotifySecret } from "@/lib/notifications";
import { requireEditor } from "@/lib/owner";

export const dynamic = "force-dynamic";

const rotateSchema = z.object({
  /** Keep the old secret signing `X-Studio-Signature-Previous` for 24 hours (the default), or stop it at once. */
  keepPrevious: z.boolean().optional(),
});

/** Gives the webhook a new signing secret (`{ keepPrevious? }`); editors only. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    // A bare POST rotates with the overlap, so `curl -X POST` is enough.
    const text = await req.text();
    let body: unknown = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ValidationError("Request body must be JSON");
      }
    }
    const { keepPrevious } = rotateSchema.parse(body);
    return json({ webhook: publicNotifySettings(await rotateNotifySecret(owner, keepPrevious ?? true)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Stops signing with the previous secret before its 24 hours are up; editors only. */
export async function DELETE() {
  try {
    return json({ webhook: publicNotifySettings(await retirePreviousSecret(await requireEditor())) });
  } catch (err) {
    return errorResponse(err);
  }
}
