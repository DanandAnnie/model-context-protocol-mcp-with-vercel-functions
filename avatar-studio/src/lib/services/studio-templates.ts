// HeyGen Studio templates: layouts made in HeyGen Studio with named slots (text, media, presenter, voice), listed from
// the renderer, filled in here, and rendered as a library video. Used by API routes only.
import { z } from "zod";
import { getAvatarProvider } from "../providers";
import type { AspectRatio, StudioTemplate, StudioTemplateDetail, StudioVariable, Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ValidationError } from "../errors";
import { assertPublicHttpUrl } from "../safe-url";
import { createVideo } from "./videos";

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
}

export async function getStudioTemplate(id: string): Promise<StudioTemplateDetail> {
  const provider = getAvatarProvider();
  if (!provider.getStudioTemplate) throw new ValidationError(`HeyGen Studio templates are not available with the ${provider.name} renderer`);
  return provider.getStudioTemplate(studioTemplateIdSchema.parse(id));
}

/**
 * The variables to send: each value given replaces the template's (it must be one of the template's variables, of the
 * same type); one left out keeps the template's. HeyGen fills no text the request leaves out, so every text variable is
 * sent, and one with no text either way is refused. A link must be a public https address, as HeyGen downloads it.
 */
export async function fillStudioVariables(template: StudioTemplateDetail, given: Record<string, StudioVariable>): Promise<Record<string, StudioVariable>> {
  for (const [name, value] of Object.entries(given)) {
    const own = template.variables[name];
    if (!own) throw new ValidationError(`The template has no variable "${name}"`);
    if (own.type !== value.type) throw new ValidationError(`"${name}" is a ${own.type} variable, not ${value.type}`);
  }
  const out: Record<string, StudioVariable> = {};
  for (const [name, own] of Object.entries(template.variables)) {
    const value = given[name] ?? own;
    if (value.type === "text") {
      const content = value.content.trim();
      if (!content) throw new ValidationError(`Fill in "${name}"`);
      out[name] = { type: "text", content };
      continue;
    }
    // Only links reach here from a request (the schema takes no asset ids); the template's own assets are kept as they are.
    if (given[name] && "asset" in value && value.asset.type === "url") {
      const url = value.asset.url;
      if (!/^https:\/\/\S+$/i.test(url)) throw new ValidationError(`"${name}" needs a public https link`);
      try {
        await assertPublicHttpUrl(url, `The link for "${name}"`);
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : `"${name}" needs a public https link`);
      }
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
export async function renderStudioTemplate(id: string, input: z.infer<typeof studioRenderSchema>, ownerId: string = LOCAL_OWNER): Promise<Video> {
  const template = await getStudioTemplate(id);
  const variables = await fillStudioVariables(template, input.variables);
  const first = <T extends StudioVariable["type"]>(type: T) => Object.values(variables).find((v): v is Extract<StudioVariable, { type: T }> => v.type === type);
  return createVideo(
    {
      title: input.title,
      script: filledScript(template, variables),
      // The template's own presenter and voice, for the library's labels; the template decides what renders.
      avatarId: first("character")?.avatar_id ?? "studio-template",
      voiceId: first("voice")?.voice_id ?? "studio-template",
      aspect: ASPECTS.includes(template.aspect as AspectRatio) ? (template.aspect as AspectRatio) : "16:9",
      background: { type: "color", value: "#000000" },
      captions: input.captions,
      speed: 1,
      studioTemplate: { id: template.id, name: template.name, variables },
    },
    ownerId,
  );
}
