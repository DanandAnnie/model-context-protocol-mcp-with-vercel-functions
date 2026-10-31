/** Where the share player last was while playing: the chapter it was in (by the scene it opens) and the time. */
export type PlayMark = { scene: number; ms: number } | null;

/**
 * Which chapters a time update of the share player shows were played, from the one before it while playing (`last`,
 * cleared by a seek or a pause). A chapter counts once the playhead has moved on within it, or has run on from it
 * into a later one with no seek between, which also covers a chapter too short to see two time updates of its own and
 * any a sparse background tab ran past. Only the chapters the page lists count: one timed past the clip's real end
 * (`clipMs`, an estimate's leftover) is none, as `ShareChapters` has it, and fewer than two are no list at all.
 */
export function chaptersPlayed(
  chapters: ReadonlyArray<{ startMs: number; scene: number }>,
  clipMs: number,
  last: PlayMark,
  ms: number,
): { mark: PlayMark; played: number[] } {
  const shown = chapters.filter((c, i) => i === 0 || c.startMs < clipMs - 500);
  if (shown.length < 2) return { mark: null, played: [] };
  let at = -1;
  while (at + 1 < shown.length && shown[at + 1].startMs <= ms) at++;
  if (at < 0) return { mark: null, played: [] };
  const mark = { scene: shown[at].scene, ms };
  const from = last ? shown.findIndex((c) => c.scene === last.scene) : -1;
  if (!last || from < 0 || ms <= last.ms || from > at) return { mark, played: [] };
  // Still in the same chapter: it was played. Run on into a later one: every chapter from the last up to this one was.
  const played = from === at ? [shown[at].scene] : shown.slice(from, at).map((c) => c.scene);
  return { mark, played };
}
