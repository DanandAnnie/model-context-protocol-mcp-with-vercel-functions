import { errorResponse, json, readJson } from "@/lib/api-utils";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { deleteNotifySettings, getNotifySettings, notifySchema, publicDelivery, saveNotifySettings } from "@/lib/notifications";
import type { NotifySettings } from "@/lib/types";
import { requireEditor, requireOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

/** The webhook as the API shows it: its delivery log without the bodies sent, which stay on the server for redelivery. */
function shown(webhook: NotifySettings) {
  return { ...webhook, deliveries: (webhook.deliveries ?? []).map(publicDelivery) };
}

/** The workspace's webhook; a viewer sees where it goes but not the signing secret, which would let them forge deliveries. */
export async function GET() {
  try {
    const owner = await requireOwner();
    const editor = await requireEditor().then(
      () => true,
      (e) => (e instanceof ForbiddenError ? false : Promise.reject(e)),
    );
    const webhook = await getNotifySettings(owner);
    if (webhook && !editor) {
      const { secret: _secret, ...rest } = shown(webhook);
      return json({ webhook: rest });
    }
    return json({ webhook: webhook && shown(webhook) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const owner = await requireEditor();
    const input = notifySchema.parse(await readJson(req));
    try {
      return json({ webhook: shown(await saveNotifySettings(input, owner)) });
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Webhook URL is not valid");
    }
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    await deleteNotifySettings(await requireEditor());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
