// Avatars: library presenters and custom photo avatars. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getAvatarProvider } from "../providers";
import { getStore } from "../store";
import type { Avatar } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { NotFoundError } from "../errors";
import { memo } from "../cache";
import { LIST_TTL_MS, owned } from "./shared";

/** Provider avatar list, memoised per provider for a few minutes. */
export function providerAvatars(): Promise<Avatar[]> {
  const p = getAvatarProvider();
  return memo(`avatars:${p.name}`, LIST_TTL_MS, () => p.listAvatars());
}

export async function listAvatars(ownerId: string = LOCAL_OWNER): Promise<Avatar[]> {
  const [provider, custom] = await Promise.all([providerAvatars(), getStore().list<Avatar>("avatar", ownerId)]);
  custom.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return [...custom, ...provider];
}

export async function getAvatar(id: string, ownerId: string = LOCAL_OWNER): Promise<Avatar> {
  const custom = await getStore().get<Avatar>("avatar", id);
  if (custom) return owned(custom, ownerId, `Avatar ${id}`);
  const match = (await providerAvatars()).find((a) => a.id === id);
  if (!match) throw new NotFoundError(`Avatar ${id} not found`);
  return match;
}

export const createAvatarSchema = z.object({
  name: z.string().trim().min(1).max(80),
  imageUrl: z
    .string()
    .min(1)
    .max(8_000_000, "Uploaded image must be under 6 MB")
    .refine((v) => v.startsWith("data:image/") || /^https?:\/\//.test(v), "Must be an image URL or uploaded image"),
  gender: z.enum(["male", "female", "neutral"]).optional(),
});

export async function createAvatar(input: z.infer<typeof createAvatarSchema>, ownerId: string = LOCAL_OWNER): Promise<Avatar> {
  const avatar: Avatar = {
    id: newId("av"),
    ownerId,
    name: input.name,
    imageUrl: input.imageUrl,
    gender: input.gender,
    source: "custom",
    provider: getAvatarProvider().name,
    tags: ["photo avatar"],
    createdAt: nowIso(),
  };
  return getStore().put("avatar", avatar);
}

export async function deleteAvatar(id: string, ownerId: string = LOCAL_OWNER): Promise<void> {
  owned(await getStore().get<Avatar>("avatar", id), ownerId, `Avatar ${id}`);
  await getStore().remove("avatar", id);
}
