// Look packs: curated sets of new looks (wardrobe, palette, and setting) for a photo avatar the account made, generated
// by the renderer around the avatar's own face (HeyGen Look Packs). Shared by the server and the avatars page.

/** The packs offered, in the order shown. Style packs keep the setting neutral; role packs put the presenter in a job. */
export const LOOK_PACKS = [
  { key: "modern-corporate", name: "Modern corporate", kind: "style" },
  { key: "business-casual", name: "Stylish business-casual", kind: "style" },
  { key: "scandinavian-minimal", name: "Scandinavian minimal", kind: "style" },
  { key: "cool-tech", name: "Cool tech", kind: "style" },
  { key: "healthcare", name: "Healthcare", kind: "role" },
  { key: "keynote", name: "Keynote presenter", kind: "role" },
  { key: "fitness", name: "Fitness", kind: "role" },
  { key: "car-dealership", name: "Car dealership", kind: "role" },
] as const;

export type LookPackKey = (typeof LOOK_PACKS)[number]["key"];
export const LOOK_PACK_KEYS = LOOK_PACKS.map((p) => p.key) as [LookPackKey, ...LookPackKey[]];

/** A pack's frames are made landscape; portrait is a centre crop of them. */
export const LOOK_PACK_ASPECTS = ["16:9", "9:16"] as const;
export type LookPackAspect = (typeof LOOK_PACK_ASPECTS)[number];

export function lookPackName(key: string): string {
  return LOOK_PACKS.find((p) => p.key === key)?.name ?? "Look pack";
}
