import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { currentUser } from "@/lib/owner";
import { recordActivity } from "@/lib/services";
import { getWorkspace, removeMember, setMemberRole, workspaceView } from "@/lib/workspaces";

/** The member as stored before the change, for the feed: their email when known (else their id) and their role. */
async function memberBefore(id: string, userId: string): Promise<{ label: string; role?: string }> {
  const ws = await getWorkspace(id).catch(() => null);
  const member = ws?.members.find((m) => m.userId === userId);
  return { label: member?.email ?? userId, role: member?.role };
}

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; userId: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await currentUser();
    const { id, userId } = await ctx.params;
    const { role } = z.object({ role: z.enum(["owner", "editor"]) }).parse(await readJson(req));
    const before = await memberBefore(id, userId);
    const ws = await setMemberRole(id, userId, role, user);
    if (before.role !== role) await recordActivity(id, user, "member.role", { subject: before.label, subjectId: userId, role });
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
    const { label } = await memberBefore(id, userId);
    const ws = await removeMember(id, userId, user);
    if (userId === user.id) await recordActivity(id, user, "member.left");
    else await recordActivity(id, user, "member.removed", { subject: label, subjectId: userId });
    return json({ workspace: await workspaceView(ws, user) });
  } catch (err) {
    return errorResponse(err);
  }
}
