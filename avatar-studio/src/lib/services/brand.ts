// Brand kit. Used by API routes only.
import { z } from "zod";
import { nowIso } from "../ids";
import { getStore } from "../store";
import { MAX_CLOSING_SCRIPT, MAX_SCENE_TEXT, MAX_WRITING_STYLE, WATERMARK_CORNERS, backdropIdOf, footageIdOf, isDefaultCaptionStyle, type BrandKit } from "../types";
import { silentProblem } from "../pauses";
import { graphemes } from "../text";
import { LOCAL_OWNER } from "../owner-id";
import { ValidationError } from "../errors";
import { getAvatar } from "./avatars";
import { listVoices } from "./voices";
import { getBackdrop } from "./backdrops";
import { getFootage } from "./footage";
import { backgroundSchema, captionStyleSchema } from "./schemas";
import { MAX_PRONUNCIATIONS, pronunciationLanguage } from "../pronounce";
import { MAX_FORCED_TRANSLATIONS, MAX_FORCED_TRANSLATION_LENGTH, MAX_GLOSSARY_TERMS, MAX_GLOSSARY_TERM_LENGTH, MIN_GLOSSARY_TERM_LENGTH } from "../glossary";
import { servableLogo } from "../brand-logo";
import { brandFromHtml, type BrandSuggestion } from "../brand-import";
import type { FetchLike } from "../safe-fetch";
import { extractReadableText, fetchPageHtml } from "../webpage";
import { getScriptProvider } from "../providers";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * A scene the editor adds in one click at the start or end of a video: what the presenter says (up to 1000
 * characters, pauses allowed, as a scene's script) and text on screen, read as a scene's is (one line, its spaces
 * collapsed, up to 120 characters as a reader counts them). Both blank means none.
 */
function bookendScene(which: "opening" | "closing") {
  return z
    .object({
      script: z.string().trim().max(MAX_CLOSING_SCRIPT).default(""),
      text: z
        .string()
        .max(20_000)
        .transform((t) => t.replace(/\s+/g, " ").trim())
        .refine((t) => graphemes(t).length <= MAX_SCENE_TEXT, `The ${which} scene's on-screen text must be ${MAX_SCENE_TEXT} characters or fewer`)
        .default(""),
    })
    .optional()
    .superRefine((c, ctx) => {
      if (!c || (!c.script && !c.text)) return;
      // A scene cannot render without words (or a silent pause of a fitting length), so on-screen text alone is refused.
      const silent = c.script ? silentProblem(c.script) : null;
      if (!c.script) ctx.addIssue({ code: "custom", path: ["script"], message: `Add what the presenter says in the ${which} scene` });
      else if (silent) ctx.addIssue({ code: "custom", path: ["script"], message: `The ${which} scene: ${silent}` });
    });
}

export const brandKitSchema = z.object({
  name: z.string().trim().max(80).default(""),
  logoUrl: z
    .string()
    .max(8_000_000, "Logo must be under 6 MB")
    .refine((v) => v === "" || v.startsWith("data:image/") || /^https?:\/\//.test(v), "Logo must be an image URL or uploaded image")
    .refine((v) => !v.startsWith("data:") || servableLogo(v), "Upload the logo as PNG, JPEG, WebP, GIF, SVG, AVIF, BMP, or ICO")
    .default(""),
  primaryColor: z.string().regex(HEX_COLOR, "Use a 6-digit hex color like #4f46e5"),
  accentColor: z.string().regex(HEX_COLOR, "Use a 6-digit hex color like #4f46e5").optional(),
  /** Image or video behind new scenes; a colour here is the same as leaving it out and using the primary colour. */
  defaultBackground: backgroundSchema.optional(),
  /**
   * Up to 50 rules; a word is matched whole and case-insensitively in every script handed to the renderer, or only in
   * those a voice speaks in `language` (any region); a repeat of a word in the same language (ignoring case and
   * region) keeps the first.
   */
  pronunciations: z
    .array(
      z.object({
        word: z.string().trim().min(1).max(40),
        sayAs: z.string().trim().min(1).max(80),
        language: z.preprocess(
          (v) => (v === null || (typeof v === "string" && !v.trim()) ? undefined : v),
          z.string().trim().min(2).max(40).refine((l) => !!pronunciationLanguage(l), "Name the pronunciation's language, for example French").optional(),
        ),
      }),
    )
    .max(MAX_PRONUNCIATIONS)
    // Rules for one language are matched by language, not region: a second for the same word would never apply.
    .transform((rules) => rules.filter((r, i) => rules.findIndex((u) => u.word.toLowerCase() === r.word.toLowerCase() && pronunciationLanguage(u.language) === pronunciationLanguage(r.language)) === i))
    .optional(),
  /** Up to 50 terms of 2 to 60 characters, each matched whole and case-insensitively, that translations keep as written; repeats ignoring case are dropped. */
  glossary: z
    .array(z.string().trim().min(MIN_GLOSSARY_TERM_LENGTH, `A term to keep untranslated is at least ${MIN_GLOSSARY_TERM_LENGTH} characters`).max(MAX_GLOSSARY_TERM_LENGTH))
    .max(MAX_GLOSSARY_TERMS)
    .transform((terms) => terms.filter((t, i) => terms.findIndex((u) => u.toLowerCase() === t.toLowerCase()) === i))
    .optional(),
  /**
   * Up to 50 rules a translation follows: the term (2 to 60 characters, matched whole and case-insensitively) always
   * becomes the translation (up to 80), in every language or only in `language`; a repeat of a term and language,
   * ignoring case, keeps the first.
   */
  forcedTranslations: z
    .array(
      z.object({
        term: z.string().trim().min(MIN_GLOSSARY_TERM_LENGTH, `A term to translate is at least ${MIN_GLOSSARY_TERM_LENGTH} characters`).max(MAX_GLOSSARY_TERM_LENGTH),
        // A closing bracket at the end would read back on the brand page as a language.
        translation: z.string().trim().min(1).max(MAX_FORCED_TRANSLATION_LENGTH).refine((t) => !t.endsWith("]"), "A translation cannot end with ]"),
        language: z.preprocess((v) => (v === null || v === "" ? undefined : v), z.string().trim().min(2).max(40).optional()),
      }),
    )
    .max(MAX_FORCED_TRANSLATIONS)
    .transform((rules) => rules.filter((r, i) => rules.findIndex((u) => u.term.toLowerCase() === r.term.toLowerCase() && (u.language ?? "").toLowerCase() === (r.language ?? "").toLowerCase()) === i))
    .optional(),
  /** Up to 600 characters on how the brand writes, which the script writer follows; blank is none. */
  writingStyle: z.string().trim().max(MAX_WRITING_STYLE, `The writing style must be ${MAX_WRITING_STYLE} characters or fewer`).optional(),
  defaultAvatarId: z.string().trim().max(200).optional(),
  defaultVoiceId: z.string().trim().max(200).optional(),
  defaultAspect: z.enum(["16:9", "9:16", "1:1"]).optional(),
  defaultResolution: z.enum(["720p", "1080p"]).optional(),
  captionsByDefault: z.boolean().optional(),
  captionStyle: captionStyleSchema.optional(),
  watermark: z.enum(WATERMARK_CORNERS).optional(),
  /** The scene the editor's Opening scene button puts at the start of a video; see `bookendScene`. */
  openingScene: bookendScene("opening"),
  /** The scene the editor's Closing scene button puts at the end of a video, read the same way. */
  closingScene: bookendScene("closing"),
});

export const brandKitId = (ownerId: string) => `brand_${ownerId}`;

/** The owner's brand kit, or null when none has been saved. */
export async function getBrandKit(ownerId: string = LOCAL_OWNER): Promise<BrandKit | null> {
  const kit = await getStore().get<BrandKit>("brand", brandKitId(ownerId));
  return kit && kit.ownerId === ownerId ? kit : null;
}

export async function saveBrandKit(input: z.infer<typeof brandKitSchema>, ownerId: string = LOCAL_OWNER): Promise<BrandKit> {
  if (input.defaultAvatarId) await getAvatar(input.defaultAvatarId, ownerId); // throws NotFound for foreign or unknown ids
  const backdropId = backdropIdOf(input.defaultBackground);
  if (backdropId) await getBackdrop(backdropId, ownerId); // likewise for an uploaded background image
  const footageId = footageIdOf(input.defaultBackground);
  if (footageId) await getFootage(footageId, ownerId); // and for a generated clip
  if (input.defaultVoiceId && !(await listVoices(ownerId)).some((v) => v.id === input.defaultVoiceId)) {
    throw new ValidationError(`Voice ${input.defaultVoiceId} is not available`);
  }
  const kit: BrandKit = {
    id: brandKitId(ownerId),
    ownerId,
    name: input.name,
    logoUrl: input.logoUrl || undefined,
    primaryColor: input.primaryColor.toLowerCase(),
    accentColor: input.accentColor?.toLowerCase(),
    ...(input.defaultBackground && input.defaultBackground.type !== "color" ? { defaultBackground: input.defaultBackground } : {}),
    ...(input.pronunciations?.length ? { pronunciations: input.pronunciations.map(({ word, sayAs, language }) => ({ word, sayAs, ...(language ? { language } : {}) })) } : {}),
    ...(input.glossary?.length ? { glossary: input.glossary } : {}),
    ...(input.forcedTranslations?.length ? { forcedTranslations: input.forcedTranslations.map(({ term, translation, language }) => ({ term, translation, ...(language ? { language } : {}) })) } : {}),
    ...(input.writingStyle ? { writingStyle: input.writingStyle } : {}),
    defaultAvatarId: input.defaultAvatarId || undefined,
    defaultVoiceId: input.defaultVoiceId || undefined,
    defaultAspect: input.defaultAspect,
    defaultResolution: input.defaultResolution,
    captionsByDefault: input.captionsByDefault,
    ...(input.captionStyle && !isDefaultCaptionStyle(input.captionStyle) ? { captionStyle: input.captionStyle } : {}),
    ...(input.watermark ? { watermark: input.watermark } : {}),
    ...(input.closingScene?.script ? { closingScene: { script: input.closingScene.script, ...(input.closingScene.text ? { text: input.closingScene.text } : {}) } } : {}),
    ...(input.openingScene?.script ? { openingScene: { script: input.openingScene.script, ...(input.openingScene.text ? { text: input.openingScene.text } : {}) } } : {}),
    updatedAt: nowIso(),
  };
  return getStore().put("brand", kit);
}

export async function deleteBrandKit(ownerId: string = LOCAL_OWNER): Promise<void> {
  await getStore().remove("brand", brandKitId(ownerId));
}

export const brandImportSchema = z.object({ url: z.string().trim().min(1, "Enter the website's address").max(2000) });

/**
 * A brand kit's name, logo, and colours read from a company's public web page (an address without a scheme is taken
 * as https). Up to three redirects are followed, each to a public address; nothing is saved.
 */
export async function importBrandFromWebsite(input: z.infer<typeof brandImportSchema>, fetchImpl?: FetchLike): Promise<BrandSuggestion> {
  const started = Date.now();
  // "acme.com:8080" names a port, not a scheme; only "scheme://" is taken as given.
  const raw = /^[a-z][a-z\d+.-]*:\/\//i.test(input.url) ? input.url : `https://${input.url}`;
  let page: { html: string; url: string };
  try {
    page = await fetchPageHtml(new URL(raw).toString(), fetchImpl, "Website", 3);
  } catch (err) {
    throw new ValidationError(err instanceof TypeError ? "Enter a website address like https://example.com" : err instanceof Error ? err.message : "The website could not be read");
  }
  let suggestion: BrandSuggestion;
  try {
    suggestion = brandFromHtml(page.html, page.url);
  } catch {
    throw new ValidationError("That page could not be read for brand details; fill the kit in by hand");
  }
  if (!suggestion.name && !suggestion.logoUrl && !suggestion.primaryColor) throw new ValidationError("That page names no brand name, logo, or colour; fill the kit in by hand");
  const writingStyle = await styleFromPage(page.html, suggestion.name, STYLE_BUDGET_MS - (Date.now() - started));
  return writingStyle ? { ...suggestion, writingStyle } : suggestion;
}

/** The fewest characters of readable text a page needs before its writing is worth describing. */
const MIN_STYLE_SOURCE = 200;
/** How long into an import its style may still be drafted, within the route's minute; a draft needs at least the floor. */
const STYLE_BUDGET_MS = 50_000;
const STYLE_FLOOR_MS = 5_000;
const STYLE_TIMEOUT_MS = 20_000;
/** Top-level domains a web address in a drafted style would most likely end in. */
const TLDS = "com|net|org|io|co|ca|uk|us|au|nz|ie|de|fr|es|it|nl|be|ch|at|se|no|dk|fi|pl|pt|br|mx|in|jp|realty|homes|house|estate|properties|app|dev|ai|info|biz|site|online|shop|store|example";

/**
 * Whether a drafted style carries what no style needs, and a page could plant in it: a web address, an email address,
 * or a phone number. The brand's own name is set aside first, so a brand named for its domain ("Realtor.com") can be
 * named; numbers count as a phone only with nine digits or more, and not as a span of years or a figure in thousands.
 */
export function carriesContact(style: string, brandName?: string): boolean {
  const name = brandName?.trim();
  const text = name ? style.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ") : style;
  if (/https?:\/\/|\bwww\./i.test(text)) return true;
  if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i.test(text)) return true;
  if (new RegExp(`\\b[a-z0-9][a-z0-9-]*\\.(?:${TLDS})\\b(?!\\.\\w)`, "i").test(text)) return true;
  for (const run of text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? []) {
    const digits = run.replace(/\D/g, "").length;
    const years = /^\d{4}\s*[-–]\s*\d{4}$/.test(run.trim());
    const thousands = /^\d{1,3}(?:[ .,]\d{3})+$/.test(run.trim());
    if (digits >= 9 && !years && !thousands) return true;
  }
  return false;
}

/**
 * How a page writes, as the script writer describes it from the page's readable text (what a reader sees: scripts,
 * navigation, and hidden elements left out), tidied to one paragraph and cut to fit the kit's writing style. Best
 * effort: a page with too little text, a writer that cannot read a voice or finds none, one that fails, declines, or
 * runs past the time left, or a draft that carries an address or phone number gives none, and the rest of the import
 * stands.
 */
async function styleFromPage(html: string, name: string | undefined, budgetMs: number): Promise<string | undefined> {
  const provider = getScriptProvider();
  if (!provider.brandStyle || budgetMs < STYLE_FLOOR_MS) return undefined;
  // The brand's own words: its main content before one card of its home page, and none of what the page hides.
  const { text } = extractReadableText(html, { dropHidden: true, preferMain: true });
  if (text.length < MIN_STYLE_SOURCE) return undefined;
  let style: string;
  try {
    style = await provider.brandStyle({ ...(name ? { name } : {}), text, timeoutMs: Math.min(STYLE_TIMEOUT_MS, budgetMs) });
  } catch {
    return undefined;
  }
  const tidy = unquoted(style.replace(/\s+/g, " ").trim());
  if (!tidy || /^NONE\b/i.test(tidy) || carriesContact(tidy, name)) return undefined;
  return cutStyle(tidy);
}

/**
 * A style the writer wrapped whole in quotes, unwrapped: double quotes may hold apostrophes ("doesn't"), single ones
 * nothing quoted; quotes that only name a word inside it are kept.
 */
function unquoted(style: string): string {
  const m = /^(?:"([^"“”]*)"|“([^"“”]*)”|'([^'"“”]*)')$/.exec(style);
  return (m ? (m[1] ?? m[2] ?? m[3]) : style).trim();
}

/**
 * A writing style cut to fit `MAX_WRITING_STYLE`, as the kit stores it: after the last whole sentence that fits when
 * there is one past half the limit, else at the last space, else at the limit itself (text without spaces, such as
 * Japanese), never between the halves of a character outside the Basic Multilingual Plane.
 */
export function cutStyle(style: string): string {
  if (style.length <= MAX_WRITING_STYLE) return style;
  // One character past the limit shows whether the cut falls at the end of a sentence or between words.
  const cut = style.slice(0, MAX_WRITING_STYLE + 1);
  const half = MAX_WRITING_STYLE / 2;
  const sentence = Math.max(-1, ...[...cut.matchAll(/[.!?。！？](?=\s|$)/g)].map((m) => m.index + 1).filter((end) => end <= MAX_WRITING_STYLE));
  if (sentence >= half) return cut.slice(0, sentence);
  const space = cut.search(/\s\S*$/);
  if (space >= half) return cut.slice(0, space).trimEnd();
  const end = /[\ud800-\udbff]/.test(style[MAX_WRITING_STYLE - 1]) ? MAX_WRITING_STYLE - 1 : MAX_WRITING_STYLE;
  return style.slice(0, end);
}

