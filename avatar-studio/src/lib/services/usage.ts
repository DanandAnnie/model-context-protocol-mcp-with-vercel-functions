// What else, besides videos, names each presenter and voice: interactive presenters, saved templates, the brand kit's
// defaults, and a photo avatar's default voice. The Avatars and Voices pages show these as a "Used by" line under each
// and warn with them before a delete, beside the videos the library's `needs` counts.
import { z } from "zod";
import { ConflictError, ValidationError } from "../errors";
import { LOCAL_OWNER } from "../owner-id";
import type { Agent, Avatar, BrandKit, VideoTemplate } from "../types";
import { listAgents } from "./agents";
import { getStore } from "../store";
import { getBrandKit } from "./brand";
import { listTemplates } from "./templates";
import { getAvatar } from "./avatars";
import { listVoices } from "./voices";

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

export const replaceUsesSchema = z
  .object({ kind: z.enum(["avatar", "voice"]), from: z.string().min(1).max(200), to: z.string().min(1).max(200) })
  .refine((v) => v.from !== v.to, { message: "Pick a different presenter or voice to use instead", path: ["to"] });

/** How many of each were changed by a replace. */
export interface ReplacedUses {
  agents: number;
  templates: number;
  brand: boolean;
  avatars: number;
}

/** A template with every use of `from` (its own and its scenes') switched to `to`, or null when it names none. */
export function replaceInTemplate(t: VideoTemplate, kind: "avatar" | "voice", from: string, to: string): VideoTemplate | null {
  const key = kind === "avatar" ? "avatarId" : "voiceId";
  let changed = t[key] === from;
  const scenes = t.scenes.map((sc) => {
    if (sc[key] !== from) return sc;
    changed = true;
    return { ...sc, [key]: to };
  });
  return changed ? { ...t, ...(t[key] === from ? { [key]: to } : {}), scenes } : null;
}

/** An interactive presenter switched to `to`, with the presenter or voice details it shows copied over, or null when it does not name `from`. */
export function replaceInAgent(a: Agent, kind: "avatar" | "voice", from: string, to: string, snapshot: Partial<Agent>): Agent | null {
  if ((kind === "avatar" ? a.avatarId : a.voiceId) !== from) return null;
  return { ...a, ...(kind === "avatar" ? { avatarId: to } : { voiceId: to }), ...snapshot };
}

/**
 * Writes `rewrite(current)` while the record still needs it, conditionally on its `updatedAt`: an edit that lands
 * meanwhile is read again and kept, a record deleted meanwhile stays deleted, and one that no longer names the old
 * presenter or voice is left alone. Read fresh just before each write, not from the list taken at the start, so a
 * write that does not move `updatedAt` (a visitor's turn counting itself on an interactive presenter) has only that
 * one round trip to slip in. True when a write landed.
 */
async function rewriteWhileNamed<T extends { id: string; updatedAt: string }>(kind: "agent" | "template" | "brand", first: T, rewrite: (item: T) => T | null): Promise<boolean> {
  if (!rewrite(first)) return false;
  let current: T | null = await getStore().get<T>(kind, first.id);
  for (let attempt = 0; attempt < 5 && current; attempt++) {
    const next = rewrite(current);
    if (!next) return false;
    const stamp = Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1);
    if (await getStore().putIf(kind, { ...next, updatedAt: new Date(stamp).toISOString() }, "updatedAt", current.updatedAt)) return true;
    current = await getStore().get<T>(kind, first.id);
  }
  if (current && rewrite(current)) throw new ConflictError("Something kept changing while the presenter or voice was being replaced; try again");
  return false;
}

/**
 * Switches every interactive presenter, saved template (and its scenes), the brand kit's default, and (for a voice)
 * every photo avatar's default voice from one presenter or voice to another the owner can use. Videos are left as
 * they are: rendered ones keep what they were made with, and the library's counts still show them. The new one is
 * looked up once, before anything is written; an interactive presenter is switched on its own fields only, so one
 * whose other presenter or voice has since been deleted is still switched.
 */
export async function replaceUses(input: z.infer<typeof replaceUsesSchema>, ownerId: string = LOCAL_OWNER): Promise<ReplacedUses> {
  const { kind, from, to } = input;
  let snapshot: Partial<Agent>;
  if (kind === "avatar") {
    const avatar = await getAvatar(to, ownerId); // NotFound for a foreign or unknown presenter
    snapshot = { avatarName: avatar.name, avatarImageUrl: avatar.imageUrl };
  } else {
    const voice = (await listVoices(ownerId)).find((v) => v.id === to);
    if (!voice) throw new ValidationError(`Voice ${to} is not available`);
    snapshot = { voiceLanguage: voice.language };
  }
  const store = getStore();
  const [agents, templates, brand, avatars] = await Promise.all([listAgents(ownerId), listTemplates(ownerId), getBrandKit(ownerId), kind === "voice" ? store.list<Avatar>("avatar", ownerId) : Promise.resolve([] as Avatar[])]);
  const out: ReplacedUses = { agents: 0, templates: 0, brand: false, avatars: 0 };
  for (const a of agents) if (await rewriteWhileNamed("agent", a, (cur) => replaceInAgent(cur, kind, from, to, snapshot))) out.agents++;
  for (const t of templates) if (await rewriteWhileNamed("template", t, (cur) => replaceInTemplate(cur, kind, from, to))) out.templates++;
  const brandKey = kind === "avatar" ? "defaultAvatarId" : "defaultVoiceId";
  if (brand) out.brand = await rewriteWhileNamed("brand", brand, (cur) => (cur[brandKey] === from ? { ...cur, [brandKey]: to } : null));
  for (const a of avatars) {
    if (a.source !== "custom" || a.defaultVoiceId !== from) continue;
    // Photo avatars carry no updatedAt: read again just before the write, which lands only while it still names `from`
    // (a rename landing in that one round trip would be written over; the window is kept that small on purpose).
    const current = await store.get<Avatar>("avatar", a.id);
    if (!current || current.defaultVoiceId !== from) continue;
    if (await store.putIf("avatar", { ...current, defaultVoiceId: to }, "defaultVoiceId", from)) out.avatars++;
  }
  return out;
}
