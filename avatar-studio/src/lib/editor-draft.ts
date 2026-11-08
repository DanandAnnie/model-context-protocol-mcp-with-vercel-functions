// The editor's unsent draft, kept by the browser per space: where it is, and what Home says about it.
import { wordCount } from "./client";
import { stripPauses } from "./pauses";
import { graphemes } from "./text";

/** Where the personal space's draft is kept; a workspace's has its id after it (see `draftKeyFor`). */
export const DRAFT_KEY = "avatar-studio:draft";

/**
 * Each space keeps its own draft: one started in Personal never shows up, or loses its uploaded images, in a
 * workspace (the images are the space's own). Personal keeps the original key, so drafts saved before survive.
 */
export function draftKeyFor(spaces: { personalId: string; activeId: string } | null): string | null {
  return spaces ? (spaces.activeId === spaces.personalId ? DRAFT_KEY : `${DRAFT_KEY}:${spaces.activeId}`) : null;
}

/**
 * Whether a stored draft's scenes are ones the editor can restore: at least one, each an object with its script as
 * text. A draft is the browser's own copy, written by whatever build ran then, so the editor and Home both check this
 * before trusting it, and Home never offers a draft the editor would refuse.
 */
export function restorableScenes(scenes: unknown): scenes is Array<{ script: string }> {
  return Array.isArray(scenes) && scenes.length > 0 && scenes.every((s) => !!s && typeof s === "object" && typeof (s as { script?: unknown }).script === "string");
}

/** What Home shows of a draft: its title (empty when it has none), how many scenes and words, its opening words, and when it was saved. */
export type DraftSummary = { title: string; scenes: number; words: number; opening: string; savedAt: string };

/** The longest opening Home shows, in characters, before an ellipsis. */
export const DRAFT_OPENING_MAX = 120;

/**
 * A draft as the editor saved it (the stored JSON), summed up for Home, or null when there is none the editor would
 * restore: nothing stored, not JSON, or scenes it cannot restore. The title and saved time are read only when they
 * have the shape this build expects; words are counted as the editor counts them, so pause markers are not words.
 */
export function draftSummary(raw: string | null): DraftSummary | null {
  if (!raw) return null;
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  const { title, scenes, savedAt } = d as { title?: unknown; scenes?: unknown; savedAt?: unknown };
  if (!restorableScenes(scenes)) return null;
  const words = scenes.reduce((n, s) => n + wordCount(s.script), 0);
  const first = scenes.map((s) => stripPauses(s.script)).find((s) => s.trim())?.replace(/\s+/g, " ").trim() ?? "";
  // Cut by what a reader sees as one character, so a flag or an emoji with a skin tone at the edge stays whole.
  const chars = graphemes(first);
  const opening = chars.length > DRAFT_OPENING_MAX ? `${chars.slice(0, DRAFT_OPENING_MAX - 1).join("").trimEnd()}…` : first;
  const saved = typeof savedAt === "string" && !Number.isNaN(Date.parse(savedAt)) ? savedAt : "";
  return { title: typeof title === "string" ? title.trim() : "", scenes: scenes.length, words, opening, savedAt: saved };
}
