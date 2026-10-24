import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { agentSchema, createAgent, listAgents, recordActivity } from "@/lib/services";

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
    const owner = await requireOwner();
    const input = agentSchema.parse(await readJson(req));
    const agent = await createAgent(input, owner);
    await recordActivity(owner, await userOrOwner(owner), "agent.created", { subject: agent.name, subjectId: agent.id });
    return json({ agent }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
