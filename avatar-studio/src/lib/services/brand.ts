// Brand kit. Used by API routes only.
import { z } from "zod";
import { nowIso } from "../ids";
import { getStore } from "../store";
import type { BrandKit, Voice } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { ValidationError } from "../errors";
import { getAvatar } from "./avatars";
import { listVoices } from "./voices";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const brandKitSchema = z.object({
  name: z.string().trim().max(80).default(""),
  logoUrl: z
    .string()
    .max(8_000_000, "Logo must be under 6 MB")
    .refine((v) => v === "" || v.startsWith("data:image/") || /^https?:\/\//.test(v), "Logo must be an image URL or uploaded image")
    .default(""),
  primaryColor: z.string().regex(HEX_COLOR, "Use a 6-digit hex color like #4f46e5"),
  accentColor: z.string().regex(HEX_COLOR, "Use a 6-digit hex color like #4f46e5").optional(),
  defaultAvatarId: z.string().trim().max(200).optional(),
  defaultVoiceId: z.string().trim().max(200).optional(),
  defaultAspect: z.enum(["16:9", "9:16", "1:1"]).optional(),
  captionsByDefault: z.boolean().optional(),
});

export const brandKitId = (ownerId: string) => `brand_${ownerId}`;

/** The owner's brand kit, or null when none has been saved. */
export async function getBrandKit(ownerId: string = LOCAL_OWNER): Promise<BrandKit | null> {
  const kit = await getStore().get<BrandKit>("brand", brandKitId(ownerId));
  return kit && kit.ownerId === ownerId ? kit : null;
}

export async function saveBrandKit(input: z.infer<typeof brandKitSchema>, ownerId: string = LOCAL_OWNER): Promise<BrandKit> {
  if (input.defaultAvatarId) await getAvatar(input.defaultAvatarId, ownerId); // throws NotFound for foreign or unknown ids
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
    defaultAvatarId: input.defaultAvatarId || undefined,
    defaultVoiceId: input.defaultVoiceId || undefined,
    defaultAspect: input.defaultAspect,
    captionsByDefault: input.captionsByDefault,
    updatedAt: nowIso(),
  };
  return getStore().put("brand", kit);
}

export async function deleteBrandKit(ownerId: string = LOCAL_OWNER): Promise<void> {
  await getStore().remove("brand", brandKitId(ownerId));
}
