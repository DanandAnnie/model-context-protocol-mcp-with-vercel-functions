import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { startersSchema, suggestStarters } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Opening questions suggested for a presenter from its instructions and notes: `{ starters }`. Nothing is saved. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    return json({ starters: await suggestStarters(startersSchema.parse(await readJson(req)), owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
