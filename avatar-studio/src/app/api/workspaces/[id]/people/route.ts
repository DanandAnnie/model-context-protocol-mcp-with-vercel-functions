import { errorResponse, json } from "@/lib/api-utils";
import { toCsv } from "@/lib/csv";
import { NotFoundError } from "@/lib/errors";
import { PEOPLE_CSV_COLUMNS, peopleRows } from "@/lib/invite-text";
import { currentUser, presentedApiKey } from "@/lib/owner";
import { lastActiveByActor } from "@/lib/services";
import { getWorkspace, memberOf, workspaceView } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/**
 * The workspace's people as CSV, for records: every member (role, joined, last active) for any member, and its
 * pending and recently expired invites for owners only, as the Workspace page shows them. Session only.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    // A key is not a person who can be an owner, so it gets no file (as with the data export) rather than one guessed.
    if (await presentedApiKey()) return json({ error: "Sign in to download the people list" }, { status: 403 });
    const user = await currentUser();
    const ws = await getWorkspace((await ctx.params).id);
    if (!memberOf(ws, user.id)) throw new NotFoundError("Workspace not found");
    const view = await workspaceView(ws, user);
    const day = new Date().toISOString().slice(0, 10);
    const slug = ws.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
    return new Response(toCsv(PEOPLE_CSV_COLUMNS, peopleRows(view, await lastActiveByActor(ws.id))), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="people-${slug}-${day}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
