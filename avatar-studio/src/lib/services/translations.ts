// Video translations and provider webhooks. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getTranslateProvider, getTranslateProviderByName } from "../providers";
import { getStore } from "../store";
import { MAX_TRANSLATION_SPEAKERS, TRANSLATION_QUALITIES, type Translation } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { owned, stripUndefined } from "./shared";

const languageSchema = z.string().trim().min(2).max(40);
/** How a dub is made: voice only or lip-synced, how many people speak, its quality, and its audio. */
/** `null` reads as "not set" (lip-synced, speakers detected), as an API client may send for an empty field. */
const unsetIfNull = (v: unknown) => (v === null ? undefined : v);
const dubOptions = {
  audioOnly: z.preprocess(unsetIfNull, z.boolean().optional()),
  speakers: z.preprocess(unsetIfNull, z.number().int().min(1).max(MAX_TRANSLATION_SPEAKERS).optional()),
  quality: z.preprocess(unsetIfNull, z.enum(TRANSLATION_QUALITIES).optional()),
  removeMusic: z.preprocess(unsetIfNull, z.boolean().optional()),
  enhanceSpeech: z.preprocess(unsetIfNull, z.boolean().optional()),
};
/** The options as stored: the defaults (lip-synced, detected speakers, speed, music kept, speech as recorded) as no field at all. */
const setOptions = (v: { audioOnly?: boolean; speakers?: number; quality?: string; removeMusic?: boolean; enhanceSpeech?: boolean }) => ({
  ...(v.audioOnly ? { audioOnly: true } : {}),
  ...(v.speakers ? { speakers: v.speakers } : {}),
  ...(v.quality === "precision" ? { quality: "precision" as const } : {}),
  ...(v.removeMusic ? { removeMusic: true } : {}),
  ...(v.enhanceSpeech ? { enhanceSpeech: true } : {}),
});

export const translationRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  sourceVideoUrl: z.string().url(),
  targetLanguage: languageSchema,
  ...dubOptions,
});

/** How many languages one request may dub a video into. */
export const MAX_TRANSLATION_LANGUAGES = 5;

/**
 * One video into several languages at once: `targetLanguages` (1 to 5, repeats ignored without regard
 * to case) or, as before, a single `targetLanguage`.
 */
export const translationBatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    sourceVideoUrl: z.string().url(),
    targetLanguage: languageSchema.optional(),
    targetLanguages: z.array(languageSchema).min(1).max(MAX_TRANSLATION_LANGUAGES).optional(),
    ...dubOptions,
  })
  .transform((v, ctx) => {
    const all = v.targetLanguages ?? (v.targetLanguage ? [v.targetLanguage] : []);
    const seen = new Set<string>();
    const languages = all.filter((l) => !seen.has(l.toLowerCase()) && !!seen.add(l.toLowerCase()));
    if (!languages.length) {
      ctx.addIssue({ code: "custom", path: ["targetLanguages"], message: "Pick at least one language" });
      return z.NEVER;
    }
    return { title: v.title, sourceVideoUrl: v.sourceVideoUrl, languages, ...setOptions(v) };
  });

/**
 * Starts one dubbing job per language, one after another. With several languages each job's title
 * names its language, so the list tells them apart; a job the provider refuses is kept as failed
 * and the rest still start.
 */
export async function createTranslations(input: z.infer<typeof translationBatchSchema>, ownerId: string = LOCAL_OWNER): Promise<Translation[]> {
  const out: Translation[] = [];
  for (const language of input.languages) {
    const title = input.languages.length > 1 ? `${input.title} (${language})`.slice(0, 160) : input.title;
    out.push(await createTranslation({ title, sourceVideoUrl: input.sourceVideoUrl, targetLanguage: language, ...setOptions(input) }, ownerId));
  }
  return out;
}

export async function createTranslation(req: z.infer<typeof translationRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const provider = getTranslateProvider();
  const base: Translation = {
    // Default options (a lip-synced dub at speed, music and speech as recorded) are stored as no field at all.
    title: req.title,
    sourceVideoUrl: req.sourceVideoUrl,
    targetLanguage: req.targetLanguage,
    ...setOptions(req),
    id: newId("tr"),
    ownerId,
    status: "queued",
    provider: provider.name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  try {
    const { providerJobId } = await provider.createTranslation(req);
    base.providerJobId = providerJobId;
    base.status = "processing";
  } catch (err) {
    base.status = "failed";
    base.error = err instanceof Error ? err.message : String(err);
  }
  return getStore().put("translation", base);
}

export async function listTranslations(ownerId: string = LOCAL_OWNER): Promise<Translation[]> {
  const items = await getStore().list<Translation>("translation", ownerId);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

export async function getTranslation(id: string, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const item = owned(await getStore().get<Translation>("translation", id), ownerId, `Translation ${id}`);
  if (!item.providerJobId || (item.status !== "processing" && item.status !== "queued")) return item;
  try {
    const update = await getTranslateProviderByName(item.provider).getStatus(item.providerJobId);
    const next: Translation = { ...item, ...stripUndefined(update), updatedAt: nowIso() };
    if (next.status !== item.status) await getStore().put("translation", next);
    return next;
  } catch (err) {
    console.error(`translation refresh failed for ${id}:`, err);
    return item;
  }
}

export function supportedLanguages(): string[] {
  return getTranslateProvider().supportedLanguages();
}

export async function applyTranslationWebhook(providerName: string, body: unknown): Promise<Translation | null> {
  const provider = getTranslateProviderByName(providerName);
  const parsed = provider.parseWebhook?.(body);
  if (!parsed) return null;
  const item = await getStore().findBy<Translation>("translation", "providerJobId", parsed.providerJobId);
  if (!item) return null;
  let update: Partial<Translation> = parsed.update;
  // A completion callback carries the video only; the job's status also has its subtitle files.
  if (update.status === "completed") {
    try {
      const status = await provider.getStatus(parsed.providerJobId);
      if (status.status === "completed") update = { ...update, ...stripUndefined(status) };
    } catch (err) {
      console.error(`translation status after webhook failed for ${item.id}:`, err);
    }
  }
  const next: Translation = { ...item, ...stripUndefined(update), updatedAt: nowIso() };
  return getStore().put("translation", next);
}
