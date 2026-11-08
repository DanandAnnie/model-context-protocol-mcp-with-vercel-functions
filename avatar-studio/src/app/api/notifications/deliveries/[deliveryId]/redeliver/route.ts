import { errorResponse, json } from "@/lib/api-utils";
import { redeliverNotification } from "@/lib/notifications";
import { requireEditor } from "@/lib/owner";

export const dynamic = "force-dynamic";

/** Sends a logged webhook delivery again, signed afresh, and reports the new attempt (editors only). */
export async function POST(_req: Request, { params }: { params: Promise<{ deliveryId: string }> }) {
  try {
    const owner = await requireEditor();
    const { deliveryId } = await params;
    return json({ delivery: await redeliverNotification(deliveryId, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
