// One scene's presenter, voice, and pace given to the other scenes, where each applies. Pure, so the editor and the
// tests share it.
import { silentSeconds } from "./pauses";
import type { Scene } from "./types";

export type CastPart = "presenter" | "voice" | "pace";

/** Whether a scene is spoken by a voice (not a recorded clip, not a silent hold), so its voice and pace are heard. */
const spoken = (sc: Scene) => !sc.audioId && !silentSeconds(sc.script);

/** What of a scene's cast can be given to others: its presenter when shown, its voice and pace when they are heard. */
export function castParts(sc: Scene): CastPart[] {
  return [...(!sc.hidePresenter ? (["presenter"] as const) : []), ...(spoken(sc) ? (["voice", "pace"] as const) : [])];
}

/**
 * The scenes with scene `from`'s presenter, voice, and pace (each "the video's" when the scene has none of its own)
 * on every other scene they apply to: the presenter on every scene (kept by one without the presenter for when it is
 * shown again), the voice and pace on every scene not playing a recorded clip. `changed` lists the scenes (from 0)
 * that differ and `parts` what differs on any of them; the others are kept as they were, the same objects. `own` says
 * whether the scene has any of the given parts of its own, rather than the video's.
 */
export function castEverywhere(scenes: Scene[], from: number): { scenes: Scene[]; changed: number[]; parts: CastPart[]; own: boolean } {
  const src = scenes[from];
  if (!src) return { scenes, changed: [], parts: [], own: false };
  const offered = castParts(src);
  const changed: number[] = [];
  const parts = new Set<CastPart>();
  const next = scenes.map((sc, i) => {
    if (i === from) return sc;
    const patch: Partial<Pick<Scene, "avatarId" | "voiceId" | "speed">> = {};
    if (offered.includes("presenter") && sc.avatarId !== src.avatarId) patch.avatarId = src.avatarId;
    if (offered.includes("voice") && !sc.audioId && sc.voiceId !== src.voiceId) patch.voiceId = src.voiceId;
    if (offered.includes("pace") && !sc.audioId && sc.speed !== src.speed) patch.speed = src.speed;
    if (!Object.keys(patch).length) return sc;
    changed.push(i);
    if ("avatarId" in patch) parts.add("presenter");
    if ("voiceId" in patch) parts.add("voice");
    if ("speed" in patch) parts.add("pace");
    const out: Scene = { ...sc, ...patch };
    // "The video's" is stored as no value at all, as the editor does.
    for (const k of Object.keys(patch) as Array<keyof typeof patch>) if (out[k] === undefined) delete out[k];
    return out;
  });
  const given = offered.filter((p) => parts.has(p));
  const own = given.some((p) => (p === "presenter" ? src.avatarId : p === "voice" ? src.voiceId : src.speed) !== undefined);
  return { scenes: changed.length ? next : scenes, changed, parts: given, own };
}

/** "presenter, voice, and pace": the parts as a sentence names them. */
export function partsPhrase(parts: CastPart[]): string {
  return parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** "Scene 2" or "Scenes 2, 3, and 5", from scenes counted from 0. */
export function scenesPhrase(indexes: number[]): string {
  const n = indexes.map((i) => i + 1);
  if (n.length === 1) return `Scene ${n[0]}`;
  return `Scenes ${n.length === 2 ? `${n[0]} and ${n[1]}` : `${n.slice(0, -1).join(", ")}, and ${n[n.length - 1]}`}`;
}
