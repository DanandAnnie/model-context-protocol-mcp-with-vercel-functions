// Brand kit. Used by API routes only.
import { z } from "zod";
import { nowIso } from "../ids";
import { getStore } from "../store";
import { WATERMARK_CORNERS, backdropIdOf, type BrandKit } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ValidationError } from "../errors";
import { getAvatar } from "./avatars";
import { listVoices } from "./voices";
import { getBackdrop } from "./backdrops";
import { backgroundSchema } from "./schemas";
import { MAX_PRONUNCIATIONS } from "../pronounce";
import { MAX_FORCED_TRANSLATIONS, MAX_FORCED_TRANSLATION_LENGTH, MAX_GLOSSARY_TERMS, MAX_GLOSSARY_TERM_LENGTH, MIN_GLOSSARY_TERM_LENGTH } from "../glossary";
import { servableLogo } from "../brand-logo";
import { brandFromHtml, type BrandSuggestion } from "../brand-import";
import type { FetchLike } from "../safe-fetch";
import { fetchPageHtml } from "../webpage";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

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
  /** Up to 50 rules; a word is matched whole and case-insensitively in every script handed to the renderer. */
  pronunciations: z.array(z.object({ word: z.string().trim().min(1).max(40), sayAs: z.string().trim().min(1).max(80) })).max(MAX_PRONUNCIATIONS).optional(),
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
  defaultAvatarId: z.string().trim().max(200).optional(),
  defaultVoiceId: z.string().trim().max(200).optional(),
  defaultAspect: z.enum(["16:9", "9:16", "1:1"]).optional(),
  defaultResolution: z.enum(["720p", "1080p"]).optional(),
  captionsByDefault: z.boolean().optional(),
  watermark: z.enum(WATERMARK_CORNERS).optional(),
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
    ...(input.pronunciations?.length ? { pronunciations: input.pronunciations } : {}),
    ...(input.glossary?.length ? { glossary: input.glossary } : {}),
    ...(input.forcedTranslations?.length ? { forcedTranslations: input.forcedTranslations.map(({ term, translation, language }) => ({ term, translation, ...(language ? { language } : {}) })) } : {}),
    defaultAvatarId: input.defaultAvatarId || undefined,
    defaultVoiceId: input.defaultVoiceId || undefined,
    defaultAspect: input.defaultAspect,
    defaultResolution: input.defaultResolution,
    captionsByDefault: input.captionsByDefault,
    ...(input.watermark ? { watermark: input.watermark } : {}),
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
  const raw = /^[a-z][a-z\d+.-]*:/i.test(input.url) ? input.url : `https://${input.url}`;
  let page: { html: string; url: string };
  try {
    page = await fetchPageHtml(new URL(raw).toString(), fetchImpl, "Website", 3);
  } catch (err) {
    throw new ValidationError(err instanceof TypeError ? "Enter a website address like https://example.com" : err instanceof Error ? err.message : "The website could not be read");
  }
  const suggestion = brandFromHtml(page.html, page.url);
  if (!suggestion.name && !suggestion.logoUrl && !suggestion.primaryColor) throw new ValidationError("That page names no brand name, logo, or colour; fill the kit in by hand");
  return suggestion;
}

