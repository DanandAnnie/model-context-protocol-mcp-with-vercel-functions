// Fixing spoken lines in a finished video in place (HeyGen's video edit): which videos can be fixed, and which of
// their scenes have a line to fix. Shared by the server and the video page.
import { stripPauses } from "./pauses";
import type { Video } from "./types";

/** Scenes one fix may change (HeyGen edits up to ten scenes a request). */
export const MAX_LINE_FIX_SCENES = 10;
/** A scene's script is at most this long, as when the video is made. */
export const MAX_LINE_CHARS = 5000;

/** Whether a script has words to speak (not only pauses), so its scene has a spoken line. */
export function speaks(script: string | undefined): boolean {
  return !!script && /[\p{L}\p{N}]/u.test(stripPauses(script));
}

/** The video's scenes' scripts, in order (a one-scene video keeps its script on the video), and which have a spoken line. */
export function spokenLines(video: Pick<Video, "scenes" | "script">): Array<{ scene: number; script: string; spoken: boolean }> {
  const scenes = video.scenes?.length ? video.scenes : [{ script: video.script ?? "" }];
  return scenes.map((s, i) => ({ scene: i + 1, script: s.script ?? "", spoken: !("audioId" in s && s.audioId) && speaks(s.script) }));
}

/**
 * Why a video's lines cannot be fixed in place, or null when they can: a finished studio render on HeyGen (or the demo
 * renderer), out of the trash, with a scene that speaks. A directed video's scenes are edited through its Video Agent
 * session; a template, a cinematic shot, and a transparent video are not HeyGen studio renders.
 */
export function lineFixProblem(video: Video): string | null {
  if (video.provider !== "heygen" && video.provider !== "mock") return `Lines cannot be fixed in a video made with the ${video.provider} renderer`;
  if (video.deletedAt) return "Restore the video from the trash before fixing its lines";
  if (video.status !== "completed") return "Its lines can be fixed once the video is ready";
  if (video.directed) return "A video HeyGen's Video Agent directed is changed with Edit scenes";
  if (video.studioTemplate) return "A HeyGen Studio template video cannot have its lines fixed; make it again with new values";
  if (video.cinematic) return "A cinematic shot cannot have its lines fixed; make it again";
  if (video.transparent) return "A transparent video cannot have its lines fixed; make a copy instead";
  if (!spokenLines(video).some((l) => l.spoken)) return "This video has no spoken lines to fix";
  return null;
}
