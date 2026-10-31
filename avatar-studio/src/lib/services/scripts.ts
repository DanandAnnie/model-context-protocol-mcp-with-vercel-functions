// Script writing, revision, and interactive chat. Used by API routes only.
import { protectPauses } from "../pauses";
import { forcedFor, protectTerms } from "../glossary";
import { z } from "zod";
import { getScriptProvider } from "../providers";
import { withNotes } from "../providers/types";
import { MAX_AGENT_NOTES } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ValidationError } from "../errors";
import { fetchPageText } from "../webpage";
import type { FetchLike } from "../safe-fetch";
import { getAvatar } from "./avatars";
import { getBrandKit } from "./brand";

export const scriptSchema = z
  .object({
    topic: z.string().trim().max(500).default(""),
    /** A public web page to write from; the topic defaults to its title. */
    url: z.string().trim().url().max(2000).optional(),
    tone: z.enum(["friendly", "professional", "formal", "energetic", "calm"]).default("friendly"),
    lengthSec: z.number().int().min(10).max(300).default(45),
    language: z.string().trim().min(2).max(40).default("English"),
    audience: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.topic.length >= 3 || !!v.url, { path: ["topic"], message: "Give a topic or a page URL" });

/** The brand kit's writing style, for the script writer to follow; none without a kit or a style. */
export async function writingStyleOf(ownerId: string): Promise<{ style?: string }> {
  const style = (await getBrandKit(ownerId))?.writingStyle;
  return style ? { style } : {};
}

export async function generateScript(input: z.infer<typeof scriptSchema>, ownerId: string = LOCAL_OWNER, fetchImpl?: FetchLike): Promise<string> {
  const style = await writingStyleOf(ownerId);
  if (input.url) {
    let page: { title: string; text: string };
    try {
      page = await fetchPageText(input.url, fetchImpl);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : "The page could not be read");
    }
    const topic = input.topic.length >= 3 ? input.topic : page.title || "this page";
    return getScriptProvider().generate({ ...input, topic, source: page.text, ...style });
  }
  return getScriptProvider().generate({ ...input, ...style });
}

export const reviseSchema = z.object({
  script: z.string().trim().min(1).max(5000),
  action: z.enum(["shorten", "expand", "tone", "translate", "polish"]),
  tone: z.enum(["friendly", "professional", "formal", "energetic", "calm"]).optional(),
  language: z.string().trim().min(2).max(40).optional(),
  /** A short on-screen label (a title, a name and role) rather than a script to speak; for translations. */
  label: z.boolean().optional(),
});

/**
 * Pause markers ride through the model as tokens it leaves alone, then come back as written. A
 * translation does the same with the owner's brand glossary, so its terms come back untranslated, and
 * with the kit's forced translations for the language, which come back as their fixed translation.
 * Every other revision follows the kit's writing style; a translation keeps the voice of the script it is given.
 */
export async function reviseScript(input: z.infer<typeof reviseSchema>, ownerId: string = LOCAL_OWNER): Promise<string> {
  const pauses = protectPauses(input.script);
  let terms: ReturnType<typeof protectTerms> | null = null;
  const kit = await getBrandKit(ownerId);
  if (input.action === "translate") {
    // A translation with no language named goes into English, as the script writer does.
    const forced = forcedFor(kit?.forcedTranslations, input.language ?? "English");
    terms = protectTerms(pauses.text, [...(kit?.glossary ?? []), ...forced.map((r) => r.term)], forced);
  }
  const style = input.action !== "translate" && kit?.writingStyle ? { style: kit.writingStyle } : {};
  const sent = terms ? terms.text : pauses.text;
  // The model is told what each token stands for in the translation: the term itself, or its fixed translation.
  const out = await getScriptProvider().revise({ ...input, script: sent, ...(terms?.meanings.length ? { terms: terms.meanings } : {}), ...style });
  return pauses.restore(terms ? terms.restore(out) : out);
}

export const chatSchema = z.object({
  avatarId: z.string().min(1),
  instructions: z.string().trim().max(2000).default(""),
  /** The reference notes typed for the presenter, so the try-it chat answers from them as the saved one will. */
  notes: z.string().trim().max(MAX_AGENT_NOTES).optional(),
  language: z.string().trim().min(2).max(40).default("English"),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) })).min(1).max(40),
  /** Word the reply in the brand kit's writing style, as a saved presenter with it turned on does. */
  brandStyle: z.boolean().optional(),
});

/** One reply from the interactive avatar; the last message must come from the visitor. */
export async function chatWithAvatar(input: z.infer<typeof chatSchema>, ownerId: string = LOCAL_OWNER): Promise<string> {
  if (input.messages[input.messages.length - 1].role !== "user") throw new ValidationError("The last message must be from the visitor");
  const avatar = await getAvatar(input.avatarId, ownerId);
  const style = input.brandStyle ? (await writingStyleOf(ownerId).catch(() => ({ style: undefined }))).style : undefined;
  return getScriptProvider().chat({ persona: { name: avatar.name, instructions: withNotes(input.instructions, input.notes), language: input.language, ...(style ? { style } : {}) }, messages: input.messages });
}
