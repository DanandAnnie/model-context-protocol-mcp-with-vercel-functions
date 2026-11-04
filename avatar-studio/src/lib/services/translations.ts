// Video translations and provider webhooks. Used by API routes only.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { timingSafeEqual } from "../auth";
import { cuesToSrt } from "../captions";
import { config } from "../config";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { newId, nowIso } from "../ids";
import { getTranslateProvider, getTranslateProviderByName } from "../providers";
import { TRANSLATION_GONE } from "../providers/types";
import { getStore } from "../store";
import { MAX_TRANSLATION_SPEAKERS, TRANSLATION_QUALITIES, type CaptionCue, type Translation } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { owned, stripUndefined } from "./shared";
import { MAX_CAPTION_CUE_CHARS, MAX_CAPTION_CUES } from "./videos";
import { getBrandKit } from "./brand";
import { foldTerm, forcedFor } from "../glossary";

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
  /** Keep the brand kit's glossary terms exactly as written in the dub. */
  keepGlossary: z.preprocess(unsetIfNull, z.boolean().optional()),
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

/** How long a dub being started holds its lines before they open again. */
const DUB_CLAIM_MS = 2 * 60 * 1000;
/** A dub whose start never finished (the server stopped, or the provider never answered). */
const stuck = (t: Translation) => t.proofreadStage === "dubbing" && Date.now() - Date.parse(t.updatedAt) > DUB_CLAIM_MS;

/**
 * A job as the browser sees it: the secret in its subtitle link stays on the server, and a dub whose start never
 * finished shows its lines again, saying so.
 */
function shown(t: Translation): Translation {
  const { proofreadToken: _token, ...rest } = t;
  if (stuck(t)) return { ...rest, proofreadStage: "ready", error: "Starting the dub did not finish. Check that it is not already in your HeyGen account, then try again." };
  return rest;
}

/** A write time strictly after `prev`, so a conditional write on `updatedAt` never matches a record written in the same millisecond. */
const after = (prev: string) => new Date(Math.max(Date.now(), Date.parse(prev) + 1)).toISOString();

/** Where the provider reads a proofread's lines: the configured public address (demo mode makes do with the app's own). */
function proofreadSrtUrl(id: string, token: string, provider: string): string {
  const origin = config.publicAppUrl ?? (provider === "mock" ? config.appUrl.replace(/\/$/, "") : undefined);
  if (!origin) throw new ValidationError("Proofread dubs need APP_URL set to this app's public address, so the dubbing provider can read the corrected lines");
  return `${origin}/api/translate/${encodeURIComponent(id)}/srt?token=${token}`;
}

/** Refuses a proofread the provider could never finish: it reads the corrected lines from this app's public address. */
function assertProofreadReachable(provider: string) {
  const url = config.publicAppUrl;
  if (provider === "mock") return;
  if (!url || !/^https:\/\//i.test(url) || /^https:\/\/(localhost|127\.[\d.]+|\[::1\])(:\d+)?(\/|$)/i.test(url)) {
    throw new ValidationError("Proofread dubs need APP_URL set to this app's public https address, so the dubbing provider can read the corrected lines");
  }
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
    return { title: v.title, sourceVideoUrl: v.sourceVideoUrl, languages, ...setOptions(v), ...(v.keepGlossary ? { keepGlossary: true } : {}) };
  });

/**
 * Starts one dubbing job per language, one after another. With several languages each job's title
 * names its language, so the list tells them apart; a job the provider refuses is kept as failed
 * and the rest still start.
 */
export async function createTranslations(input: z.infer<typeof translationBatchSchema>, ownerId: string = LOCAL_OWNER): Promise<Translation[]> {
  if (input.proofread) assertProofreadReachable(getTranslateProvider().name);
  // The brand kit's terms and rules as they are now; each job keeps what it was dubbed with (the rules for its language).
  const kit = input.keepGlossary ? await getBrandKit(ownerId) : null;
  const glossary = kit?.glossary ?? [];
  const out: Translation[] = [];
  for (const language of input.languages) {
    const title = input.languages.length > 1 ? `${input.title} (${language})`.slice(0, 160) : input.title;
    const forcedTranslations = forcedFor(kit?.forcedTranslations, language);
    // A term with a fixed translation in this language is translated, as script translation does, not also kept.
    const forcedTerms = new Set(forcedTranslations.map((r) => foldTerm(r.term.trim())));
    const kept = glossary.filter((t) => !forcedTerms.has(foldTerm(t.trim())));
    out.push(
      await createTranslation(
        { title, sourceVideoUrl: input.sourceVideoUrl, targetLanguage: language, ...setOptions(input), ...(kept.length ? { glossary: kept } : {}), ...(forcedTranslations.length ? { forcedTranslations } : {}) },
        ownerId,
      ),
    );
  }
  return out;
}

export async function createTranslation(req: z.infer<typeof translationRequestSchema> & Pick<Translation, "glossary" | "forcedTranslations">, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const provider = getTranslateProvider();
  const base: Translation = {
    // Default options (a lip-synced dub at speed, music and speech as recorded) are stored as no field at all.
    title: req.title,
    sourceVideoUrl: req.sourceVideoUrl,
    targetLanguage: req.targetLanguage,
    ...setOptions(req),
    ...(req.glossary?.length ? { glossary: req.glossary } : {}),
    ...(req.forcedTranslations?.length ? { forcedTranslations: req.forcedTranslations } : {}),
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
  try {
    return shown(await getStore().put("translation", base));
  } catch (err) {
    // The provider may be dubbing already: its job is logged so it can be found in the provider's account.
    if (base.providerJobId || base.providerProofreadId) console.error(`translation ${base.id} started at ${base.provider} (${base.providerJobId ?? base.providerProofreadId}) but could not be stored:`, err);
    throw err;
  }
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

/** How long lines may take to be translated before the proofread is given up (it is asked about until then). */
const PROOFREAD_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/**
 * A proofread whose lines are being translated: stores them once they are ready, or the reason it failed. The write
 * is conditional on the job being as it was read, so a slow poll never overwrites corrections or a dub's claim.
 */
async function refreshProofread(item: Translation): Promise<Translation> {
  const provider = getTranslateProviderByName(item.provider);
  if (!provider.getProofread) return item;
  let result: Awaited<ReturnType<NonNullable<typeof provider.getProofread>>>;
  try {
    result = await provider.getProofread(item.providerProofreadId!, item);
  } catch (err) {
    console.error(`proofread refresh failed for ${item.id}:`, err);
    result = { status: "preparing" };
  }
  if (result.status === "preparing") {
    if (Date.now() - Date.parse(item.createdAt) < PROOFREAD_GIVE_UP_MS) return item;
    result = { status: "failed", error: "The lines were still not ready to proofread after a day" };
  }
  if (result.status === "ready" && result.cues.length > MAX_CAPTION_CUES) {
    result = { status: "failed", error: `The video has more than ${MAX_CAPTION_CUES} lines, too many to proofread here` };
  }
  let next: Translation;
  if (result.status === "failed") {
    const { proofreadStage: _stage, ...rest } = item;
    next = { ...rest, status: "failed", error: result.error, updatedAt: after(item.updatedAt) };
  } else {
    const cues: CaptionCue[] = result.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text: text.slice(0, MAX_CAPTION_CUE_CHARS) }));
    next = { ...item, proofreadStage: "ready", proofreadCues: cues, updatedAt: after(item.updatedAt) };
  }
  if (await getStore().putIf("translation", next, "updatedAt", item.updatedAt)) return next;
  return (await getStore().get<Translation>("translation", item.id)) ?? item;
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
    const current = await getStore().get<Translation>("translation", item.id);
    // Deleted meanwhile: nothing is written back, so a delete is never undone by a poll.
    if (!current) return item;
    if (current.updatedAt !== item.updatedAt) return current;
    const waited: Translation = { ...current, updatedAt: after(current.updatedAt) };
    return (await getStore().putIf("translation", waited, "updatedAt", current.updatedAt)) ? waited : ((await getStore().get<Translation>("translation", item.id)) ?? item);
  }
  const current = await getStore().get<Translation>("translation", item.id);
  if (!current) return item;
  if (current.updatedAt !== item.updatedAt) return current;
  if (current.status === "completed" && update.status !== "completed") return current;
  // A job the provider does not know yet may simply be new (or the provider briefly wrong): only an old one is gone.
  if (update.error === TRANSLATION_GONE && Date.now() - Date.parse(current.dubStartedAt ?? current.createdAt) < GONE_AFTER_MS) return current;
  if (running(current) && update.status === current.status) return current;
  const next: Translation = { ...current, ...stripUndefined(update), updatedAt: after(current.updatedAt) };
  // Written only over the row as it was read: a callback or a delete landing meanwhile wins.
  if (await getStore().putIf("translation", next, "updatedAt", current.updatedAt)) return next;
  return (await getStore().get<Translation>("translation", item.id)) ?? item;
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

export const translationIdSchema = z.string().regex(/^tr_[A-Za-z0-9_-]{1,64}$/, "Unknown translation");

/**
 * Forgets one translation. A dub still being made carries on at the provider and is simply no longer followed (its
 * webhook finds no job); a proofread's lines link stops working with it.
 */
export async function deleteTranslation(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  const item = owned(await getStore().get<Translation>("translation", translationIdSchema.parse(id)), ownerId, `Translation ${id}`);
  // A dub being started is waited for: the provider may be taking it on, and its answer is written to this job.
  if (item.proofreadStage === "dubbing" && !stuck(item)) throw new ConflictError("This dub is being started; delete it once it shows as processing");
  // A failed dub being tried again is waited for too: the new attempt takes its place, and that one can be deleted.
  if (item.status === "failed" && retryClaimed(item)) throw new ConflictError("This dub is being tried again; delete the new attempt once it shows");
  await getStore().remove("translation", item.id);
  lastChecked.delete(item.id);
}

/** How long a failed dub claimed for a new try is held before it can be claimed again (a try that never finished). */
const RETRY_CLAIM_MS = 2 * 60 * 1000;

/**
 * Tries a failed dub again: a new job from the same source, language, and options, with the brand glossary and fixed
 * translations the failed one was made with (not the kit's current ones), in place of the failed one. The failed job
 * is claimed first with a conditional write, so two clicks or tabs start one dub, not two; it is removed once the new
 * job is stored, which carries the new outcome (its own error if the provider refuses again).
 */
export async function retryTranslation(id: string, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const failed = owned(await getStore().get<Translation>("translation", translationIdSchema.parse(id)), ownerId, `Translation ${id}`);
  if (failed.status !== "failed") throw new ConflictError("Only a dub that failed can be tried again");
  if (retryClaimed(failed)) throw new ConflictError("This dub is already being tried again");
  if (failed.providerProofreadId && failed.proofreadCues?.length) {
    // A proofread dub that failed after its lines were approved: the same lines (with their corrections) open again to
    // be approved and dubbed once more, rather than being translated afresh and the corrections lost.
    const { providerJobId: _job, error: _error, dubStartedAt: _started, retriedAt: _retried, videoUrl: _video, captionUrls: _captions, ...rest } = failed;
    const reopened: Translation = { ...rest, status: "processing", proofreadStage: "ready", updatedAt: after(failed.updatedAt) };
    if (!(await getStore().putIf("translation", reopened, "updatedAt", failed.updatedAt))) throw new ConflictError("This dub changed meanwhile; reload and try again");
    return shown(reopened);
  }
  if (failed.proofread) assertProofreadReachable(getTranslateProvider().name);
  const claimed: Translation = { ...failed, retriedAt: nowIso(), updatedAt: after(failed.updatedAt) };
  if (!(await getStore().putIf("translation", claimed, "updatedAt", failed.updatedAt))) throw new ConflictError("This dub changed meanwhile; reload and try again");
  const next = await createTranslation(
    {
      title: failed.title,
      sourceVideoUrl: failed.sourceVideoUrl,
      targetLanguage: failed.targetLanguage,
      ...setOptions(failed),
      ...(failed.glossary?.length ? { glossary: failed.glossary } : {}),
      ...(failed.forcedTranslations?.length ? { forcedTranslations: failed.forcedTranslations } : {}),
    },
    ownerId,
  );
  // The failed job goes only while it is still as claimed: one a late webhook moved on meanwhile (a job the provider
  // was in fact still making) is kept. Either way the new job stands, so a failure here is logged, not reported.
  try {
    const current = await getStore().get<Translation>("translation", failed.id);
    if (current && current.updatedAt === claimed.updatedAt) await getStore().remove("translation", failed.id);
    else if (current) console.error(`translation ${failed.id} changed while it was tried again (now ${current.status}); kept beside ${next.id}`);
    lastChecked.delete(failed.id);
  } catch (err) {
    console.error(`translation ${failed.id} was tried again as ${next.id} but could not be removed:`, err);
  }
  return next;
}

/** A failed dub claimed for a new try within the last two minutes. */
const retryClaimed = (t: Translation) => !!t.retriedAt && Date.now() - Date.parse(t.retriedAt) < RETRY_CLAIM_MS;

/** Corrected proofread lines: one text per line the provider translated, in order (the timing stays as translated). */
export const proofreadLinesSchema = z.object({
  lines: z
    .array(z.string().trim().min(1, "Every line needs some text").max(MAX_CAPTION_CUE_CHARS))
    .min(1)
    .max(MAX_CAPTION_CUES),
  /** The job's `updatedAt` when the lines were opened, so corrections made meanwhile by someone else are not overwritten. */
  basedOn: z.string().max(40).optional(),
});

/** The job's lines with the corrections applied; refused once the lines are no longer open, or when the count differs. */
function corrected(item: Translation, input?: z.infer<typeof proofreadLinesSchema>): CaptionCue[] {
  // A start that never finished (the server stopped mid-call) frees the lines again after a while.
  const open = item.proofreadStage === "ready" || stuck(item);
  if (!open || !item.proofreadCues?.length) {
    throw new ConflictError(item.proofreadStage === "dubbing" ? "This dub is already being started" : "These lines are not open for corrections");
  }
  if (!input) return item.proofreadCues;
  if (input.basedOn && input.basedOn !== item.updatedAt) throw new ConflictError("These lines were changed since you opened them; reload to see the latest version");
  if (input.lines.length !== item.proofreadCues.length) throw new ConflictError("The lines changed since they were opened; reload and try again");
  return item.proofreadCues.map((c, i) => ({ ...c, text: input.lines[i] }));
}

/** Keeps corrections to a proofread's lines without starting the dub. */
export async function saveProofreadLines(id: string, input: z.infer<typeof proofreadLinesSchema>, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const item = owned(await getStore().get<Translation>("translation", id), ownerId, `Translation ${id}`);
  const cues = corrected(item, input);
  const next: Translation = { ...item, proofreadStage: "ready", proofreadCues: cues, updatedAt: after(item.updatedAt) };
  if (!(await getStore().putIf("translation", next, "updatedAt", item.updatedAt))) throw new ConflictError("These lines were changed meanwhile; reload to see the latest version");
  return shown(next);
}

/**
 * Starts the dub of a proofread, with the corrections when given. The provider reads the lines as an SRT file
 * from this app (a link with a secret of its own), then dubs them; the job is then polled like any other.
 *
 * The lines are claimed first with a conditional write, so of two requests (two clicks, two editors, two server
 * instances) only one reaches the provider. When the provider refuses, the lines open again and the job carries the
 * error, so it can be tried again; once the provider has accepted, the lines never reopen.
 */
/**
 * Writes what became of a claimed dub start, only over the claim itself: a job deleted meanwhile (possible once a
 * start has hung long enough to free the lines) stays deleted, with the provider's job id logged when there is one.
 * A retry after a write that landed without saying so finds its own result and keeps it.
 */
async function writeClaimed(claimed: Translation, next: Translation, providerJobId?: string): Promise<Translation> {
  if (await getStore().putIf("translation", next, "updatedAt", claimed.updatedAt)) return next;
  const current = await getStore().get<Translation>("translation", claimed.id);
  // A retry finds its own write by its timestamp, or (once a poll has moved the dub on) by the provider's job id.
  if (current && (current.updatedAt === next.updatedAt || (providerJobId && current.providerJobId === providerJobId))) return current;
  if (!current) {
    if (providerJobId) console.error(`proofread dub ${providerJobId} started for ${claimed.id}, which was deleted meanwhile`);
    throw new NotFoundError(`Translation ${claimed.id} was deleted while its dub was being started`);
  }
  // Changed by someone else after a hung start freed the lines: an accepted dub is still recorded over it, since the
  // provider is making it; anything else leaves the newer row as it is.
  if (!providerJobId) return current;
  if (current.providerJobId) console.error(`proofread dub ${current.providerJobId} for ${claimed.id} is replaced by ${providerJobId}, a later start of the same lines`);
  const over: Translation = { ...next, updatedAt: after(current.updatedAt) };
  if (await getStore().putIf("translation", over, "updatedAt", current.updatedAt)) return over;
  console.error(`proofread dub ${providerJobId} started for ${claimed.id}, but the job changed meanwhile and could not be recorded`);
  return (await getStore().get<Translation>("translation", claimed.id)) ?? current;
}

export async function dubProofread(id: string, input: z.infer<typeof proofreadLinesSchema> | undefined, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const item = owned(await getStore().get<Translation>("translation", id), ownerId, `Translation ${id}`);
  const cues = corrected(item, input);
  const provider = getTranslateProviderByName(item.provider);
  if (!provider.dubProofread || !item.providerProofreadId) throw new ConflictError("This dub cannot be made from proofread lines");
  const token = item.proofreadToken ?? randomBytes(24).toString("base64url");
  const srtUrl = proofreadSrtUrl(id, token, item.provider);
  const claimed: Translation = { ...item, proofreadCues: cues, proofreadToken: token, proofreadStage: "dubbing", updatedAt: after(item.updatedAt) };
  if (!(await getStore().putIf("translation", claimed, "updatedAt", item.updatedAt))) throw new ConflictError("This dub is already being started");

  let providerJobId: string;
  try {
    ({ providerJobId } = await provider.dubProofread(item.providerProofreadId, srtUrl, cuesToSrt(cues)));
  } catch (err) {
    console.error(`proofread dub failed for ${id}:`, err);
    const reason = err instanceof Error ? err.message : String(err);
    if (unanswered(err)) {
      // The provider may have started the dub without saying so: the lines stay claimed, and open again (with a
      // warning to check the provider first) only once a start would have shown up.
      const error = `The dubbing provider did not answer (${reason}), so the dub may have started. If it does not appear, the lines open again in two minutes.`;
      return shown(await writeClaimed(claimed, { ...claimed, error, updatedAt: after(claimed.updatedAt) }));
    }
    return shown(await writeClaimed(claimed, { ...claimed, proofreadStage: "ready", error: `The dub could not be started: ${reason}`, updatedAt: after(claimed.updatedAt) }));
  }
  const { proofreadStage: _stage, error: _error, ...rest } = claimed;
  const now = nowIso();
  const started: Translation = { ...rest, providerJobId, status: "processing", dubStartedAt: now, updatedAt: after(claimed.updatedAt) };
  // The provider is dubbing now. Recording that is retried; if it still fails the job id is logged, and the lines
  // (still claimed) open again after two minutes with the warning to check the provider first.
  for (let attempt = 1; ; attempt++) {
    try {
      return shown(await writeClaimed(claimed, started, providerJobId));
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      if (attempt >= 3) {
        console.error(`proofread dub ${providerJobId} started for ${id} but could not be recorded:`, err);
        throw new Error(`The dub started (provider job ${providerJobId}) but could not be recorded; it is in your provider account`);
      }
    }
  }
}

/**
 * True for a failure that does not say whether the provider acted: no answer in time, the connection dropped, or a
 * server error. A refusal (a 4xx, or an error in the provider's answer) is definite.
 */
function unanswered(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError" || err instanceof TypeError) return true;
  return / failed: 5\d\d\b/.test(err.message);
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
  // Written over the row as it was read, read again when something landed meanwhile; a job deleted meanwhile stays gone.
  let current: Translation | null = item;
  for (let attempt = 0; attempt < 3 && current; attempt++) {
    if (current.status === "completed" || (current.status === "failed" && update.status === "failed")) return current;
    const next: Translation = { ...current, ...stripUndefined(update), updatedAt: after(current.updatedAt) };
    if (await getStore().putIf("translation", next, "updatedAt", current.updatedAt)) return next;
    current = await getStore().get<Translation>("translation", item.id);
  }
  return current;
}
