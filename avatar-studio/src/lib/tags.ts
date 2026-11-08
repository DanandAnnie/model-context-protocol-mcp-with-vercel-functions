// Tags on videos: short labels to find a video by, in the library's tag filter and its search. Never on the share page.
// Client-safe: no store or server imports.

/** How many tags a video takes. */
export const VIDEO_TAGS_MAX = 10;
/** The longest tag, in characters. */
export const VIDEO_TAG_MAX = 24;

/** Two tags are the same tag whatever their case (accents count: "cafe" and "café" are two). */
export const sameTag = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** A tag as kept: spaces folded and trimmed (empty when nothing is left). */
export const tagText = (raw: string) => raw.replace(/\s+/g, " ").trim();

/** The tags as kept: each tidied, blanks dropped, the same tag twice (case aside) kept once, in its first spelling. */
export function cleanTags(raw: string[]): string[] {
  const kept: string[] = [];
  for (const r of raw) {
    const t = tagText(r);
    if (t && !kept.some((k) => sameTag(k, t))) kept.push(t);
  }
  return kept;
}

/** Why a set of tags cannot be kept, or null when it can (after cleanTags). */
export function tagsProblem(tags: string[]): string | null {
  if (tags.length > VIDEO_TAGS_MAX) return `A video takes at most ${VIDEO_TAGS_MAX} tags`;
  const long = tags.find((t) => Array.from(t).length > VIDEO_TAG_MAX);
  return long ? `A tag is at most ${VIDEO_TAG_MAX} characters (“${Array.from(long).slice(0, VIDEO_TAG_MAX).join("")}…”)` : null;
}

/**
 * A video's tags with `remove` taken off and `add` put on (each case aside): the ones it keeps stay in their order and
 * spelling, new ones go at the end in the spelling given. A tag both added and removed is added.
 */
export function retagged(current: string[] | undefined, add: string[], remove: string[]): string[] {
  const kept = (current ?? []).filter((t) => !remove.some((r) => sameTag(r, t)) || add.some((a) => sameTag(a, t)));
  return cleanTags([...kept, ...add]);
}

export interface TagCount {
  name: string;
  count: number;
}

/**
 * Each tag on `videos` with how many of them carry it, most used first, then by name. A tag spelled two ways (case
 * aside) is one tag, named as the newest video spelled it.
 */
export function countTags(videos: Array<{ tags?: string[]; createdAt: string }>): TagCount[] {
  const counts: Array<TagCount & { at: string }> = [];
  for (const v of videos) {
    for (const t of v.tags ?? []) {
      const known = counts.find((c) => sameTag(c.name, t));
      if (!known) counts.push({ name: t, count: 1, at: v.createdAt });
      else {
        known.count += 1;
        if (v.createdAt > known.at) Object.assign(known, { name: t, at: v.createdAt });
      }
    }
  }
  return counts
    .map(({ at: _at, ...c }) => c)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}
