import { z } from "zod";
import { NextResponse } from "next/server";
import { errorResponse, readJson } from "@/lib/api-utils";
import { NotFoundError } from "@/lib/errors";
import { currentUser } from "@/lib/owner";
import { WORKSPACE_COOKIE, isWorkspaceId, workspaceForMember } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/** Sets the active owner: a workspace id the user belongs to, or their personal id to clear it. */
export async function POST(req: Request) {
  try {
    const user = await currentUser();
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(await readJson(req));
    const res = NextResponse.json({ activeId: isWorkspaceId(id) ? id : user.id });
    if (isWorkspaceId(id)) {
      if (!(await workspaceForMember(id, user.id))) throw new NotFoundError("Workspace not found");
      res.cookies.set(WORKSPACE_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
    } else {
      res.cookies.set(WORKSPACE_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    }
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
