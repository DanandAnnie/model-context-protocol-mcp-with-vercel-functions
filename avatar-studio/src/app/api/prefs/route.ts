import { errorResponse, json, readJson } from "@/lib/api-utils";
import { getPrefs, prefsSchema, savePrefs } from "@/lib/notifications";
import { currentUser, requireEditor, requireOwner } from "@/lib/owner";
import { getEmailProvider } from "@/lib/providers/email";

export const dynamic = "force-dynamic";

/** Per-owner preferences plus the signed-in email as a suggestion and whether email can be delivered. */
export async function GET() {
  try {
    const owner = await requireOwner();
    const user = await currentUser().catch(() => null);
    return json({ prefs: await getPrefs(owner), suggestedEmail: user?.email ?? null, emailDelivers: getEmailProvider().delivers });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Preferences are the workspace's (the render email, starred avatars and voices): viewers cannot change them. */
export async function PUT(req: Request) {
  try {
    const owner = await requireEditor();
    return json({ prefs: await savePrefs(prefsSchema.parse(await readJson(req)), owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
