import { errorResponse, json } from "@/lib/api-utils";
import { sendTestNotification } from "@/lib/notifications";
import { requireOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

/** Sends a signed "test" event to the saved endpoint and reports the outcome. */
export async function POST() {
  try {
    const result = await sendTestNotification(await requireOwner());
    if (!result) return json({ error: "Save a webhook URL first" }, { status: 400 });
    return json({ delivery: result });
  } catch (err) {
    return errorResponse(err);
  }
}
