// The composition a music mix renders (HyperFrames, HeyGen's HTML-to-video renderer): the finished video full frame
// with its own sound, and the music under it, laid end to end until the video ends, faded in at the start and out at
// the end. Pure, so the page that is sent can be checked without the renderer.
import { dimensionsFor, type AspectRatio } from "./types";

/** Seconds the music takes to rise at the start, and to fall at the end (or less, on a short video). */
const FADE_IN_SEC = 1;
const FADE_OUT_SEC = 2;

/** Text safe inside a double-quoted HTML attribute. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A number of seconds as the renderer reads it: up to three decimals, never in exponent form. */
const secs = (n: number) => String(Math.round(n * 1000) / 1000);

export interface MusicMixLayout {
  videoUrl: string;
  durationSec: number;
  aspect: AspectRatio;
  musicUrl: string;
  musicDurationSec: number;
  volume: number;
}

/** Where each copy of the track plays: one after another from the start, the last cut where the video ends. */
export function musicSegments(durationSec: number, musicDurationSec: number): Array<{ start: number; duration: number }> {
  // A track of unknown length, or under a second, plays once, as long as it lasts (cut at the video's end).
  if (!(musicDurationSec >= 1)) return [{ start: 0, duration: durationSec }];
  const out: Array<{ start: number; duration: number }> = [];
  // As many copies as the video needs (a guard of 4,000 for a page the renderer is sent: an hour of one-second tracks).
  for (let start = 0; start < durationSec - 0.05 && out.length < 4000; start += musicDurationSec) {
    out.push({ start, duration: Math.min(musicDurationSec, durationSec - start) });
  }
  return out;
}

/** The composition's `index.html`. */
export function musicComposition(layout: MusicMixLayout): string {
  const { width, height } = dimensionsFor(layout.aspect);
  const duration = Math.max(0.1, layout.durationSec);
  const volume = Math.min(1, Math.max(0, layout.volume));
  const segments = musicSegments(duration, layout.musicDurationSec);
  const audio = segments
    .map((seg, i) => {
      const fades = [i === 0 ? ` data-fade-in="${secs(Math.min(FADE_IN_SEC, seg.duration / 2))}"` : "", i === segments.length - 1 ? ` data-fade-out="${secs(Math.min(FADE_OUT_SEC, seg.duration / 2))}"` : ""].join("");
      return `    <audio id="music-${i + 1}" src="${attr(layout.musicUrl)}" data-start="${secs(seg.start)}" data-duration="${secs(seg.duration)}" data-media-start="0" data-volume="${secs(volume)}"${fades}></audio>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; background: #000; }
      #mix { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      #footage { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
    </style>
  </head>
  <body>
    <div id="mix" data-composition-id="music-mix" data-start="0" data-width="${width}" data-height="${height}" data-duration="${secs(duration)}" data-no-timeline>
    <video id="footage" src="${attr(layout.videoUrl)}" data-start="0" data-duration="${secs(duration)}" data-has-audio="true" playsinline></video>
${audio}
    </div>
  </body>
</html>
`;
}
