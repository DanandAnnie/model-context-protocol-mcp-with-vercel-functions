// Listening to a whole video's script before it is made: what plays for each scene, in order, and the script cut into
// pieces the voice preview takes. Pure, so the editor and the tests share it.
import { PAUSE_MARKER, silentSeconds, stripPauses } from "./pauses";
import type { Scene, Voice } from "./types";

/** The most characters one voice preview speaks (the preview route's limit). */
export const MAX_PREVIEW_CHARS = 600;

export type PreviewItem =
  | { scene: number; kind: "speech"; voice: Voice; text: string; speed: number }
  | { scene: number; kind: "clip"; clipId: string }
  | { scene: number; kind: "silence"; seconds: number };

/**
 * A script cut into pieces of at most `max` characters, at the end of a sentence where one fits, else at a space,
 * and never inside a pause marker; blank pieces are left out.
 */
export function previewChunks(text: string, max = MAX_PREVIEW_CHARS): string[] {
  // A marker's own "1.5s" is no sentence end, so markers stand in as a sign of the same length while the text is cut.
  const markers: string[] = [];
  const masked = text.replace(new RegExp(PAUSE_MARKER, "gi"), (m) => {
    markers.push(m);
    return "\uE000".repeat(m.length);
  });
  const unmask = (piece: string) => piece.replace(/\uE000+/g, (run) => {
    let out = "";
    for (let left = run.length; left > 0 && markers.length; ) {
      const m = markers.shift()!;
      out += m;
      left -= m.length;
    }
    return out;
  });
  // Each sentence with its closing marks and the space after it; whatever follows the last one stands on its own.
  const sentences = masked.match(/[^.!?。！？]*[.!?。！？]+["'”’)\]]*\s*|[^.!?。！？]+$/g) ?? [];
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const s of sentences) {
    if (cur.length + s.length <= max) {
      cur += s;
      continue;
    }
    push();
    let rest = s;
    while (rest.length > max) {
      // At the last space that fits, stepping back out of a pause marker the cut would land in.
      let cut = rest.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      // Never inside a marker: back to where it starts.
      while (cut > 0 && rest[cut] === "\uE000" && rest[cut - 1] === "\uE000") cut--;
      if (cut <= 0) cut = Math.min(rest.length, max);
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trimStart();
    }
    cur = rest;
  }
  push();
  return out.map(unmask).filter((c) => stripPauses(c).trim());
}

/**
 * What plays for each scene, in order: its words in its voice at its pace, its recorded clip, or its silent hold.
 * A scene with nothing to play (no words yet, or no voice to speak them) is passed over.
 */
export function previewPlaylist(scenes: Scene[], voiceFor: (sc: Scene) => Voice | null, videoSpeed: number): PreviewItem[] {
  const items: PreviewItem[] = [];
  scenes.forEach((sc, scene) => {
    if (sc.audioId) return void items.push({ scene, kind: "clip", clipId: sc.audioId });
    const hold = silentSeconds(sc.script);
    if (hold) return void items.push({ scene, kind: "silence", seconds: hold });
    const voice = voiceFor(sc);
    if (!voice || !stripPauses(sc.script).trim()) return;
    for (const text of previewChunks(sc.script)) items.push({ scene, kind: "speech", voice, text, speed: sc.speed ?? videoSpeed });
  });
  return items;
}
