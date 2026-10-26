// Saved video templates ("My templates"). Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { MAX_SCENES, backdropIdOf } from "../types";
import { silentProblem, silentSeconds } from "../pauses";
import type { Video, VideoTemplate } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { LimitError, NotFoundError, ValidationError } from "../errors";
import { owned } from "./shared";
import { PLAIN_BACKGROUND, getBackdrop } from "./backdrops";
import { backgroundSchema, captionStyleSchema, emotionSchema, pitchSchema, sceneLayoutSchema, sceneTextSchema } from "./videos";

export const MAX_TEMPLATES = 50;

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
}).refine((sc) => !sc.hidePresenter || sc.background.type !== "color", { path: ["hidePresenter"], message: "A scene without the presenter shows its picture or video: give it an image or video background" });

/** Either copy a video the owner has (`fromVideoId`, title optional) or spell the template out. */
export const templateInputSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(200).optional(),
  fromVideoId: z.string().min(1).optional(),
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
});
export type TemplateInput = z.infer<typeof templateInputSchema>;

export async function listTemplates(ownerId: string = LOCAL_OWNER): Promise<VideoTemplate[]> {
  const items = await getStore().list<VideoTemplate>("template", ownerId);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTemplate(id: string, ownerId: string = LOCAL_OWNER): Promise<VideoTemplate> {
  return owned(await getStore().get<VideoTemplate>("template", id), ownerId, `Template ${id}`);
}

export async function createTemplate(input: TemplateInput, ownerId: string = LOCAL_OWNER): Promise<VideoTemplate> {
  if ((await getStore().list<VideoTemplate>("template", ownerId)).length >= MAX_TEMPLATES) {
    throw new LimitError(`You can keep up to ${MAX_TEMPLATES} templates; delete one first`);
  }
  let base: Omit<VideoTemplate, "id" | "ownerId" | "createdAt" | "updatedAt">;
  if (input.fromVideoId) {
    const video = await getStore().get<Video>("video", input.fromVideoId);
    if (!video) throw new NotFoundError(`Video ${input.fromVideoId} not found`);
    owned(video, ownerId, `Video ${input.fromVideoId}`);
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
    };
  }
  // An uploaded background image must be the owner's and still there, as a render would check. Copied from a video,
  // a scene whose image has since been deleted gets a plain background instead, so the video can still be kept as a template.
  const ids = new Set(base.scenes.map((sc) => backdropIdOf(sc.background)).filter((id): id is string => !!id));
  const gone = new Set<string>();
  for (const id of ids) {
    try {
      await getBackdrop(id, ownerId);
    } catch (err) {
      if (!input.fromVideoId || !(err instanceof NotFoundError)) throw err;
      gone.add(id);
    }
  }
  if (gone.size) base = { ...base, scenes: base.scenes.map((sc) => (gone.has(backdropIdOf(sc.background) ?? "") ? { ...sc, background: PLAIN_BACKGROUND } : sc)) };
  return getStore().put("template", { ...base, id: newId("tpl"), ownerId, createdAt: nowIso(), updatedAt: nowIso() });
}

export async function deleteTemplate(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  await getTemplate(id, ownerId);
  await getStore().remove("template", id);
}
