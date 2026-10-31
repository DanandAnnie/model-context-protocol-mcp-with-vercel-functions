// Saved video templates ("My templates"). Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { MAX_SCENES, MAX_TEMPLATES, backdropIdOf, footageIdOf } from "../types";
import { silentProblem, silentSeconds } from "../pauses";
import type { Video, VideoTemplate } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, LimitError, NotFoundError, ValidationError } from "../errors";
import { owned } from "./shared";
import { getBackdrop, plainScene } from "./backdrops";
import { getFootage } from "./footage";
import { MORE_BLINKING_NEEDS_V, accentSchema, avatarEngineSchema, moreBlinkingSchema, transparentSchema, backgroundSchema, captionStyleSchema, emotionSchema, expressivenessSchema, motionPromptSchema, pitchSchema, sceneLayoutSchema, sceneNameSchema, sceneTextSchema } from "./videos";

export { MAX_TEMPLATES };

const sceneSchema = z.object({
  script: z
    .string()
    .trim()
    .min(1)
    .max(5000)
    // A silent scene (only pauses) has the same bounds as on a video.
    .superRefine((s, ctx) => {
      const problem = silentProblem(s);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  background: backgroundSchema,
  hidePresenter: z.literal(true).optional(),
  avatarId: z.string().min(1).optional(),
  voiceId: z.string().min(1).optional(),
  speed: z.number().min(0.5).max(1.5).optional(),
  layout: sceneLayoutSchema.optional(),
  overlay: sceneTextSchema.optional(),
  name: sceneNameSchema.optional(),
}).refine((sc) => !sc.hidePresenter || sc.background.type !== "color", { path: ["hidePresenter"], message: "A scene without the presenter shows its picture or video: give it an image or video background" });

/** Copy a video the owner has (`fromVideoId`) or one of their templates (`fromTemplateId`), title optional, or spell the template out. */
export const templateInputSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(200).optional(),
  fromVideoId: z.string().min(1).optional(),
  fromTemplateId: z.string().min(1).optional(),
  scenes: z
    .array(sceneSchema)
    .min(1)
    .max(MAX_SCENES)
    .refine((scenes) => scenes.some((sc) => !silentSeconds(sc.script)), "A template needs some words, not only pauses: every scene is silent")
    .optional(),
  avatarId: z.string().min(1).optional(),
  voiceId: z.string().min(1).optional(),
  aspect: z.enum(["16:9", "9:16", "1:1"]).optional(),
  resolution: z.enum(["720p", "1080p"]).optional(),
  captions: z.boolean().optional(),
  captionStyle: captionStyleSchema.optional(),
  speed: z.number().min(0.5).max(1.5).optional(),
  pitch: pitchSchema.optional(),
  emotion: emotionSchema.optional(),
  expressiveness: expressivenessSchema,
  motionPrompt: motionPromptSchema,
  accent: accentSchema,
  avatarEngine: avatarEngineSchema,
  moreBlinking: moreBlinkingSchema,
  transparent: transparentSchema,
}).refine((t) => !(t.fromVideoId && t.fromTemplateId), { path: ["fromTemplateId"], message: "Copy a video or a template, not both" }).refine((t) => !t.moreBlinking || t.avatarEngine === "avatar_v", { path: ["moreBlinking"], message: MORE_BLINKING_NEEDS_V }).refine((t) => !t.transparent || !t.scenes || (t.scenes.length === 1 && !t.scenes[0].hidePresenter), {
  path: ["transparent"],
  message: "A transparent background is for a one-scene template that shows the presenter",
});
export type TemplateInput = z.infer<typeof templateInputSchema>;

export async function listTemplates(ownerId: string = LOCAL_OWNER): Promise<VideoTemplate[]> {
  const items = await getStore().list<VideoTemplate>("template", ownerId);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTemplate(id: string, ownerId: string = LOCAL_OWNER): Promise<VideoTemplate> {
  return owned(await getStore().get<VideoTemplate>("template", id), ownerId, `Template ${id}`);
}

/**
 * The name a copy of `title` takes: "Intro (copy)", then "Intro (copy 2)" and on while those are taken; a copy of a
 * copy counts on from the original's name rather than stacking "(copy) (copy)". Within 120 UTF-16 units (what both
 * the schema and the edit form allow), cut between whole characters so an emoji or accented letter is never split.
 */
export function copyTitle(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = title.replace(/\s*\(copy(?: \d+)?\)$/, "").trim() || title;
  const graphemes = Array.from(new Intl.Segmenter().segment(stem), (g) => g.segment);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    let cut = "";
    for (const g of graphemes) {
      if (cut.length + g.length + suffix.length > 120) break;
      cut += g;
    }
    const name = `${cut.trimEnd()}${suffix}`;
    if (!used.has(name)) return name;
  }
}

export async function createTemplate(input: TemplateInput, ownerId: string = LOCAL_OWNER): Promise<VideoTemplate> {
  // A copy's source is looked up first, so a missing one is a 404 whatever the count.
  const source = input.fromTemplateId ? await getTemplate(input.fromTemplateId, ownerId) : null;
  const existing = await getStore().list<VideoTemplate>("template", ownerId);
  if (existing.length >= MAX_TEMPLATES) {
    throw new LimitError(`You can keep up to ${MAX_TEMPLATES} templates; delete one first`);
  }
  let base: Omit<VideoTemplate, "id" | "ownerId" | "createdAt" | "updatedAt">;
  if (source) {
    // Everything the template holds, under a name of its own (or the one given). The copy was not saved from a video,
    // so it does not name one as its source.
    const { id: _id, ownerId: _owner, createdAt: _created, updatedAt: _updated, sourceVideoId: _video, ...rest } = source;
    base = {
      ...rest,
      title: input.title ?? copyTitle(rest.title, existing.map((t) => t.title)),
      ...(input.description !== undefined ? { description: input.description || undefined } : {}),
    };
    if (!base.description) delete base.description;
  } else if (input.fromVideoId) {
    const video = await getStore().get<Video>("video", input.fromVideoId);
    if (!video) throw new NotFoundError(`Video ${input.fromVideoId} not found`);
    owned(video, ownerId, `Video ${input.fromVideoId}`);
    // Its scenes, presenter, and voice live in the HeyGen template, so there is nothing here to keep as a template.
    if (video.studioTemplate) throw new ValidationError("A video made from a HeyGen template is remade from that template, not saved as one here");
    if (video.cinematic) throw new ValidationError("A cinematic shot has no script to save as a template; make it again from the Cinematic page");
    if (video.directed) throw new ValidationError("A video HeyGen's Video Agent directed has no script here to save as a template; ask the agent again from the Video Agent page");
    // Scenes keep their presenter ids but not the display names, which are filled in again at render time.
    const scenes = (video.scenes?.length ? video.scenes : [{ script: video.script, background: video.background }]).map((sc) => ({
      script: sc.script,
      background: sc.background,
      ...(sc.hidePresenter ? { hidePresenter: true as const } : {}),
      ...(sc.avatarId ? { avatarId: sc.avatarId } : {}),
      ...(sc.voiceId ? { voiceId: sc.voiceId } : {}),
      ...(sc.speed ? { speed: sc.speed } : {}),
      ...(sc.layout ? { layout: sc.layout } : {}),
      ...(sc.overlay ? { overlay: sc.overlay } : {}),
      ...(sc.name ? { name: sc.name } : {}),
    }));
    base = {
      title: input.title ?? video.title,
      ...(input.description ? { description: input.description } : {}),
      scenes,
      avatarId: video.avatarId,
      voiceId: video.voiceId,
      aspect: video.aspect,
      ...(video.resolution ? { resolution: video.resolution } : {}),
      captions: video.captions,
      ...(video.captionStyle ? { captionStyle: video.captionStyle } : {}),
      speed: video.speed,
      ...(video.pitch ? { pitch: video.pitch } : {}),
      ...(video.emotion ? { emotion: video.emotion } : {}),
      ...(video.expressiveness ? { expressiveness: video.expressiveness } : {}),
      ...(video.motionPrompt ? { motionPrompt: video.motionPrompt } : {}),
      ...(video.accent ? { accent: video.accent } : {}),
      ...(video.avatarEngine ? { avatarEngine: video.avatarEngine } : {}),
      ...(video.moreBlinking ? { moreBlinking: true as const } : {}),
      ...(video.transparent ? { transparent: true as const } : {}),
      sourceVideoId: video.id,
    };
  } else {
    if (!input.title || !input.scenes) throw new ValidationError("A template needs a title and at least one scene, or a video to copy");
    base = {
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      scenes: input.scenes,
      ...(input.avatarId ? { avatarId: input.avatarId } : {}),
      ...(input.voiceId ? { voiceId: input.voiceId } : {}),
      aspect: input.aspect ?? "16:9",
      ...(input.resolution ? { resolution: input.resolution } : {}),
      captions: input.captions ?? false,
      ...(input.captionStyle ? { captionStyle: input.captionStyle } : {}),
      speed: input.speed ?? 1,
      ...(input.pitch ? { pitch: input.pitch } : {}),
      ...(input.emotion ? { emotion: input.emotion } : {}),
      ...(input.expressiveness ? { expressiveness: input.expressiveness } : {}),
      ...(input.motionPrompt ? { motionPrompt: input.motionPrompt } : {}),
      ...(input.accent ? { accent: input.accent } : {}),
      ...(input.avatarEngine ? { avatarEngine: input.avatarEngine } : {}),
      ...(input.moreBlinking ? { moreBlinking: true as const } : {}),
      ...(input.transparent ? { transparent: true as const } : {}),
    };
  }
  // An uploaded background image must be the owner's and still there, as a render would check. Copied from a video or
  // a template, a scene whose image has since been deleted gets a plain background instead, so the copy can still be made.
  const ids = new Set(base.scenes.map((sc) => backdropIdOf(sc.background)).filter((id): id is string => !!id));
  const gone = new Set<string>();
  for (const id of ids) {
    try {
      await getBackdrop(id, ownerId);
    } catch (err) {
      if (!(input.fromVideoId || input.fromTemplateId) || !(err instanceof NotFoundError)) throw err;
      gone.add(id);
    }
  }
  // A generated clip likewise, kept or swapped for a plain background.
  for (const id of new Set(base.scenes.map((sc) => footageIdOf(sc.background)).filter((id): id is string => !!id))) {
    try {
      await getFootage(id, ownerId);
    } catch (err) {
      if (!(input.fromVideoId || input.fromTemplateId) || !(err instanceof NotFoundError)) throw err;
      gone.add(id);
    }
  }
  if (gone.size) base = { ...base, scenes: base.scenes.map((sc) => (gone.has(backdropIdOf(sc.background) ?? footageIdOf(sc.background) ?? "") ? plainScene(sc) : sc)) };
  return getStore().put("template", { ...base, id: newId("tpl"), ownerId, createdAt: nowIso(), updatedAt: nowIso() });
}

/** A template's name and description: `description: null` or blank removes it; at least one of the two. */
export const templateEditSchema = z
  .object({
    title: z.string().trim().min(1, "Name the template").max(120, "A template's name is at most 120 characters").optional(),
    description: z.string().trim().max(200, "A template's description is at most 200 characters").nullable().optional(),
  })
  .refine((e) => e.title !== undefined || e.description !== undefined, "Send a new name or description");

/**
 * Renames a template or changes its description; its scenes and settings are kept. The write is conditional on the
 * row read, so a change landing meanwhile (an image deleted from its scenes, say) is read again and kept, and a
 * template deleted meanwhile stays deleted.
 */
export async function editTemplate(id: string, input: z.infer<typeof templateEditSchema>, ownerId: string = LOCAL_OWNER): Promise<VideoTemplate> {
  let current = await getTemplate(id, ownerId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const next: VideoTemplate = { ...current, updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString() };
    if (input.title !== undefined) next.title = input.title;
    if (input.description !== undefined) {
      if (input.description) next.description = input.description;
      else delete next.description;
    }
    if (await getStore().putIf("template", next, "updatedAt", current.updatedAt)) return next;
    const again = await getStore().get<VideoTemplate>("template", id);
    if (!again || again.ownerId !== current.ownerId) throw new NotFoundError(`Template ${id} not found`);
    current = again;
  }
  throw new ConflictError("The template kept changing while it was being saved; try again");
}

export async function deleteTemplate(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  await getTemplate(id, ownerId);
  await getStore().remove("template", id);
}
