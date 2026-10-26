// Video translations and provider webhooks. Used by API routes only.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { timingSafeEqual } from "../auth";
import { cuesToSrt } from "../captions";
import { config } from "../config";
import { ConflictError, NotFoundError } from "../errors";
import { newId, nowIso } from "../ids";
import { getTranslateProvider, getTranslateProviderByName } from "../providers";
import { TRANSLATION_GONE } from "../providers/types";
import { getStore } from "../store";
import { MAX_TRANSLATION_SPEAKERS, TRANSLATION_QUALITIES, type CaptionCue, type Translation } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { owned, stripUndefined } from "./shared";
import { MAX_CAPTION_CUE_CHARS, MAX_CAPTION_CUES } from "./videos";

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
  proofread: z.preprocess(unsetIfNull, z.boolean().optional()),
};
/** The options as stored: the defaults (lip-synced, detected speakers, speed, music kept, speech as recorded) as no field at all. */
const setOptions = (v: { audioOnly?: boolean; speakers?: number; quality?: string; removeMusic?: boolean; enhanceSpeech?: boolean; proofread?: boolean }) => ({
  ...(v.audioOnly ? { audioOnly: true } : {}),
  ...(v.speakers ? { speakers: v.speakers } : {}),
  ...(v.quality === "precision" ? { quality: "precision" as const } : {}),
  ...(v.removeMusic ? { removeMusic: true } : {}),
  ...(v.enhanceSpeech ? { enhanceSpeech: true } : {}),
  ...(v.proofread ? { proofread: true } : {}),
});

/** A job as the browser sees it: the secret in its subtitle link stays on the server. */
function shown(t: Translation): Translation {
  const { proofreadToken: _token, ...rest } = t;
  return rest;
}

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
    if (req.proofread) {
      // The lines are translated first; the dub starts once someone has read them (see dubProofread).
      if (!provider.createProofread) throw new Error(`The ${provider.name} provider cannot proofread a dub first`);
      const { proofreadId } = await provider.createProofread(req);
      base.providerProofreadId = proofreadId;
      base.proofreadStage = "preparing";
    } else {
      const { providerJobId } = await provider.createTranslation(req);
      base.providerJobId = providerJobId;
    }
    base.status = "processing";
  } catch (err) {
    base.status = "failed";
    base.error = err instanceof Error ? err.message : String(err);
  }
  return shown(await getStore().put("translation", base));
}

/** How long a provider's expiring links (presigned video and subtitle URLs) are trusted before they are read again. */
const LINK_TTL_MS = 60 * 60 * 1000;
/** Jobs a listing asks the provider about at once; the rest wait for the next poll. */
const LIST_REFRESHES = 5;
/** The least time between two status reads of one job from listings, however many tabs poll. */
const MIN_CHECK_GAP_MS = 15_000;
/** How old a job must be before the provider having no record of it marks it failed. */
const GONE_AFTER_MS = 30 * 60 * 1000;
/** When each job was last asked about from a listing, in this server instance. */
const lastChecked = new Map<string, number>();

const running = (t: Translation) => t.status === "processing" || t.status === "queued";
function linksExpire(t: Translation): boolean {
  try {
    return !!getTranslateProviderByName(t.provider).linksExpire;
  } catch {
    return false;
  }
}
/** A job to ask the provider about: lines still being translated, a dub still running, or one finished with links that may have expired. */
const due = (t: Translation) =>
  (t.proofreadStage === "preparing" && !!t.providerProofreadId) ||
  (!!t.providerJobId && (running(t) || (t.status === "completed" && Date.now() - Date.parse(t.updatedAt) > LINK_TTL_MS && linksExpire(t))));

/** A proofread whose lines are being translated: stores them once they are ready, or the reason it failed. */
async function refreshProofread(item: Translation): Promise<Translation> {
  const provider = getTranslateProviderByName(item.provider);
  if (!provider.getProofread) return item;
  let result: Awaited<ReturnType<NonNullable<typeof provider.getProofread>>>;
  try {
    result = await provider.getProofread(item.providerProofreadId!, item);
  } catch (err) {
    console.error(`proofread refresh failed for ${item.id}:`, err);
    return item;
  }
  if (result.status === "preparing") return item;
  const current = (await getStore().get<Translation>("translation", item.id)) ?? item;
  if (current.updatedAt !== item.updatedAt || current.proofreadStage !== "preparing") return current;
  if (result.status === "ready" && result.cues.length > MAX_CAPTION_CUES) {
    result = { status: "failed", error: `The video has more than ${MAX_CAPTION_CUES} lines, too many to proofread here` };
  }
  if (result.status === "failed") {
    const { proofreadStage: _stage, ...rest } = current;
    return getStore().put("translation", { ...rest, status: "failed", error: result.error, updatedAt: nowIso() });
  }
  const cues: CaptionCue[] = result.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text: text.slice(0, MAX_CAPTION_CUE_CHARS) }));
  return getStore().put("translation", { ...current, proofreadStage: "ready", proofreadCues: cues, updatedAt: nowIso() });
}

/**
 * Asks the provider for a job's status and stores what changed. The job is read again before the write, so a
 * callback that landed meanwhile is never overwritten; a finished job only takes fresh links.
 */
async function refreshTranslation(item: Translation): Promise<Translation> {
  if (item.proofreadStage === "preparing") return refreshProofread(item);
  let update: Pick<Translation, "status" | "videoUrl" | "error" | "captionUrls">;
  try {
    update = await getTranslateProviderByName(item.provider).getStatus(item.providerJobId!);
  } catch (err) {
    console.error(`translation refresh failed for ${item.id}:`, err);
    if (item.status !== "completed") return item;
    // A finished job whose links could not be renewed waits a full period before the next try, unless another
    // request renewed it meanwhile.
    const current = (await getStore().get<Translation>("translation", item.id)) ?? item;
    return current.updatedAt === item.updatedAt ? getStore().put("translation", { ...current, updatedAt: nowIso() }) : current;
  }
  const current = (await getStore().get<Translation>("translation", item.id)) ?? item;
  if (current.updatedAt !== item.updatedAt) return current;
  if (current.status === "completed" && update.status !== "completed") return current;
  // A job the provider does not know yet may simply be new (or the provider briefly wrong): only an old one is gone.
  if (update.error === TRANSLATION_GONE && Date.now() - Date.parse(current.createdAt) < GONE_AFTER_MS) return current;
  if (running(current) && update.status === current.status) return current;
  const next: Translation = { ...current, ...stripUndefined(update), updatedAt: nowIso() };
  return getStore().put("translation", next);
}

export async function listTranslations(ownerId: string = LOCAL_OWNER): Promise<Translation[]> {
  const items = await getStore().list<Translation>("translation", ownerId);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // The page polls this list, so it moves running jobs on (webhooks or not) and renews expiring links: the jobs
  // asked about longest ago first, each at most every 15 seconds, and a failure leaves the listing as stored.
  const now = Date.now();
  const stale = items
    .filter((t) => due(t) && now - (lastChecked.get(t.id) ?? 0) >= MIN_CHECK_GAP_MS)
    .sort((a, b) => (lastChecked.get(a.id) ?? 0) - (lastChecked.get(b.id) ?? 0))
    .slice(0, LIST_REFRESHES);
  for (const t of stale) lastChecked.set(t.id, now);
  if (lastChecked.size > 10_000) for (const [id, at] of lastChecked) if (now - at > LINK_TTL_MS) lastChecked.delete(id);
  const fresh = await Promise.all(
    stale.map((t) =>
      refreshTranslation(t).catch((err) => {
        console.error(`translation refresh failed for ${t.id}:`, err);
        return t;
      }),
    ),
  );
  const byId = new Map(fresh.map((t) => [t.id, t]));
  return items.map((t) => shown(byId.get(t.id) ?? t));
}

export async function getTranslation(id: string, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const item = owned(await getStore().get<Translation>("translation", id), ownerId, `Translation ${id}`);
  return shown(due(item) ? await refreshTranslation(item) : item);
}

/** How long a dub being started holds its lines before they open again. */
const DUB_CLAIM_MS = 2 * 60 * 1000;

/** Corrected proofread lines: one text per line the provider translated, in order (the timing stays as translated). */
export const proofreadLinesSchema = z.object({
  lines: z
    .array(z.string().trim().min(1, "Every line needs some text").max(MAX_CAPTION_CUE_CHARS))
    .min(1)
    .max(MAX_CAPTION_CUES),
});

/** The job's lines with the corrections applied; refused once the lines are no longer open, or when the count differs. */
function corrected(item: Translation, input?: z.infer<typeof proofreadLinesSchema>): CaptionCue[] {
  // A start that never finished (the server stopped mid-call) frees the lines again after a while.
  const open = item.proofreadStage === "ready" || (item.proofreadStage === "dubbing" && Date.now() - Date.parse(item.updatedAt) > DUB_CLAIM_MS);
  if (!open || !item.proofreadCues?.length) {
    throw new ConflictError(item.proofreadStage === "dubbing" ? "This dub is already being started" : "These lines are not open for corrections");
  }
  if (!input) return item.proofreadCues;
  if (input.lines.length !== item.proofreadCues.length) throw new ConflictError("The lines changed since they were opened; reload and try again");
  return item.proofreadCues.map((c, i) => ({ ...c, text: input.lines[i] }));
}

/** Keeps corrections to a proofread's lines without starting the dub. */
export async function saveProofreadLines(id: string, input: z.infer<typeof proofreadLinesSchema>, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const item = owned(await getStore().get<Translation>("translation", id), ownerId, `Translation ${id}`);
  const cues = corrected(item, input);
  return shown(await getStore().put("translation", { ...item, proofreadCues: cues, updatedAt: nowIso() }));
}

/** Proofreads being handed to the provider in this server instance, so a double click starts one dub. */
const dubbing = new Set<string>();

/**
 * Starts the dub of a proofread, with the corrections when given. The provider reads the lines as an SRT file
 * from this app (a link with a secret of its own), then dubs them; the job is then polled like any other. When
 * the provider refuses, the lines stay open and the job carries the error, so it can be tried again.
 */
export async function dubProofread(id: string, input: z.infer<typeof proofreadLinesSchema> | undefined, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  if (dubbing.has(id)) throw new ConflictError("This dub is already being started");
  dubbing.add(id);
  try {
    const item = owned(await getStore().get<Translation>("translation", id), ownerId, `Translation ${id}`);
    const cues = corrected(item, input);
    const provider = getTranslateProviderByName(item.provider);
    if (!provider.dubProofread || !item.providerProofreadId) throw new ConflictError("This dub cannot be made from proofread lines");
    const claimed = await getStore().put<Translation>("translation", {
      ...item,
      proofreadCues: cues,
      proofreadToken: item.proofreadToken ?? randomBytes(24).toString("base64url"),
      proofreadStage: "dubbing",
      updatedAt: nowIso(),
    });
    const srtUrl = `${config.appUrl.replace(/\/$/, "")}/api/translate/${encodeURIComponent(id)}/srt?token=${claimed.proofreadToken}`;
    try {
      const { providerJobId } = await provider.dubProofread(item.providerProofreadId, srtUrl, cuesToSrt(cues));
      const { proofreadStage: _stage, error: _error, ...rest } = claimed;
      return shown(await getStore().put("translation", { ...rest, providerJobId, status: "processing", updatedAt: nowIso() }));
    } catch (err) {
      console.error(`proofread dub failed for ${id}:`, err);
      const error = `The dub could not be started: ${err instanceof Error ? err.message : String(err)}`;
      return shown(await getStore().put("translation", { ...claimed, proofreadStage: "ready", error, updatedAt: nowIso() }));
    }
  } finally {
    dubbing.delete(id);
  }
}

/** The proofread lines as an SRT file, for the provider to read; only with the job's secret. */
export async function proofreadSrt(id: string, token: string): Promise<string> {
  const item = await getStore().get<Translation>("translation", id);
  if (!item?.proofreadToken || !item.proofreadCues?.length || !timingSafeEqual(token, item.proofreadToken)) throw new NotFoundError("Not found");
  return cuesToSrt(item.proofreadCues);
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
  // A late or repeated callback never undoes a finished job.
  if (item.status === "completed" || (item.status === "failed" && parsed.update.status === "failed")) return item;
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
