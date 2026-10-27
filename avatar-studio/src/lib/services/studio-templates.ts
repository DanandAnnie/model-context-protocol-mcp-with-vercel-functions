// HeyGen Studio templates: layouts made in HeyGen Studio with named slots (text, media, presenter, voice), listed from
// the renderer, filled in here, and rendered as a library video. Used by API routes only.
import { z } from "zod";
import { getAvatarProvider } from "../providers";
import type { AspectRatio, StudioTemplate, StudioTemplateDetail, StudioVariable, Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, ValidationError } from "../errors";
import { createHash } from "node:crypto";
import { getStore } from "../store";
import { assertPublicHttpUrl } from "../safe-url";
import { createVideo } from "./videos";
import { listAvatars } from "./avatars";
import { listVoices } from "./voices";
import { forgetMemo, memo } from "../cache";

/** How long a listing of the renderer's templates is reused (they change when someone edits them in HeyGen Studio). */
const LIST_TTL_MS = 2 * 60 * 1000;
/** Longest text a variable may hold (HeyGen's limit). */
export const MAX_STUDIO_TEXT = 10_000;
/** Longest stored script (the scenes' scripts filled in), kept for captions and search. */
const MAX_SCRIPT = 5000;

export const studioTemplateIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "Unknown template");

const idValue = z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/, "An id takes letters, digits, - and _");
const assetSchema = z.object({ type: z.literal("url"), url: z.string().trim().max(2000, "The link is too long") });
const fitSchema = z.enum(["cover", "contain", "crop", "none"]).optional();
export const studioVariableSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), content: z.string().max(MAX_STUDIO_TEXT, `A text holds at most ${MAX_STUDIO_TEXT} characters`) }),
  z.object({ type: z.literal("image"), asset: assetSchema, fit: fitSchema }),
  z.object({ type: z.literal("video"), asset: assetSchema, fit: fitSchema }),
  z.object({ type: z.literal("audio"), asset: assetSchema }),
  z.object({ type: z.literal("voice"), voice_id: idValue }),
  z.object({ type: z.literal("character"), avatar_id: idValue }),
]);

export const studioRenderSchema = z.object({
  title: z.string().trim().min(1, "Give the video a title").max(120),
  captions: z.boolean().default(false),
  /** Values keyed by the template's variable names; one left out keeps the template's own. */
  variables: z.record(z.string().max(100), studioVariableSchema).default({}),
});

const listed = new Map<string, { at: number; templates: StudioTemplate[] }>();

/** "agent_name" → "Agent name": a variable's name as the form labels it, for messages. */
export function variableLabel(name: string): string {
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/** A client's key for one render (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const studioRenderKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function studioTemplatesAvailable(): boolean {
  return typeof getAvatarProvider().listStudioTemplates === "function";
}

/** The renderer's API-ready templates (the same for every account: they live in the renderer's account). */
export async function listStudioTemplates(): Promise<StudioTemplate[]> {
  const provider = getAvatarProvider();
  if (!provider.listStudioTemplates) return [];
  const cached = listed.get(provider.name);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.templates;
  const templates = await provider.listStudioTemplates();
  listed.set(provider.name, { at: Date.now(), templates });
  return templates;
}

/** Forgets the cached listing (tests). */
export function forgetStudioTemplates(): void {
  listed.clear();
  forgetMemo("studio-template:");
}

/** A template's detail is reused this long, so opening its form again (or by several people) does not ask the renderer each time. */
const DETAIL_TTL_MS = 60 * 1000;

export async function getStudioTemplate(id: string): Promise<StudioTemplateDetail> {
  const provider = getAvatarProvider();
  if (!provider.getStudioTemplate) throw new ValidationError(`HeyGen Studio templates are not available with the ${provider.name} renderer`);
  const key = studioTemplateIdSchema.parse(id);
  // A failed read is not kept, so a template fixed in HeyGen Studio (or a passing error) is asked about again.
  return memo(`studio-template:${provider.name}:${key}`, DETAIL_TTL_MS, () => provider.getStudioTemplate!(key)).then((t) => structuredClone(t));
}

/** What a presenter or voice given for a template may be: the template's own, or one the account may use. */
export interface StudioChoices {
  avatarIds: Set<string>;
  voiceIds: Set<string>;
}

/**
 * The variables to send: every text (HeyGen fills no text a request leaves out), and each other value given; one not
 * given is left out so the template keeps its own. A value given must be one of the template's variables, of the same
 * type; a text with no content either way is refused; a link must be a public https address, as HeyGen downloads it;
 * a given picture, video, or audio keeps the template's fit and playback unless they are given too; a presenter or voice
 * must be the template's own or one the account may use.
 */
export async function fillStudioVariables(template: StudioTemplateDetail, given: Record<string, StudioVariable>, choicesOf?: () => Promise<StudioChoices>): Promise<Record<string, StudioVariable>> {
  // Asked for only when a presenter or voice other than the template's own is given.
  let choices: StudioChoices | undefined;
  const allowed = async () => (choices ??= choicesOf ? await choicesOf() : undefined);
  for (const [name, value] of Object.entries(given)) {
    const own = template.variables[name];
    if (!own) throw new ValidationError(`The template has no variable "${name}"`);
    if (own.type !== value.type) throw new ValidationError(`"${variableLabel(name)}" is a ${own.type} slot, not ${value.type}`);
  }
  const out: Record<string, StudioVariable> = {};
  for (const [name, own] of Object.entries(template.variables)) {
    const value = given[name];
    const label = variableLabel(name);
    if (own.type === "text") {
      const content = (value?.type === "text" ? value.content : own.content).trim();
      if (!content) throw new ValidationError(`Fill in "${label}"`);
      out[name] = { type: "text", content };
      continue;
    }
    if (!value) continue;
    if ((value.type === "image" || value.type === "video" || value.type === "audio") && value.asset?.type === "url") {
      const url = value.asset.url;
      if (!/^https:\/\/\S+$/i.test(url)) throw new ValidationError(`"${label}" needs a public https link`);
      try {
        await assertPublicHttpUrl(url, `The link for "${label}"`);
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : `"${label}" needs a public https link`);
      }
      out[name] = { ...own, ...value } as StudioVariable;
      continue;
    }
    if (value.type === "character" && own.type === "character" && value.avatar_id !== own.avatar_id && (await allowed()) && !choices!.avatarIds.has(value.avatar_id)) {
      throw new ValidationError(`"${label}" names a presenter that is not available`);
    }
    if (value.type === "voice" && own.type === "voice" && value.voice_id !== own.voice_id && (await allowed()) && !choices!.voiceIds.has(value.voice_id)) {
      throw new ValidationError(`"${label}" names a voice that is not available`);
    }
    out[name] = value;
  }
  return out;
}

/** The scenes' scripts with their text filled in, as one script for captions, search, and the video page. */
export function filledScript(template: StudioTemplateDetail, variables: Record<string, StudioVariable>): string {
  const text = (name: string) => {
    const v = variables[name];
    return v?.type === "text" ? v.content : "";
  };
  const script = template.scenes
    .map((sc) => sc.script.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, name: string) => text(name)).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  return (script || template.name).slice(0, MAX_SCRIPT);
}

const ASPECTS: AspectRatio[] = ["16:9", "9:16", "1:1"];

/** Renders one of the renderer's templates with the account's values, as a library video counted like any render. */
export async function renderStudioTemplate(id: string, input: z.infer<typeof studioRenderSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string } = {}): Promise<Video> {
  // With a client key, the video's id is derived from the account and the key, so a render retried after a lost answer
  // returns the video already made instead of rendering (and counting) a second one.
  const videoId = opts.key ? `vid_${createHash("sha256").update(`${ownerId}\0studio-template\0${opts.key}`).digest("base64url").slice(0, 24)}` : undefined;
  if (videoId) {
    const existing = await getStore().get<Video>("video", videoId);
    if (existing && existing.ownerId === ownerId) {
      // The same key for another template, title, or captions is a mistake to say, not a render to replay.
      if (existing.studioTemplate?.id !== id || existing.title !== input.title || existing.captions !== input.captions) throw new ConflictError("This Idempotency-Key was already used for another render; send a new key");
      if (existing.deletedAt) throw new ConflictError("The video this key rendered is in the trash; send a new key to render again");
      // A row reserved by a start still being sent (see `createStudioTemplateVideo`) is not an answer yet.
      const reserved = existing.status === "queued" && !existing.providerJobId;
      if (!reserved) return existing;
    }
  }
  const template = await getStudioTemplate(id);
  // A presenter given must be one of the renderer's library looks the account sees (never a look made for another
  // account), and a voice one the account's voice list has.
  const choices = async () => {
    const [avatars, voices] = await Promise.all([listAvatars(ownerId), listVoices(ownerId)]);
    return { avatarIds: new Set(avatars.filter((a) => a.source !== "custom").map((a) => a.id)), voiceIds: new Set(voices.map((v) => v.id)) };
  };
  const variables = await fillStudioVariables(template, input.variables, choices);
  // The presenter and voice the video shows: the one given, else the template's own (for the library's labels).
  const all = { ...template.variables, ...variables };
  const first = <T extends StudioVariable["type"]>(type: T) => Object.values(all).find((v): v is Extract<StudioVariable, { type: T }> => v.type === type);
  return createVideo(
    {
      title: input.title,
      script: filledScript(template, variables),
      // The template's own presenter and voice, for the library's labels; the template decides what renders.
      avatarId: first("character")?.avatar_id || "studio-template",
      voiceId: first("voice")?.voice_id || "studio-template",
      aspect: ASPECTS.includes(template.aspect as AspectRatio) ? (template.aspect as AspectRatio) : "16:9",
      background: { type: "color", value: "#000000" },
      captions: input.captions,
      speed: 1,
      studioTemplate: { id: template.id, name: template.name, variables },
    },
    ownerId,
    undefined,
    false,
    videoId ? { id: videoId } : {},
  );
}
