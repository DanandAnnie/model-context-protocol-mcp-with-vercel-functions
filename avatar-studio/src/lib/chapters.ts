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

/** A scene's chapter title: its on-screen text, else the start of what it says, else what it is. */
function chapterTitle(scene: TimedScene, index: number): string {
  const shown = scene.overlay?.text.replace(/\s+/g, " ").trim();
  const said = stripPauses(scene.script).replace(/\s+/g, " ").trim();
  const text = shown || said;
  if (!text) return scene.audioId ? `Scene ${index + 1}` : "Pause";
  if (text.length <= MAX_TITLE) return text;
  const cut = text.slice(0, MAX_TITLE);
  const word = cut.lastIndexOf(" ");
  return `${(word > MAX_TITLE / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.!?…-]+$/, "")}…`;
}

/** One chapter per scene of a video of two scenes or more, starting where its scene does; none otherwise. */
export function videoChapters(video: Timed): Chapter[] {
  const bounds = sceneBoundsMs(video);
  if (!bounds) return [];
  return video.scenes!.map((sc, i) => ({ startMs: bounds[i].startMs, title: chapterTitle(sc, i) }));
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
  if (chapters.length < 3 || chapters[0].startMs !== 0) return false;
  return chapters.every((c, i) => (chapters[i + 1]?.startMs ?? totalMs) - c.startMs >= 10_000);
}
