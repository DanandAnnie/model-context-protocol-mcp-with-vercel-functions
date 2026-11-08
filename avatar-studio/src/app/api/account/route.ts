import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { presentedApiKey, requireAccountOwner } from "@/lib/owner";
import { deleteOwnerData } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Deletes every record of the active account or workspace. Requires `{ "confirm": "DELETE" }`, a session, and the owner role in a workspace. */
export async function DELETE(req: Request) {
  try {
    if (await presentedApiKey()) return json({ error: "Sign in to delete data" }, { status: 403 });
    const owner = await requireAccountOwner();
    const { confirm } = z.object({ confirm: z.string() }).parse(await readJson(req));
    if (confirm !== "DELETE") return json({ error: 'Type DELETE to confirm' }, { status: 400 });
    return json({ deleted: await deleteOwnerData(owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
