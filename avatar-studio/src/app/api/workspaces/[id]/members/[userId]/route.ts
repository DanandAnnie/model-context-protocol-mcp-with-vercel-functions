import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { currentUser } from "@/lib/owner";
import { recordActivity } from "@/lib/services";
import { getWorkspace, removeMember, setMemberRole, workspaceView } from "@/lib/workspaces";

/** How the feed names a member: their email when known, else their id. */
async function memberLabel(id: string, userId: string): Promise<string> {
  const ws = await getWorkspace(id).catch(() => null);
  return ws?.members.find((m) => m.userId === userId)?.email ?? userId;
}

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; userId: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await currentUser();
    const { id, userId } = await ctx.params;
    const { role } = z.object({ role: z.enum(["owner", "editor"]) }).parse(await readJson(req));
    const subject = await memberLabel(id, userId);
    const ws = await setMemberRole(id, userId, role, user);
    await recordActivity(id, user, "member.role", { subject, subjectId: userId, role });
    return json({ workspace: await workspaceView(ws, user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Owners remove members; anyone may remove themselves (leave). */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const user = await currentUser();
    const { id, userId } = await ctx.params;
    const subject = await memberLabel(id, userId);
    const ws = await removeMember(id, userId, user);
    if (userId === user.id) await recordActivity(id, user, "member.left");
    else await recordActivity(id, user, "member.removed", { subject, subjectId: userId });
    return json({ workspace: await workspaceView(ws, user) });
  } catch (err) {
    return errorResponse(err);
  }
}
