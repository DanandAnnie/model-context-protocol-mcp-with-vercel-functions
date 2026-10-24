import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { createTranslation, listTranslations, supportedLanguages, translationRequestSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return json({ translations: await listTranslations(await requireOwner()), languages: supportedLanguages() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = translationRequestSchema.parse(await readJson(req));
    const translation = await createTranslation(input, owner);
    if (translation.status === "failed") return json({ translation, error: translation.error ?? "The translation could not be started" }, { status: 502 });
    return json({ translation }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
