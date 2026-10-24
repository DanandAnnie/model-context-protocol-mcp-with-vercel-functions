import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { createTemplate, listTemplates, templateInputSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ templates: await listTemplates(await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = templateInputSchema.parse(await readJson(req));
    return json({ template: await createTemplate(input, owner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
