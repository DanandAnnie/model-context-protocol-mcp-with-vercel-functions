import { errorResponse, json, readJson } from "@/lib/api-utils";
import { currentUser } from "@/lib/owner";
import { deleteWorkspace, getWorkspace, memberOf, renameWorkspace, workspaceNameSchema, workspaceView } from "@/lib/workspaces";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const user = await currentUser();
    const ws = await getWorkspace((await ctx.params).id);
    if (!memberOf(ws, user.id)) throw new NotFoundError("Workspace not found");
    return json({ workspace: await workspaceView(ws, user) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await currentUser();
    const { name } = workspaceNameSchema.parse(await readJson(req));
    return json({ workspace: await workspaceView(await renameWorkspace((await ctx.params).id, name, user), user) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await deleteWorkspace((await ctx.params).id, await currentUser());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
