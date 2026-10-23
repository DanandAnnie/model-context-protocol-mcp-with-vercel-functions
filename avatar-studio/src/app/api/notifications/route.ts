import { errorResponse, json, readJson } from "@/lib/api-utils";
import { ValidationError } from "@/lib/errors";
import { deleteNotifySettings, getNotifySettings, notifySchema, saveNotifySettings } from "@/lib/notifications";
import { requireOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ webhook: await getNotifySettings(await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const owner = await requireOwner();
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
    await deleteNotifySettings(await requireOwner());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
