// Scene timing and chapters. How long each scene of a video runs (its words at its pace, its pauses, or its clip),
// shared by the captions, which are timed within each scene's share of the running time, and by the chapters that
// let a viewer jump to a scene. Pure: no store or provider, so the browser can use it too.
import { buildCues, spokenWords } from "./captions";
import { pauseSeconds, stripPauses } from "./pauses";
import { formatTimestamp, graphemes } from "./text";
import type { Scene, Video } from "./types";

export type TimedScene = Pick<Scene, "script" | "speed" | "audioSeconds"> & Partial<Pick<Scene, "overlay" | "audioId" | "name">>;
export type Timed = Pick<Video, "script" | "durationSec" | "speed"> & Partial<Pick<Video, "provider">> & { scenes?: TimedScene[] };

/** A scene a viewer can jump to: where it starts and what to call it. */
export interface Chapter {
  startMs: number;
  title: string;
}

/** Whether the renderer speaks at the speeds asked for; D-ID keeps the voice's natural pace. */
const keepsPace = (video: Timed) => !video.provider || video.provider === "heygen" || video.provider === "mock";

/** A scene's estimated length: its audio clip's, else its words at its own speed (the video's when unset) and its pauses. */
export function sceneSeconds(scene: TimedScene, video: Timed): number {
  if (scene.audioSeconds) return scene.audioSeconds;
  const speed = keepsPace(video) ? scene.speed || video.speed || 1 : 1;
  return spokenWords(stripPauses(scene.script)) / 2.5 / speed + pauseSeconds(scene.script);
}

/**
 * The running time captions are timed to: the rendered length, or an estimate while the provider has not reported
 * one (each scene at its own speed, or its clip's length).
 */
export function captionDurationSec(video: Timed): number {
  if (video.durationSec) return video.durationSec;
  const parts: TimedScene[] = video.scenes?.length ? video.scenes : [{ script: video.script }];
  return Math.max(1, Math.round(parts.reduce((sum, sc) => sum + sceneSeconds(sc, video), 0)));
}

/**
 * Where each scene starts and ends in the running time, its share following its estimated length (a slower scene or a
 * long clip takes more of it). Boundaries come from the running sum, so rounding never drifts and the last scene ends
 * with the video. Null for a video of one scene.
 */
export function sceneBoundsMs(video: Timed): Array<{ startMs: number; endMs: number }> | null {
  const scenes = video.scenes ?? [];
  if (scenes.length < 2) return null;
  const lengths = scenes.map((sc) => Math.max(0.1, sceneSeconds(sc, video)));
  const whole = lengths.reduce((a, b) => a + b, 0);
  const totalMs = Math.round(captionDurationSec(video) * 1000);
  let before = 0;
  return lengths.map((len) => {
    const startMs = Math.round((before / whole) * totalMs);
    before += len;
    return { startMs, endMs: Math.round((before / whole) * totalMs) };
  });
}

/** Longest chapter title, in characters; longer ones end at a word with an ellipsis. */
const MAX_TITLE = 60;

/** A title of at most MAX_TITLE characters (as a reader counts them, so an emoji or a flag is never split), cut back to a word when it must be cut. */
function shortTitle(text: string): string {
  const chars = graphemes(text);
  if (chars.length <= MAX_TITLE) return text;
  // A space right after the limit means the words that fit end there.
  const cut = chars.slice(0, MAX_TITLE).join("");
  const word = chars[MAX_TITLE] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(word > cut.length / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.!?…-]+$/, "")}…`;
}

/** A scene's chapter title: its name, else its on-screen text, else the start of what it says (`said`), else what it is. */
function chapterTitle(scene: TimedScene, index: number, said: string): string {
  const text = scene.name?.replace(/\s+/g, " ").trim() || scene.overlay?.text.replace(/\s+/g, " ").trim() || said.replace(/\s+/g, " ").trim();
  if (!text) return scene.audioId ? `Scene ${index + 1}` : "Opening";
  // A caption line can end mid-sentence on a comma; a title does not.
  return shortTitle(text.replace(/[\s,;:–-]+$/, "") || text);
}

type Cue = { startMs: number; endMs: number; text: string };

/**
 * Corrected caption lines shared out among the scenes, each line to exactly one scene. With as many lines as the
 * captions timed from the scripts would have, an editor changed words or times but kept the lines, so they are the
 * scenes' in order, however far their times moved. Otherwise (lines added or removed) each goes to the scene its middle
 * falls in.
 */
function cuesByScene(video: Timed, bounds: Array<{ startMs: number; endMs: number }>, cues: Cue[]): Cue[][] {
  const counts = video.scenes!.map((sc, i) => buildCues(sc.script, (bounds[i].endMs - bounds[i].startMs) / 1000, 0.9).length);
  const out: Cue[][] = bounds.map(() => []);
  if (counts.reduce((a, b) => a + b, 0) === cues.length) {
    let at = 0;
    counts.forEach((n, i) => (out[i] = cues.slice(at, (at += n))));
    return out;
  }
  for (const cue of cues) {
    const mid = (cue.startMs + cue.endMs) / 2;
    const i = bounds.findIndex((b) => mid < b.endMs);
    out[i < 0 ? bounds.length - 1 : i].push(cue);
  }
  return out;
}

/**
 * One chapter per scene of a video of two scenes or more, starting where its scene does; none otherwise.
 *
 * - When an editor corrected the captions, a scene's chapter starts at its first corrected line (see `cuesByScene`)
 *   and, without a name or on-screen text, takes its lines' words, so a jump lands where the transcript says and a word removed
 *   from the captions is not shown again. A scene left with no line keeps its estimated start and its script's words.
 * - A silent scene with no name or on-screen text is no chapter of its own (it would say only "Pause"), unless it opens the
 *   video, whose first chapter is always at 0:00.
 * - Scenes that would start within the same second as the chapter before are left out, so no two chapters share a time.
 */
export function videoChapters(video: Timed & { captionCues?: Cue[] }): Chapter[] {
  const chapters: Chapter[] = [];
  for (const chapter of sceneChapters(video)) {
    if (!chapter) continue;
    const previous = chapters.at(-1);
    if (previous && Math.floor(chapter.startMs / 1000) <= Math.floor(previous.startMs / 1000)) continue;
    chapters.push(chapter);
  }
  return chapters;
}

/**
 * Each scene's chapter, in order, before those starting within the same second as the one before are left out: where
 * it starts and its title, or null for a scene that is no chapter (see `videoChapters`). With `ignoreNames`, titled as
 * if no scene had a name, which is what a cleared name falls back to. Empty for a video of one scene.
 */
export function sceneChapters(video: Timed & { captionCues?: Cue[] }, { ignoreNames = false }: { ignoreNames?: boolean } = {}): Array<Chapter | null> {
  const bounds = sceneBoundsMs(video);
  if (!bounds) return [];
  const own = video.captionCues?.length ? cuesByScene(video, bounds, video.captionCues) : null;
  return video.scenes!.map((scene, i) => {
    const sc = ignoreNames ? { ...scene, name: undefined } : scene;
    const silent = !sc.audioId && !stripPauses(sc.script).trim();
    if (i > 0 && silent && !sc.overlay?.text.trim() && !sc.name?.trim()) return null;
    let startMs = i === 0 ? 0 : bounds[i].startMs;
    let said = stripPauses(sc.script);
    const lines = own?.[i] ?? [];
    if (own && lines.length) {
      if (i > 0) startMs = lines[0].startMs;
      said = lines.map((c) => c.text).join(" ");
    } else if (own && sc.audioId) {
      // A clip whose lines were all removed has no words left to show.
      said = "";
    }
    return { startMs, title: chapterTitle(sc, i, said) };
  });
}

/** Chapters as a video description lists them ("0:00 Welcome"), one a line, the form YouTube reads. */
export function chaptersText(chapters: Chapter[]): string {
  return chapters.map((c) => `${formatTimestamp(c.startMs / 1000)} ${c.title}`).join("\n");
}

/**
 * Whether YouTube would show these as chapters: at least three, the first at 0:00, each at least ten seconds long
 * (the last one's length taken from the running time).
 */
export function youtubeReadsChapters(chapters: Chapter[], totalMs: number): boolean {
  // Judged on the whole seconds the copied text gives, as YouTube reads them.
  const sec = (ms: number) => Math.floor(ms / 1000);
  if (chapters.length < 3 || sec(chapters[0].startMs) !== 0) return false;
  return chapters.every((c, i) => sec(chapters[i + 1]?.startMs ?? totalMs) - sec(c.startMs) >= 10);
}
