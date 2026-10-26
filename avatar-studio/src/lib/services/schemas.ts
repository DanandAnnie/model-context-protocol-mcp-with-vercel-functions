// Field schemas shared by the video, template, batch, and brand kit services. A leaf module: it
// imports no service, so any service may import it without creating a cycle.
import { z } from "zod";
import { BACKGROUND_FITS, CAPTION_FONTS, CAPTION_POSITIONS, CAPTION_LOOKS, CAPTION_SIZES, MAX_SCENE_TEXT, PRESENTER_FRAMINGS, SCENE_TEXT_POSITIONS, SCENE_TEXT_SIZES, VOICE_EMOTIONS, backdropIdOf } from "../types";

export const backgroundSchema = z
  .object({ type: z.enum(["color", "image", "video"]), value: z.string().min(1).max(2000, "A background must be a colour or a URL of at most 2000 characters"), fit: z.enum(BACKGROUND_FITS).optional() })
  .refine((b) => b.type !== "video" || /^https?:\/\//.test(b.value), "A video background must be a public http(s) URL")
  // An image is a public address or an uploaded image exactly as the app names it, so nothing in between reaches a renderer as a URL.
  .refine((b) => b.type !== "image" || /^https?:\/\//.test(b.value) || backdropIdOf(b) !== null, "An image background must be a public http(s) URL or an uploaded image (/api/backdrops/<id>)")
  // Filling the frame is what an unnamed fit means, and a colour has nothing to fit, so both are stored as absent.
  .transform(({ fit, ...rest }) => (fit === "contain" && rest.type !== "color" ? { ...rest, fit } : rest));
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
export const sceneLayoutSchema = z
  .object({ scale: z.number().min(0.5).max(1.5), x: z.number().min(-1).max(1), y: z.number().min(-1).max(1), framing: z.enum(PRESENTER_FRAMINGS).optional() })
  // The full frame is the default, stored as absent like the default look of a caption.
  .transform(({ framing, ...rest }) => (framing && framing !== "full" ? { ...rest, framing } : rest));
/** A scene's on-screen text; see `SceneText`. One line, its spaces collapsed; the default place, size, and colour are stored as absent. */
export const sceneTextSchema = z
  .object({
    // Measured once its spaces are collapsed, as it is stored and shown.
    text: z
      .string()
      .max(5000)
      .transform((t) => t.replace(/\s+/g, " ").trim())
      .pipe(z.string().max(MAX_SCENE_TEXT, `On-screen text must be ${MAX_SCENE_TEXT} characters or fewer`)),
    position: z.enum(SCENE_TEXT_POSITIONS).optional(),
    size: z.enum(SCENE_TEXT_SIZES).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "A text colour must be a hex colour such as #ffffff").optional(),
  })
  .transform(({ text, position, size, color }) => ({
    text,
    ...(position && position !== "top" ? { position } : {}),
    ...(size && size !== "medium" ? { size } : {}),
    ...(color && color.toLowerCase() !== "#ffffff" ? { color: color.toLowerCase() } : {}),
  }))
  // Blank text is no text, so a cleared field is stored as absent.
  .transform((t) => (t.text ? t : undefined));
