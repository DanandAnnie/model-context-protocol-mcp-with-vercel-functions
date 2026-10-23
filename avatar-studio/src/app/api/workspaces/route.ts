import { errorResponse, json, readJson } from "@/lib/api-utils";
import { activeWorkspaceId, currentUser } from "@/lib/owner";
import { createWorkspace, listWorkspaces, workspaceNameSchema, workspaceView } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/** The user's workspaces plus which owner id is active right now. */
export async function GET() {
  try {
    const user = await currentUser();
    const [workspaces, active] = await Promise.all([listWorkspaces(user.id), activeWorkspaceId(user)]);
    return json({ personalId: user.id, activeId: active ?? user.id, workspaces: workspaces.map((w) => workspaceView(w, user)) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await currentUser();
    const { name } = workspaceNameSchema.parse(await readJson(req));
    return json({ workspace: workspaceView(await createWorkspace(name, user), user) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
