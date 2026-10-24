import { listApiKeys, revokeApiKey } from "@/lib/api-keys";
import { errorResponse, json } from "@/lib/api-utils";
import { currentUser, presentedApiKey, requireEditor } from "@/lib/owner";
import { recordActivity } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Revokes a key. Like creation, this needs a signed-in session rather than a key. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (await presentedApiKey()) return json({ error: "Sign in to revoke API keys" }, { status: 403 });
    const { id } = await ctx.params;
    const [owner, user] = await Promise.all([requireEditor(), currentUser()]);
    const name = (await listApiKeys(owner)).find((k) => k.id === id)?.name;
    const ok = await revokeApiKey(id, owner);
    if (ok) await recordActivity(owner, user, "apikey.revoked", { subject: name, subjectId: id });
    return ok ? new Response(null, { status: 204 }) : json({ error: "Key not found" }, { status: 404 });
  } catch (err) {
    return errorResponse(err);
  }
}
