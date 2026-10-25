import { errorResponse, json, readJson } from "@/lib/api-utils";
import { publicOrigin } from "@/lib/config";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor, requireOwner } from "@/lib/owner";
import { agentSchema, createAgent, listAgents } from "@/lib/services";

export const dynamic = "force-dynamic";
/** Creating or editing may read a knowledge page (10 s fetch budget). */
export const maxDuration = 60;

/** The owner's shared presenters, plus the origin their public links are built on (see `publicOrigin`). */
export async function GET(req: Request) {
  try {
    return json({ agents: await listAgents(await requireOwner()), shareOrigin: publicOrigin(req) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = agentSchema.parse(await readJson(req));
    const agent = await createAgent(input, owner);
    await recordRequestActivity(owner, "agent.created", { subject: agent.name, subjectId: agent.id });
    return json({ agent }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
