import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor, requireOwner } from "@/lib/owner";
import { agentSchema, createAgent, listAgents } from "@/lib/services";

export const dynamic = "force-dynamic";
/** Creating or editing may read a knowledge page (10 s fetch budget). */
export const maxDuration = 60;

export async function GET() {
  try {
    return json({ agents: await listAgents(await requireOwner()) });
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
