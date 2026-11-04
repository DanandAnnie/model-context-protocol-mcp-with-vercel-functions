import { errorResponse } from "@/lib/api-utils";
import { currentUser, presentedApiKey, requireOwner } from "@/lib/owner";
import { exportOwnerData } from "@/lib/services";
import { seesInviteAddresses } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/** Downloads everything stored for the active account or workspace as JSON. Session only. */
export async function GET() {
  try {
    if (await presentedApiKey()) return new Response(JSON.stringify({ error: "Sign in to export data" }), { status: 403, headers: { "Content-Type": "application/json" } });
    const owner = await requireOwner();
    // Any member may export the workspace; pending invitees' addresses in its activity stay for owners, as in the feed.
    const data = await exportOwnerData(owner, { inviteAddresses: await seesInviteAddresses(owner, (await currentUser()).id) });
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="avatar-studio-export-${owner.replace(/[^\w.-]+/g, "_")}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
