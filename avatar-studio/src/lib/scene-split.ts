// Splitting a scene in two at the cursor and merging a scene with the next, as HeyGen's editor does. Pure, so the
// editor and the tests share it.
import { silentProblem, silentSeconds } from "./pauses";
import { insidePause } from "./script-import";
import type { Scene } from "./types";

/** Letters of scripts written with spaces between words: a cut between two of them falls inside a word. */
const SPACED = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Georgian}\p{N}'’-]/u;

/**
 * The script cut at `at` into the words before and after it, or null when the cut leaves nothing on one side, falls
 * inside a word or a pause marker, or leaves a side of only pauses too short or long to be a silent scene. (Text
 * without spaces, as Chinese or Japanese is written, can be cut between any two characters.)
 */
export function splitScript(script: string, at: number): [string, string] | null {
  if (at <= 0 || at >= script.length || insidePause(script, at)) return null;
  if (SPACED.test(script[at - 1]) && SPACED.test(script[at])) return null;
  const before = script.slice(0, at).trimEnd();
  const after = script.slice(at).trimStart();
  if (!before || !after || silentProblem(before) || silentProblem(after)) return null;
  return [before, after];
}

/**
 * A scene cut in two at `at` in its script: both keep its presenter, voice, background, layout, and pace, and its
 * on-screen text stays with the first. Null when `splitScript` refuses the cut or the scene speaks a recorded clip
 * (a recording cannot be cut by its words).
 */
export function splitScene(scene: Scene, at: number): [Scene, Scene] | null {
  if (scene.audioId) return null;
  const parts = splitScript(scene.script, at);
  if (!parts) return null;
  const { overlay: _kept, ...rest } = scene;
  return [{ ...scene, script: parts[0] }, { ...rest, script: parts[1] }];
}

/** What the second of two merged scenes renders with that the first does not, in words. */
export type MergeLoss = "presenter" | "presenter layout" | "voice" | "pace" | "background" | "on-screen text" | "choice to show or hide the presenter";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A scene and the one after it as one: the first's script, a blank line, then the second's, with everything else the
 * first's (the second's on-screen text when the first has none). `lost` names what the second renders differently and
 * so goes: its presenter and layout only when it shows one, its voice and pace only when it speaks. Null when either
 * speaks a recorded clip, which cannot be joined to other words, or when the two together would be a silent scene too
 * long to be one.
 */
export function mergeScenes(first: Scene, second: Scene): { scene: Scene; lost: MergeLoss[] } | null {
  if (first.audioId || second.audioId) return null;
  const script = [first.script.trimEnd(), second.script.trimStart()].filter(Boolean).join("\n\n");
  if (silentProblem(script)) return null;
  const overlay = first.overlay ?? second.overlay;
  const lost: MergeLoss[] = [];
  const shows = !first.hidePresenter && !second.hidePresenter;
  if (!same(first.hidePresenter, second.hidePresenter)) lost.push("choice to show or hide the presenter");
  if (shows && !same(first.avatarId, second.avatarId)) lost.push("presenter");
  if (shows && !same(first.layout, second.layout)) lost.push("presenter layout");
  const speaks = !silentSeconds(second.script);
  if (speaks && !same(first.voiceId, second.voiceId)) lost.push("voice");
  if (speaks && !same(first.speed, second.speed)) lost.push("pace");
  if (!same(first.background, second.background)) lost.push("background");
  if (first.overlay && second.overlay && !same(first.overlay, second.overlay)) lost.push("on-screen text");
  return { scene: { ...first, script, ...(overlay ? { overlay } : {}) }, lost };
}
