import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { currentUser } from "@/lib/owner";
import { removeMember, setMemberRole, workspaceView } from "@/lib/workspaces";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; userId: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await currentUser();
    const { id, userId } = await ctx.params;
    const { role } = z.object({ role: z.enum(["owner", "editor"]) }).parse(await readJson(req));
    return json({ workspace: await workspaceView(await setMemberRole(id, userId, role, user), user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Owners remove members; anyone may remove themselves (leave). */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const user = await currentUser();
    const { id, userId } = await ctx.params;
    return json({ workspace: await workspaceView(await removeMember(id, userId, user), user) });
  } catch (err) {
    return errorResponse(err);
  }
}
