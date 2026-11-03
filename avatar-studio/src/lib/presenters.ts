// Which of the account's presenters a video shows, and which of its voices it speaks in: the library's presenter and
// voice filters and their counts, and the links to them on the video, Avatars, and Voices pages, read the same rules.
// Separately, which presenters and voices a video needs (videoNeeds), which a delete warns about.
// Safe for the browser (no server modules).
import { silentSeconds } from "./pauses";
import type { Video } from "./types";

type Named = { id: string; name: string };

/** The account's presenters or voices a HeyGen template video was given, by the template's variables of that type. */
function templateSlots(v: Video, type: "character" | "voice"): Named[] {
  const ids = Object.values(v.studioTemplate?.variables ?? {}).flatMap((x) => (x.type === "character" && type === "character" ? [x.avatar_id] : x.type === "voice" && type === "voice" ? [x.voice_id] : []));
  // The template's own name stands in the video's labels, so these are named by the account's lists instead.
  return Array.from(new Set(ids.filter(Boolean)), (id) => ({ id, name: "" }));
}

/**
 * The presenters a video shows, each once, in order of appearance: those of a cinematic shot, else the video's own and
 * its scenes' (a scene without its own presenter shows the video's; one that hides the presenter shows none). A HeyGen
 * template video shows the presenters its character slots were given, and not its labels, which are the template's. A
 * directed video HeyGen cast itself has no presenter id, so none. The names are as the video was made.
 */
export function videoPresenters(v: Video): Named[] {
  if (v.studioTemplate) return templateSlots(v, "character");
  const seen = new Map<string, string>();
  const add = (id: string | undefined, name: string | undefined) => {
    if (id && !seen.has(id)) seen.set(id, name?.trim() || "");
  };
  if (v.cinematic?.avatarIds.length) v.cinematic.avatarIds.forEach((id, i) => add(id, v.cinematic!.avatarNames[i]));
  else if (v.scenes?.length) {
    for (const sc of v.scenes) {
      if (sc.hidePresenter) continue;
      if (sc.avatarId && sc.avatarId !== v.avatarId) add(sc.avatarId, sc.avatarName);
      else add(v.avatarId, v.avatarName);
    }
  } else add(v.avatarId, v.avatarName);
  return Array.from(seen, ([id, name]) => ({ id, name }));
}

/**
 * The voices a video speaks in, each once, in order of appearance: the video's own and its scenes' (a scene without a
 * voice of its own speaks in the video's; one lip-synced to a recording, or one of nothing but pauses, speaks in none).
 * A HeyGen template video speaks in the voices its voice slots were given. A cinematic shot speaks in none of the
 * account's voices (HeyGen voices the shot), and a directed video HeyGen cast itself has no voice id, so none either.
 * The names are as the video was made.
 */
export function videoVoices(v: Video): Named[] {
  if (v.studioTemplate) return templateSlots(v, "voice");
  if (v.cinematic) return [];
  const seen = new Map<string, string>();
  const add = (id: string | undefined, name: string | undefined) => {
    if (id && !seen.has(id)) seen.set(id, name?.trim() || "");
  };
  if (v.scenes?.length) {
    for (const sc of v.scenes) {
      if (sc.audioId || silentSeconds(sc.script) > 0) continue;
      if (sc.voiceId && sc.voiceId !== v.voiceId) add(sc.voiceId, sc.voiceName);
      else add(v.voiceId, v.voiceName);
    }
  } else if (!silentSeconds(v.script)) add(v.voiceId, v.voiceName);
  return Array.from(seen, ([id, name]) => ({ id, name }));
}

/**
 * The presenters and voices a retry or a copy of the video asks for, whether or not a scene shows or speaks in them:
 * the video's own and every scene's (a render checks them all), a cinematic shot's presenters, and a HeyGen template's
 * slots. Wider than videoPresenters and videoVoices, so deleting one warns about every video that would then fail.
 */
export function videoNeeds(v: Video): { avatars: string[]; voices: string[] } {
  if (v.studioTemplate) return { avatars: templateSlots(v, "character").map((p) => p.id), voices: templateSlots(v, "voice").map((p) => p.id) };
  if (v.cinematic) return { avatars: [...new Set(v.cinematic.avatarIds)], voices: [] };
  const avatars = new Set([v.avatarId, ...(v.scenes ?? []).map((sc) => sc.avatarId)].filter((id): id is string => !!id));
  const voices = new Set([v.voiceId, ...(v.scenes ?? []).map((sc) => sc.voiceId)].filter((id): id is string => !!id));
  return { avatars: [...avatars], voices: [...voices] };
}

/** One thing besides a video that names a presenter or voice (see services/usage.ts), as a person would call it. */
export interface OtherUse {
  kind: "agent" | "template" | "brand" | "avatar";
  /** The interactive presenter's, template's, or avatar's name; empty for the brand kit. */
  name: string;
}

const KIND_ONE: Record<OtherUse["kind"], (name: string) => string> = {
  agent: (n) => `the interactive presenter “${n}”`,
  template: (n) => `the template “${n}”`,
  brand: () => "the brand kit",
  avatar: (n) => `the photo avatar “${n}” (as its default voice)`,
};
const KIND_MANY: Record<OtherUse["kind"], string> = { agent: "interactive presenters", template: "templates", brand: "brand kits", avatar: "photo avatars (as their default voice)" };

/** The other uses in words, for a delete's warning: one of a kind by name, more as a count; empty when there are none. */
export function describeOtherUses(uses: OtherUse[] | undefined): string {
  if (!uses?.length) return "";
  const kinds = (["agent", "template", "brand", "avatar"] as const).flatMap((kind) => {
    const of = uses.filter((u) => u.kind === kind);
    return of.length === 0 ? [] : [of.length === 1 ? KIND_ONE[kind](of[0].name) : `${of.length} ${KIND_MANY[kind]}`];
  });
  return kinds.length <= 1 ? kinds.join("") : kinds.length === 2 ? kinds.join(" and ") : `${kinds.slice(0, -1).join(", ")}, and ${kinds[kinds.length - 1]}`;
}

/** One id's other uses from a by-id map (its own entry only: an id like "constructor" is not the object's prototype). */
export function usesOf(byId: Record<string, OtherUse[]> | undefined, id: string): OtherUse[] | undefined {
  return byId && Object.hasOwn(byId, id) ? byId[id] : undefined;
}

/** Every other use by name, one entry each, for the list under a line that counts them (describeOtherUses). */
export function nameOtherUses(uses: OtherUse[] | undefined): string[] {
  return (uses ?? []).map((u) => KIND_ONE[u.kind](u.name));
}

/** What a replace changed, in words ("1 interactive presenter and 2 templates"), for the note after it; empty for nothing. */
export function describeReplaced(r: { agents: number; templates: number; brand: boolean; avatars: number }): string {
  const parts = [
    r.agents ? (r.agents === 1 ? "1 interactive presenter" : `${r.agents} interactive presenters`) : "",
    r.templates ? (r.templates === 1 ? "1 template" : `${r.templates} templates`) : "",
    r.brand ? "the brand kit" : "",
    r.avatars ? (r.avatars === 1 ? "1 photo avatar's default voice" : `${r.avatars} photo avatars' default voice`) : "",
  ].filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  return parts.length === 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}
