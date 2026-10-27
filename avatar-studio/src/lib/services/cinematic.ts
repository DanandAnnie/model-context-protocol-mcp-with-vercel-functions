// Cinematic shots: the renderer (HeyGen's Cinematic Avatar) directs a short scene from a description, featuring one to
// three of the account's presenters, and the result is a library video like any render. Used by API routes only.
import { z } from "zod";
import { createHash } from "node:crypto";
import { getAvatarProvider } from "../providers";
import { getStore } from "../store";
import { CINEMATIC_MAX_LOOKS, CINEMATIC_MAX_SEC, CINEMATIC_MIN_SEC, type Video } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError } from "../errors";
import { createVideo } from "./videos";
import { getAvatar } from "./avatars";
import { withSuffix } from "../text";

/** Longest description sent (HeyGen takes up to 10,000 characters; a shot is best described in a paragraph or two). */
export const MAX_CINEMATIC_PROMPT = 4000;

export const cinematicSchema = z.object({
  title: z.string().trim().max(120, "Keep the title to 120 characters").optional(),
  prompt: z.string().trim().min(10, "Describe the shot in a sentence or more").max(MAX_CINEMATIC_PROMPT, `Describe the shot in at most ${MAX_CINEMATIC_PROMPT} characters`),
  avatarIds: z
    .array(z.string().trim().min(1).max(200))
    .min(1, "Choose a presenter for the shot")
    .max(CINEMATIC_MAX_LOOKS, `A shot features at most ${CINEMATIC_MAX_LOOKS} presenters`)
    .refine((ids) => new Set(ids).size === ids.length, "Choose each presenter once"),
  aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
  resolution: z.enum(["720p", "1080p"]).default("1080p"),
  /** Seconds, or "auto" for the renderer to choose. */
  duration: z.union([z.literal("auto"), z.number().int().min(CINEMATIC_MIN_SEC, `A shot lasts at least ${CINEMATIC_MIN_SEC} seconds`).max(CINEMATIC_MAX_SEC, `A shot lasts at most ${CINEMATIC_MAX_SEC} seconds`)]).default("auto"),
  enhancePrompt: z.boolean().default(false),
  folder: z.string().trim().max(60).optional(),
});

/** A client's key for one shot (`Idempotency-Key`): letters, digits, `-` and `_`. */
export const cinematicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "The Idempotency-Key header takes 8 to 100 letters, digits, - or _");

export function cinematicAvailable(): boolean {
  return getAvatarProvider().cinematicShots === true;
}

/** The library title of a shot made without one: its first words. */
function titleOf(prompt: string): string {
  const words = prompt.replace(/\s+/g, " ").trim();
  return words.length <= 80 ? words : withSuffix(words.slice(0, 80).replace(/\s+\S*$/, ""), "…", 80);
}

/**
 * Starts a cinematic shot as a library video, counted against the monthly renders like any. With a client key, the
 * video's id is derived from the account and the key, so a shot retried after a lost answer returns the video already
 * started instead of directing (and counting) a second one.
 */
export async function startCinematic(input: z.infer<typeof cinematicSchema>, ownerId: string = LOCAL_OWNER, opts: { key?: string } = {}): Promise<Video> {
  const videoId = opts.key ? `vid_${createHash("sha256").update(`${ownerId}\0cinematic\0${opts.key}`).digest("base64url").slice(0, 24)}` : undefined;
  if (videoId) {
    const existing = await getStore().get<Video>("video", videoId);
    if (existing && existing.ownerId === ownerId) {
      // The same key for another shot is a mistake to say, not a render to replay.
      const same = existing.cinematic?.prompt === input.prompt && existing.cinematic.avatarIds.join("\0") === input.avatarIds.join("\0") && existing.aspect === input.aspect;
      if (!same) throw new ConflictError("This Idempotency-Key was already used for another shot; send a new key");
      if (existing.deletedAt) throw new ConflictError("The video this key started is in the trash; send a new key to make the shot again");
      // A row reserved by a start still being sent is not an answer yet.
      if (!(existing.status === "queued" && !existing.providerJobId)) return existing;
    }
  }
  // The presenters as the account sees them: another account's reads as not found.
  const avatars = await Promise.all(input.avatarIds.map((id) => getAvatar(id, ownerId)));
  return createVideo(
    {
      title: input.title || titleOf(input.prompt),
      // A shot has no script: the description directs it and is kept with `cinematic`, never spoken or captioned.
      script: "",
      avatarId: avatars[0].id,
      voiceId: "cinematic",
      aspect: input.aspect,
      resolution: input.resolution,
      background: { type: "color", value: "#000000" },
      captions: false,
      speed: 1,
      cinematic: {
        prompt: input.prompt,
        avatarIds: avatars.map((a) => a.id),
        avatarNames: avatars.map((a) => a.name),
        ...(input.duration === "auto" ? {} : { durationSec: input.duration }),
        ...(input.enhancePrompt ? { enhancePrompt: true as const } : {}),
      },
    },
    ownerId,
    undefined,
    false,
    { ...(videoId ? { id: videoId } : {}), ...(input.folder ? { folder: input.folder } : {}) },
  );
}
