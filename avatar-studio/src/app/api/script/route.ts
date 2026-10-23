import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { generateScript, reviseSchema, reviseScript, scriptSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Body with `action` revises an existing script; otherwise it writes a new one from a topic. */
export async function POST(req: Request) {
  try {
    await requireOwner();
    const body = (await readJson(req)) as { action?: unknown };
    if (body && typeof body === "object" && "action" in body) {
      const input = reviseSchema.parse(body);
      return json({ script: await reviseScript(input) });
    }
    const input = scriptSchema.parse(body);
    return json({ script: await generateScript(input) });
  } catch (err) {
    return errorResponse(err);
  }
}
