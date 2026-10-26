// Field schemas shared by the video, template, batch, and brand kit services. A leaf module: it
// imports no service, so any service may import it without creating a cycle.
import { z } from "zod";
import { CAPTION_FONTS, CAPTION_POSITIONS, CAPTION_LOOKS, CAPTION_SIZES, VOICE_EMOTIONS } from "../types";

export const backgroundSchema = z
  .object({ type: z.enum(["color", "image", "video"]), value: z.string().min(1).max(2000, "A background must be a colour or a URL of at most 2000 characters") })
  .refine((b) => b.type !== "video" || /^https?:\/\//.test(b.value), "A video background must be a public http(s) URL");
/** How captions look on the share page; see `CaptionStyle`. */
export const captionStyleSchema = z
  .object({ position: z.enum(CAPTION_POSITIONS), size: z.enum(CAPTION_SIZES), look: z.enum(CAPTION_LOOKS).optional(), font: z.enum(CAPTION_FONTS).optional() })
  // "classic" and "sans" are what an unnamed look and font mean, so they are stored as absent.
  .transform(({ look, font, ...rest }) => ({ ...rest, ...(look && look !== "classic" ? { look } : {}), ...(font && font !== "sans" ? { font } : {}) }));
/** Voice pitch shift, -50..50 whole steps; HeyGen applies it, other renderers keep the voice's natural pitch. */
export const pitchSchema = z.number().int().min(-50).max(50);
/** Speaking style; HeyGen applies it to voices that support one, other renderers keep the voice's natural delivery. */
export const emotionSchema = z.enum(VOICE_EMOTIONS);
/** Presenter size and position in the frame; see `SceneLayout`. */
export const sceneLayoutSchema = z.object({ scale: z.number().min(0.5).max(1.5), x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) });
