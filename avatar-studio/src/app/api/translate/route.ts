import { errorResponse, json, readJson } from "@/lib/api-utils";
import { createTranslation, listTranslations, supportedLanguages, translationRequestSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return json({ translations: await listTranslations(), languages: supportedLanguages() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const input = translationRequestSchema.parse(await readJson(req));
    const translation = await createTranslation(input);
    return json({ translation }, { status: translation.status === "failed" ? 502 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
