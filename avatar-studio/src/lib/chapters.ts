// Scene timing and chapters. How long each scene of a video runs (its words at its pace, its pauses, or its clip),
// shared by the captions, which are timed within each scene's share of the running time, and by the chapters that
// let a viewer jump to a scene. Pure: no store or provider, so the browser can use it too.
import { spokenWords } from "./captions";
import { pauseSeconds, stripPauses } from "./pauses";
import { formatTimestamp } from "./text";
import type { Scene, Video } from "./types";

export type TimedScene = Pick<Scene, "script" | "speed" | "audioSeconds"> & Partial<Pick<Scene, "overlay" | "audioId">>;
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

/** A title of at most MAX_TITLE characters (whole characters, so an emoji is never split), cut back to a word when it must be cut. */
function shortTitle(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_TITLE) return text;
  // A space right after the limit means the words that fit end there.
  const cut = chars.slice(0, MAX_TITLE).join("");
  const word = chars[MAX_TITLE] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(word > cut.length / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.!?…-]+$/, "")}…`;
}

/** A scene's chapter title: its on-screen text, else the start of what it says (`said`), else what it is. */
function chapterTitle(scene: TimedScene, index: number, said: string): string {
  const text = scene.overlay?.text.replace(/\s+/g, " ").trim() || said.replace(/\s+/g, " ").trim();
  if (!text) return scene.audioId ? `Scene ${index + 1}` : "Pause";
  return shortTitle(text);
}

/**
 * One chapter per scene of a video of two scenes or more, starting where its scene does; none otherwise. When an
 * editor corrected the captions, each chapter after the first starts at the corrected line nearest its scene's start
 * and, without on-screen text, takes that line's words, so a jump lands where the transcript says and a word removed
 * from the captions is not shown again. Scenes that would start within the same second as the chapter before are
 * left out, so no two chapters share a time.
 */
export function videoChapters(video: Timed & { captionCues?: Array<{ startMs: number; text: string }> }): Chapter[] {
  const bounds = sceneBoundsMs(video);
  if (!bounds) return [];
  const cues = video.captionCues?.length ? video.captionCues : null;
  const chapters: Chapter[] = [];
  video.scenes!.forEach((sc, i) => {
    let startMs = bounds[i].startMs;
    let said = stripPauses(sc.script);
    if (cues) {
      const after = chapters.at(-1)?.startMs ?? -1;
      const nearest = cues.filter((c) => c.startMs > after).sort((a, b) => Math.abs(a.startMs - startMs) - Math.abs(b.startMs - startMs))[0];
      if (i === 0) said = cues[0].text;
      else if (nearest) {
        startMs = nearest.startMs;
        said = nearest.text;
      }
    }
    const previous = chapters.at(-1);
    if (previous && Math.floor(startMs / 1000) <= Math.floor(previous.startMs / 1000)) return;
    chapters.push({ startMs: i === 0 ? 0 : startMs, title: chapterTitle(sc, i, said) });
  });
  return chapters;
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
