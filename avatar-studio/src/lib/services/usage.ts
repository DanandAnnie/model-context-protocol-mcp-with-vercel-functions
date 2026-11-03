// What else, besides videos, names each presenter and voice: interactive presenters, saved templates, the brand kit's
// defaults, and a photo avatar's default voice. The Avatars and Voices pages show these as a "Used by" line under each
// and warn with them before a delete, beside the videos the library's `needs` counts.
import { LOCAL_OWNER } from "../owner-id";
import type { Agent, Avatar, BrandKit, VideoTemplate } from "../types";
import { listAgents } from "./agents";
import { getStore } from "../store";
import { getBrandKit } from "./brand";
import { listTemplates } from "./templates";

import { describeOtherUses, type OtherUse } from "../presenters";
export { describeOtherUses, type OtherUse };

export interface OtherUses {
  avatars: Record<string, OtherUse[]>;
  voices: Record<string, OtherUse[]>;
}

/** The other uses of each presenter and voice among the given records, each listed once per thing that names it. */
export function collectOtherUses(input: { agents: Agent[]; templates: VideoTemplate[]; brand: BrandKit | null; avatars: Avatar[] }): OtherUses {
  const avatars = new Map<string, OtherUse[]>();
  const voices = new Map<string, OtherUse[]>();
  const note = (map: Map<string, OtherUse[]>, ids: Array<string | undefined>, use: OtherUse) => {
    for (const id of new Set(ids.filter((x): x is string => !!x))) map.set(id, [...(map.get(id) ?? []), use]);
  };
  for (const a of input.agents) {
    note(avatars, [a.avatarId], { kind: "agent", name: a.name });
    note(voices, [a.voiceId], { kind: "agent", name: a.name });
  }
  for (const t of input.templates) {
    note(avatars, [t.avatarId, ...t.scenes.map((sc) => sc.avatarId)], { kind: "template", name: t.title });
    note(voices, [t.voiceId, ...t.scenes.map((sc) => sc.voiceId)], { kind: "template", name: t.title });
  }
  if (input.brand) {
    note(avatars, [input.brand.defaultAvatarId], { kind: "brand", name: "" });
    note(voices, [input.brand.defaultVoiceId], { kind: "brand", name: "" });
  }
  for (const a of input.avatars) if (a.source === "custom") note(voices, [a.defaultVoiceId], { kind: "avatar", name: a.name });
  return { avatars: Object.fromEntries(avatars), voices: Object.fromEntries(voices) };
}

/** The owner's other uses of each presenter and voice (see collectOtherUses). */
export async function otherUses(ownerId: string = LOCAL_OWNER): Promise<OtherUses> {
  // The owner's own photo avatars straight from the store: the renderer's library has no default voices to name, and
  // listing it would ask the renderer on every page load.
  const [agents, templates, brand, avatars] = await Promise.all([listAgents(ownerId), listTemplates(ownerId), getBrandKit(ownerId), getStore().list<Avatar>("avatar", ownerId)]);
  return collectOtherUses({ agents, templates, brand, avatars });
}
