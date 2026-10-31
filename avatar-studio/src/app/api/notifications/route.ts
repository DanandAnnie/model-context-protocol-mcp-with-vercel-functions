import { errorResponse, json, readJson } from "@/lib/api-utils";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { deleteNotifySettings, getNotifySettings, notifySchema, saveNotifySettings } from "@/lib/notifications";
import { requireEditor, requireOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

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
      const { secret: _secret, ...shown } = webhook;
      return json({ webhook: shown });
    }
    return json({ webhook });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const owner = await requireEditor();
    const input = notifySchema.parse(await readJson(req));
    try {
      return json({ webhook: await saveNotifySettings(input, owner) });
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
