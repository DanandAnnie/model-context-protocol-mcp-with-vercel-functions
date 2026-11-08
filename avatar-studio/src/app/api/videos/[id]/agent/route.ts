import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { LimitError, agentAnswerSchema, agentConversation, answerAgent } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The page asks every few seconds while the agent works; answers are a person's typing. Per account, per server instance. */
const LOOKS_PER_OWNER = 1500;
const ANSWERS_PER_OWNER = 60;
const WINDOW_MS = 60 * 60 * 1000;

type Ctx = { params: Promise<{ id: string }> };

/** The conversation with the agent of a directed video under review, and whether it waits for an answer. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const limit = rateLimit(`agentlook:${owner}`, LOOKS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) throw new LimitError(`Too many checks for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    return json(await agentConversation(id, owner));
  } catch (err) {
    return errorResponse(err);
  }
}

/** An answer to the agent: feedback on its storyboard, or the go-ahead to render (editors only). */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireEditor();
    const { text } = agentAnswerSchema.parse(await readJson(req));
    const limit = rateLimit(`agentanswer:${owner}`, ANSWERS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) throw new LimitError(`Too many answers for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    return json({ video: await answerAgent(id, text, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
