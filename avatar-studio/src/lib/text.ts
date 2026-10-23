/** A one-line excerpt for link previews: whitespace collapsed, cut at a word boundary, with an ellipsis. */
export function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat); // code points, so an emoji or CJK character is never cut in half
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max - 1).join("");
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.]+$/, "")}…`;
}
