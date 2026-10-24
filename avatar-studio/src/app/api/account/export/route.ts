import { errorResponse } from "@/lib/api-utils";
import { presentedApiKey, requireOwner } from "@/lib/owner";
import { exportOwnerData } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Downloads everything stored for the active account or workspace as JSON. Session only. */
export async function GET() {
  try {
    if (await presentedApiKey()) return new Response(JSON.stringify({ error: "Sign in to export data" }), { status: 403, headers: { "Content-Type": "application/json" } });
    const owner = await requireOwner();
    const data = await exportOwnerData(owner);
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
