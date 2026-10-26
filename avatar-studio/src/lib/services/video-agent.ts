// The Video Agent: one prompt in, a whole video out (HeyGen's Video Agent). Used by API routes only.
import { z } from "zod";
import { getScriptProvider } from "../providers";
import type { VideoPlan } from "../providers/types";
import { LOCAL_OWNER } from "../owner-id";
import { NotFoundError, ValidationError } from "../errors";
import { stripPauses } from "../pauses";
import { fetchPageText } from "../webpage";
import type { FetchLike } from "../safe-fetch";
import { MAX_DOCUMENT_CHARS, MAX_SCENES, type AspectRatio, type Avatar, type Background, type Resolution, type SceneLayout, type Video } from "../types";
import { getAvatar, listAvatars } from "./avatars";
import { getBrandKit } from "./brand";
import { listVoices } from "./voices";
import { createVideo, enforceRenderLimit, videoRequestSchema } from "./videos";

/** What a video holds: its scenes' scripts together, joined as the editor joins them. */
const MAX_SCRIPT = 5000;
/** The planner is asked for about this many scenes at most; a video holds more, but an agent's plan rarely needs them. */
const MAX_PLANNED_SCENES = 10;

export const videoAgentSchema = z.object({
  prompt: z.string().trim().min(3, "Describe the video in a few words").max(10_000),
  /** A public web page the agent writes from, as HeyGen's agent reads attached files. */
  url: z.string().trim().url().max(2000).optional(),
  /** An attached document's words (read in the browser), which the agent writes from as it does from a page. */
  document: z
    .object({
      name: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1, "The attached document has no text").max(MAX_DOCUMENT_CHARS, `An attached document is read up to ${MAX_DOCUMENT_CHARS} characters`),
    })
    .optional(),
  /** Presenter and voice; the brand kit's defaults (then the first ones) when omitted. */
  avatarId: z.string().min(1).optional(),
  voiceId: z.string().min(1).optional(),
  /** "auto" takes the planner's choice (portrait for social formats). */
  orientation: z.enum(["auto", "landscape", "portrait", "square"]).default("auto"),
  lengthSec: z.number().int().min(15).max(300).default(60),
  language: z.string().trim().min(2).max(40).default("English"),
  /** "generate" renders straight away; "plan" returns the draft to review in the editor first. */
  mode: z.enum(["generate", "plan"]).default("generate"),
});
export type VideoAgentInput = z.infer<typeof videoAgentSchema>;

/** A plan made ready for the editor or the renderer: scenes, presenter, voice, and settings. */
export interface VideoAgentDraft {
  title: string;
  scenes: { script: string; background: Background; layout?: SceneLayout }[];
  avatarId: string;
  voiceId: string;
  aspect: AspectRatio;
  resolution: Resolution;
  captions: boolean;
}

const ASPECTS: Record<Exclude<VideoAgentInput["orientation"], "auto">, AspectRatio> = { landscape: "16:9", portrait: "9:16", square: "1:1" };

/** Text up to `max` characters, cut after the last sentence end that fits (else the last word). */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(...[". ", "! ", "? "].map((p) => head.lastIndexOf(p)));
  if (end > max / 2) return head.slice(0, end + 1);
  // Between words, and never inside a pause marker the cut would leave half of ("[pause", "[ pause 2").
  return head.replace(/\s+\S*$/, "").replace(/\s*\[\s*(?:pause(?:\s+\d{0,2}(?:[.,]\d{0,2})?\s*s?)?\s*)?$/i, "").trim();
}

/**
 * The planner's scenes as a video takes them: words beyond pause markers, at most the planned-scene count, and
 * every scene that fits in the script a video holds (a first scene longer than that is cut at a sentence end).
 */
export function fitPlan(plan: VideoPlan): VideoPlan["scenes"] {
  const out: VideoPlan["scenes"] = [];
  let used = 0;
  for (const scene of plan.scenes) {
    const script = scene.script.replace(/[ \t]+/g, " ").trim();
    if (!stripPauses(script).trim()) continue;
    if (out.length >= Math.min(MAX_PLANNED_SCENES, MAX_SCENES)) break;
    const room = MAX_SCRIPT - used - (out.length ? 2 : 0);
    if (script.length > room) {
      if (out.length) break;
      // A first scene longer than a whole video is cut; one that leaves only pauses gives way to the next.
      const kept = cut(script, room);
      if (!stripPauses(kept).trim()) continue;
      out.push({ ...scene, script: kept });
      break;
    }
    out.push({ ...scene, script });
    used += script.length + (out.length > 1 ? 2 : 0);
  }
  return out;
}

/** The presenter asked for, else the brand kit's, else the first one listed. */
async function presenter(avatarId: string | undefined, kitAvatarId: string | undefined, ownerId: string): Promise<Avatar> {
  if (avatarId) return getAvatar(avatarId, ownerId);
  if (kitAvatarId) {
    const kit = await getAvatar(kitAvatarId, ownerId).catch((err) => {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    });
    if (kit) return kit;
  }
  const [first] = await listAvatars(ownerId);
  if (!first) throw new ValidationError("No presenter is available to present the video");
  return first;
}

/** Plans a video from a prompt and makes it ready to render, with the owner's brand kit applied. */
export async function planVideo(input: VideoAgentInput, ownerId: string = LOCAL_OWNER, fetchImpl?: FetchLike): Promise<VideoAgentDraft> {
  let page: string | undefined;
  if (input.url) {
    try {
      page = (await fetchPageText(input.url, fetchImpl)).text;
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : "The page could not be read");
    }
  }
  // The attached document first (the user chose it for this video), then the page; named when there are both, so the
  // planner can tell them apart.
  const doc = input.document?.text;
  const source = doc && page ? `From the attached document "${input.document!.name}":\n${doc}\n\nFrom the web page ${input.url}:\n${page}` : doc || page;
  const kit = await getBrandKit(ownerId);
  const avatar = await presenter(input.avatarId, kit?.defaultAvatarId, ownerId);
  const voices = await listVoices(ownerId);
  // A voice asked for must exist; otherwise the presenter's own (when it was chosen), the kit's, or the first.
  if (input.voiceId && !voices.some((v) => v.id === input.voiceId)) throw new ValidationError(`Voice ${input.voiceId} is not available`);
  const candidates = [input.voiceId, ...(input.avatarId ? [avatar.defaultVoiceId] : []), kit?.defaultVoiceId, avatar.defaultVoiceId];
  const voice = candidates.map((id) => id && voices.find((v) => v.id === id)).find(Boolean) || voices[0];
  if (!voice) throw new ValidationError("No voice is available to narrate the video");

  const plan = await getScriptProvider().plan({ prompt: input.prompt, lengthSec: input.lengthSec, language: input.language, ...(source ? { source } : {}) });
  const scenes = fitPlan(plan);
  if (!scenes.length) throw new ValidationError("The video agent could not plan a video from that prompt. Try describing it in more detail.");
  const background: Background = kit?.defaultBackground ?? (kit ? { type: "color", value: kit.primaryColor } : { type: "color", value: "#f1f5f9" });
  return {
    title: plan.title.replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled video",
    scenes: scenes.map((sc) => ({ script: sc.script, background, ...(sc.framing === "closeUp" ? { layout: { scale: 1, x: 0, y: 0, framing: "closeUp" as const } } : {}) })),
    avatarId: avatar.id,
    voiceId: voice.id,
    // Left to the agent: a plan for a vertical format is 9:16, a prompt asking for a wide one 16:9; otherwise the
    // brand kit's format, else landscape.
    aspect:
      input.orientation !== "auto"
        ? ASPECTS[input.orientation]
        : plan.orientation === "portrait"
          ? "9:16"
          : asksForLandscape(input.prompt)
            ? "16:9"
            : (kit?.defaultAspect ?? "16:9"),
    resolution: kit?.defaultResolution ?? "1080p",
    // Agent videos are watched on mute as often as not: captions on unless the kit says otherwise.
    captions: kit?.captionsByDefault ?? true,
  };
}

/** Whether a prompt names a wide format itself ("a widescreen YouTube explainer"), which no brand default overrides. */
export function asksForLandscape(prompt: string): boolean {
  return /\b(landscape|widescreen|wide[- ]screen|horizontal|youtube|16\s*:\s*9)\b/i.test(prompt);
}

/** Plans and renders in one step, like HeyGen's one-shot "generate" mode. */
export async function generateAgentVideo(input: VideoAgentInput, ownerId: string = LOCAL_OWNER, fetchImpl?: FetchLike): Promise<{ video: Video; draft: VideoAgentDraft }> {
  // Before the page fetch and the planner call, so an owner at the monthly limit is not charged for a plan.
  await enforceRenderLimit(ownerId);
  const draft = await planVideo(input, ownerId, fetchImpl);
  const video = await createVideo(videoRequestSchema.parse(draft), ownerId);
  return { video, draft };
}
