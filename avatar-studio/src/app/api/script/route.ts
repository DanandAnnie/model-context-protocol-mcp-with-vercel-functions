import { errorResponse, json, readJson } from "@/lib/api-utils";
import { generateScript, scriptSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const input = scriptSchema.parse(await readJson(req));
    return json({ script: await generateScript(input) });
  } catch (err) {
    return errorResponse(err);
  }
}
