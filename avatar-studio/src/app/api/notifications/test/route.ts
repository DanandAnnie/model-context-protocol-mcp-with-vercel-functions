import { z } from "zod";
import { errorResponse, json } from "@/lib/api-utils";
import { ValidationError } from "@/lib/errors";
import { TEST_EVENTS, sendTestNotification } from "@/lib/notifications";
import { requireEditor } from "@/lib/owner";

export const dynamic = "force-dynamic";

const testSchema = z.object({
  /** `test` (the default) for a ping, or an event to send a marked sample of. */
  event: z.enum(TEST_EVENTS, { error: `event must be ${TEST_EVENTS.join(", ")}, or left out for a test ping` }).optional(),
});

/** Sends a signed test to the saved endpoint (`{ event? }`: a ping, or a sample of an event) and reports the outcome. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    // A bare POST sends the ping, as it always has.
    const text = await req.text();
    let body: unknown = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ValidationError("Request body must be JSON");
      }
    }
    const { event } = testSchema.parse(body);
    const result = await sendTestNotification(owner, event ?? "test");
    if (!result) return json({ error: "Save a webhook URL first" }, { status: 400 });
    return json({ delivery: result });
  } catch (err) {
    return errorResponse(err);
  }
}
