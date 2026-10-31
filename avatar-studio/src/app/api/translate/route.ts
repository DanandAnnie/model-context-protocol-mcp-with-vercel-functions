import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { createTranslations, listTranslations, supportedLanguages, translationBatchSchema } from "@/lib/services";

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
    const body = await readJson(req);
    const input = translationBatchSchema.parse(body);
    const translations = await createTranslations(input, owner);
    const failed = translations.filter((t) => t.status === "failed");
    // A request naming `targetLanguages` gets the list; the single-language form keeps its `{ translation }` shape.
    const many = !!body && typeof body === "object" && "targetLanguages" in body;
    const payload = many ? { translations } : { translation: translations[0] };
    if (failed.length === translations.length) return json({ ...payload, error: failed[0].error ?? "The translation could not be started" }, { status: 502 });
    return json(failed.length ? { ...payload, error: `${failed.length} of ${translations.length} translations could not be started` } : payload, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
