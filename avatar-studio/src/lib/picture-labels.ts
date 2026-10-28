// The labels a description uses for the pictures a clip features: HeyGen Video names reference pictures <Picture 1>,
// <Picture 2>… in the order they are sent and does not rewrite them, so a label must name a picture that is there.
// Shared by the B-roll page (renumbering when a picture is removed) and the server (refusing a label with no picture).

const LABEL = /<Picture\s*(\d+)>/gi;

/** The picture numbers a description names, in the order they appear (repeats included). */
export function pictureLabels(prompt: string): number[] {
  return Array.from(prompt.matchAll(LABEL), (m) => Number(m[1]));
}

/** The labels that name no picture when `count` are featured (none featured makes every label one of them). */
export function danglingLabels(prompt: string, count: number): number[] {
  return [...new Set(pictureLabels(prompt).filter((n) => n < 1 || n > count))].sort((a, b) => a - b);
}

/**
 * The description once picture `removed` (1-based) is taken away: its label goes, with the space before it, and the
 * labels of the pictures after it move down a number, as the pictures themselves do.
 */
export function withPictureRemoved(prompt: string, removed: number): string {
  return prompt
    .replace(/[ \t]*<Picture\s*(\d+)>/gi, (whole, n: string) => {
      const at = Number(n);
      if (at === removed) return "";
      return at > removed ? whole.replace(/\d+/, String(at - 1)) : whole;
    })
    .replace(/^[ \t]+/, "");
}

/**
 * The description with `label` put in at the selection `start`–`end`: a selection is replaced unless it touches a
 * label (then the new one goes after it), a cursor inside a label moves past it, and spaces keep the label apart
 * from the words around it. Null when the result would be longer than `max`: nothing is cut to make room.
 */
export function insertPictureLabel(prompt: string, label: string, start: number, end: number, max: number): { text: string; caret: number } | null {
  let from = Math.max(0, Math.min(start, prompt.length));
  let to = Math.max(from, Math.min(end, prompt.length));
  for (const m of prompt.matchAll(LABEL)) {
    const a = m.index;
    const b = a + m[0].length;
    if (from < to && from < b && to > a) {
      // A selection over (part of) a label is not replaced, so no picture's name is lost.
      from = to = Math.max(to, b);
    }
    if (from === to && from > a && from < b) from = to = b;
  }
  const before = prompt.slice(0, from);
  const after = prompt.slice(to);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const text = `${before}${lead}${label}${trail}${after}`;
  if (text.length > max) return null;
  return { text, caret: before.length + lead.length + label.length };
}
