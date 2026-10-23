import { NextResponse } from "next/server";
import { errorResponse, json } from "@/lib/api-utils";
import { currentUser } from "@/lib/owner";
import { WORKSPACE_COOKIE, acceptInvite, findInvite, workspaceView } from "@/lib/workspaces";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string }> };

/** Describes the invite (workspace name, role) so the join page can ask before joining. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    await currentUser();
    const found = await findInvite((await ctx.params).token);
    if (!found) return json({ error: "This invite link is invalid or has expired" }, { status: 404 });
    return json({ workspace: { id: found.workspace.id, name: found.workspace.name, members: found.workspace.members.length }, role: found.invite.role });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Joins the workspace and makes it active. */
export async function POST(_req: Request, ctx: Ctx) {
  try {
    const user = await currentUser();
    const ws = await acceptInvite((await ctx.params).token, user);
    const res = NextResponse.json({ workspace: await workspaceView(ws, user) });
    res.cookies.set(WORKSPACE_COOKIE, ws.id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
