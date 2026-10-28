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
