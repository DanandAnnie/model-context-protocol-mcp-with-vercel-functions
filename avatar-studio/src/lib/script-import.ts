// Turning a text or Markdown document into scenes for the editor. Pure, so the editor and the tests share it.
import { PAUSE_MARKER, silentProblem, stripPauses } from "./pauses";
import { MAX_SCENES } from "./types";

/** The most a video's script may hold, all scenes together, as the video schema checks it (scenes joined by a blank line). */
export const MAX_SCRIPT_CHARS = 5000;
/** The largest file the editor reads; a script document is a few kilobytes. */
export const MAX_IMPORT_BYTES = 1_000_000;
const SEPARATOR = "\n\n";
/** The shortest piece worth keeping when a cut has to fall between words rather than after a sentence. */
const MIN_PIECE = 40;
/**
 * How much script is read: a video keeps 5000 characters, and Markdown seldom takes more than a few times that
 * to write, so reading further only costs time (the editor runs this on the page's own thread). Lines that are
 * never spoken (definitions, front matter, fences' own lines) do not count.
 */
const READ_CHARS = MAX_SCRIPT_CHARS * 8;
const MAX_LINE_CHARS = MAX_SCRIPT_CHARS * 2;

export interface ImportedScript {
  /** One script per scene, in order; together (joined by a blank line) within `MAX_SCRIPT_CHARS`. Empty when the document has no words. */
  scenes: string[];
  /** The document's top-level heading, offered as the video title. */
  title?: string;
  /** True when the document held more than a video takes (`MAX_SCENES` scenes, `MAX_SCRIPT_CHARS` characters) and the rest was left out. */
  truncated: boolean;
}

/** A line of three or more `-`, `*`, or `_` (spaces between allowed), which starts a new scene. */
export const BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
/** Lines of only `=` or only `#` divide too, when they are not a heading's underline or a heading. */
const RULE = /^\s{0,3}(?:=+|#+)\s*$/;
const SETEXT = /^\s{0,3}=+\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/;
const ORDERED = /^\s*(\d{1,3})[.)]\s+/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
/** Fence labels whose content is the script itself in Markdown: only the fence lines are dropped. */
const MARKDOWN_FENCE = new Set(["markdown", "md"]);
// What a link reference definition points at: <…>, a URL with a scheme, a path, an anchor, or a domain.
// "[GUEST]: Thanks." and "[HOST]: 10:30am" are lines of script.
const LINK_TARGET = String.raw`(?:<[^<>]*>|[a-z][a-z0-9+.-]*:\S+|\.{0,2}\/\S*|#[\w-]*[a-z][\w-]*|www\.\S+|[\w-]+(?:\.[\w-]+)+\/\S*|[\w-]+\.(?:png|jpe?g|gif|svg|webp|pdf|html?|md|txt|docx?)(?:[?#]\S*)?)`;
const LINK_DEFINITION = new RegExp(String.raw`^\s{0,3}\[[^\]^][^\]]*\]:\s*` + LINK_TARGET + String.raw`(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$`, "i");
const FOOTNOTE_DEFINITION = /^\s{0,3}\[\^[^\]]+\]:/;
/** Any reference definition's shape: dropped when the document refers to its label. */
const REFERENCE_DEFINITION = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
// A table's header rule has a pipe; a bare --- is a scene break.
const TABLE_RULE = /^(?=[^|]*\|)\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const PAUSE = new RegExp(PAUSE_MARKER, "gi");
// Tags a document may use for formatting; anything else between < and > is prose ("from <1% to >5%", "a <b and c>").
const TAG = /<\/?(?:a|abbr|article|aside|b|big|blockquote|br|center|details|figcaption|figure|section|summary|cite|code|del|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|q|s|small|span|strike|strong|sub|sup|table|tbody|td|th|thead|tr|tt|u|ul)(?:\s+[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))*\s*\/?>/gi;
// A link destination: no spaces, one level of parentheses ("…/Mercury_(planet)"), and an optional quoted title.
const DESTINATION = String.raw`\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)`;
// Sentence ends: Latin punctuation before a space, and CJK, Arabic, and Devanagari full stops anywhere.
const SENTENCE_END = /[.!?…]["'”’“»)\]]*(?=\s|$)|[。！？．؟।۔]["'”’」』)\]]*/g;
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  laquo: "«", raquo: "»", bull: "•", middot: "·", deg: "°", times: "×", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢",
  iexcl: "¡", iquest: "¿", szlig: "ß", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", agrave: "à", egrave: "è", ccedil: "ç",
  ntilde: "ñ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", Eacute: "É",
};
/** Marks a line inside a code fence, to be read as written. */
const VERBATIM = "\u0001";
/** Fence info strings that mean "this is the document itself", as a chat assistant wraps a script. */
const DOCUMENT_FENCE = new Set(["", "markdown", "md", "text", "txt", "plaintext"]);

/**
 * A file's text, whatever a word processor saved it as: UTF-16 by its byte-order mark, UTF-8 when it is valid
 * UTF-8, and otherwise Windows-1252 (what Word's "Plain Text" export writes by default on Windows).
 */
export function decodeScript(bytes: Uint8Array, legacy = "windows-1252"): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  // A � the file already held (bytes EF BF BD) is text, not a decoding failure.
  let held = 0;
  for (let i = bytes.indexOf(0xef); i >= 0 && i + 2 < bytes.length; i = bytes.indexOf(0xef, i + 1)) if (bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) held++;
  const bad = (utf8.match(/\ufffd/g)?.length ?? 0) - held;
  // Valid multi-byte sequences almost never arise by chance in a legacy file, so UTF-8 with a stray byte or two
  // keeps its text (each bad byte becomes one �) while a file of mostly invalid sequences is a legacy one.
  const valid = (utf8.match(/[^\x00-\x7f]/g)?.length ?? 0) - bad - held;
  if (bad <= 0 || valid >= bad) return utf8;
  if (legacy !== "windows-1252") {
    try {
      // A single-byte page (Cyrillic, Greek, Central European, …) is read strictly: a byte it leaves undefined
      // means the file was written in another one. (Its C1 bytes, as in a pasted emoji, are defined.)
      if (!/^(?:shift_jis|gbk|gb18030|big5|euc-kr|euc-jp)$/.test(legacy)) return new TextDecoder(legacy, { fatal: true }).decode(bytes);
      let text = new TextDecoder(legacy).decode(bytes);
      // Some double-byte decoders (EUC-KR, Big5) pass a byte they cannot place through as a C1 control, which no
      // real text holds: it is a bad byte like any other.
      text = text.replace(/[\x80-\x9f]/g, "\ufffd");
      if (!text.includes("\ufffd")) return text;
      // Only a double-byte file, whose high bytes come in runs, is let off a few bad bytes; a Western file's
      // accents and curly quotes stand alone, and often pair with the next letter into a valid character.
      let high = 0;
      let paired = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] < 0x80) continue;
        high++;
        if (bytes[i - 1] >= 0x80 || bytes[i + 1] >= 0x80) paired++;
      }
      // A file in that code page has at most a stray bad byte (a pasted character, or one cut short at its end); a
      // Western file read on a Japanese, Chinese, or Korean system has many.
      const errors = text.replace(/\ufffd+$/, "").match(/\ufffd/g)?.length ?? 0;
      if (paired * 2 > high && errors * 8 < (text.match(/[^\x00-\x7f]/g)?.length ?? 0)) return text;
    } catch {
      // Not that code page (or one this runtime does not know): Windows-1252 below.
    }
  }
  // Mapped here rather than by TextDecoder, which some runtimes read as Latin-1 (losing dashes and curly quotes).
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192), (b) => (b >= 0x80 && b < 0xa0 ? CP1252_C1.charCodeAt(b - 0x80) : b)));
  }
  return out;
}

/** The legacy code page Windows saves plain text in for a language (as `navigator.language` gives it). */
export function legacyEncodingFor(language: string): string {
  const lang = language.toLowerCase();
  if (/^zh-(tw|hk|mo)|^zh-hant/.test(lang)) return "big5";
  const base = lang.split("-")[0];
  // Serbian and Bosnian in Latin letters use the Central European page.
  if (/^(sr|bs)-latn|^bs\b|^hr\b/.test(lang)) return "windows-1250";
  const pages: Record<string, string> = {
    ru: "windows-1251", uk: "windows-1251", bg: "windows-1251", sr: "windows-1251", be: "windows-1251", mk: "windows-1251",
    zh: "gbk", ja: "shift_jis", ko: "euc-kr", el: "windows-1253", tr: "windows-1254", he: "windows-1255", ar: "windows-1256", fa: "windows-1256",
    pl: "windows-1250", cs: "windows-1250", sk: "windows-1250", hu: "windows-1250", ro: "windows-1250", hr: "windows-1250", sl: "windows-1250",
    lt: "windows-1257", lv: "windows-1257", et: "windows-1257", vi: "windows-1258", th: "windows-874",
  };
  return pages[base] ?? "windows-1252";
}
/** Windows-1252's characters for bytes 0x80–0x9F (the rest of the code page is Latin-1). */
const CP1252_C1 = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

const hasWords = (text: string) => stripPauses(text).trim().length > 0;
// A backslash-escaped character (any ASCII punctuation, as Markdown allows) is held in the private-use area while
// Markdown is read, so `\*` is never emphasis, then given back as the character.
const hide = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
const unhide = (text: string) => text.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));

/** Markdown outside code spans as it would be read aloud: images and links by their text, autolinks by their address, emphasis, tags, and footnote marks dropped. */
function spokenMarkdown(text: string): string {
  return (
    text
      // Link text holds no brackets and is bounded, so a line of stray [ costs no more than a scan.
      .replace(new RegExp(String.raw`!\[([^\][]{0,1000})\]` + DESTINATION, "g"), "$1")
      .replace(/!\[([^\][]{0,1000})\]\[[^\][]{0,200}\]/g, "$1")
      .replace(new RegExp(String.raw`\[([^\][]{1,1000})\]` + DESTINATION, "g"), "$1")
      .replace(/\[\^[^\]\s]+\]/g, "")
      .replace(/\[([^\][]{1,1000})\]\[[^\][]{0,200}\]/g, "$1")
      .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+|[^<>\s@]+@[^<>\s@]+)>/gi, "$1")
      .replace(TAG, "")
      .replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, name: string) => {
        if (name[0] !== "#") return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m;
        const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      })
      // Emphasis within a paragraph, each marker closed by its own kind (a bold may hold a single *), and no
      // further than the paragraph, so an unclosed one costs no more than a scan.
      .replace(/\*\*(?=\S)((?:[^*\n]|\*(?!\*))+?)(?<=\S)\*\*|__(?=\S)((?:[^_\n]|_(?!_))+?)(?<=\S)__|~~(?=\S)([^~\n]+?)(?<=\S)~~/g, (_, a, b, c) => a ?? b ?? c)
      .replace(/(^|[\s(])([*_])(?=[^*_\s])([^*_\n]+?)(?<=\S)\2(?=[\s).,;:!?]|$)/g, "$1$3")
  );
}

/** Text as it would be read aloud: code spans keep their text as written, the rest is read as Markdown. */
function spokenInline(text: string): string {
  // Pause markers are script, not links or references: held aside while Markdown is read.
  const pauses: string[] = [];
  text = text.replace(PAUSE, (m) => `\ue100${pauses.push(m) - 1}\ue101`);
  const parts = text.split("`");
  // An unmatched backtick is just a character.
  if (parts.length % 2 === 0) parts.splice(parts.length - 2, 2, `${parts[parts.length - 2]}\`${parts[parts.length - 1]}`);
  return unhide(parts.map((p, i) => (i % 2 ? p : spokenMarkdown(p))).join(""))
    .replace(/\ue100(\d+)\ue101/g, (_, i: string) => pauses[Number(i)])
    .trim();
}

/** A line's own Markdown taken off (quote and list markers, table pipes), escapes held, ready to join its paragraph. */
function lineText(line: string, listItem: boolean): string {
  let text = hide(line);
  if (listItem) text = text.replace(BULLET, "").replace(ORDERED, "");
  if (/^\s*\|/.test(text)) {
    text = text.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
    if (text && !/[.!?;:]$/.test(text)) text += ".";
  }
  return text.trim();
}

/** Paragraphs of a block: runs of non-empty lines, each joined into one line. A paragraph with only pauses joins the one before it (or after it). */
function paragraphs(lines: string[], markdown: boolean): string[] {
  const out: string[] = [];
  const pending: string[] = [];
  let run: string[] = [];
  const flush = () => {
    // A bullet is always a list item; a number only at the start of a paragraph, after another item, or as "1.",
    // so a wrapped "We sold\n100. That…" keeps its number while "Steps:\n1. Open" reads as a list.
    let inList = false;
    // Consecutive Markdown lines are read together, so emphasis may wrap; fenced code is kept as written.
    const pieces: string[] = [];
    let prose: string[] = [];
    const endProse = () => {
      if (prose.length) pieces.push(spokenInline(prose.join(" ")));
      prose = [];
    };
    run.forEach((raw, i) => {
      if (raw.startsWith(VERBATIM)) {
        endProse();
        pieces.push(raw.slice(1).trim());
      } else if (!markdown) pieces.push(raw.trim());
      else {
        // A quote's markers, and an Obsidian callout's [!NOTE] tag, are not spoken.
        const line = raw.replace(/^\s*(?:>\s?)+(?:\[![a-z]+\][+-]?\s*)?/i, "");
        const ordered = ORDERED.exec(line);
        inList = BULLET.test(line) || (!!ordered && (i === 0 || inList || ordered[1] === "1"));
        prose.push(lineText(line, inList));
      }
    });
    endProse();
    const words = pieces.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    run = [];
    if (!words) return;
    if (!hasWords(words)) {
      if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${words}`;
      else pending.push(words);
      return;
    }
    out.push(pending.length ? `${pending.join(" ")} ${words}` : words);
    pending.length = 0;
  };
  for (const line of lines) {
    if (line.replace(VERBATIM, "").trim()) run.push(line);
    else flush();
  }
  flush();
  // Only pauses in the whole block: keep them, for the caller to join to a neighbour.
  if (!out.length && pending.length) out.push(pending.join(" "));
  return out;
}

/** Whether a cut at `at` would split a pause marker (markers are short, so only the text around the cut is looked at). */
export function insidePause(text: string, at: number): boolean {
  const from = Math.max(0, at - 24);
  for (const m of text.slice(from, at + 24).matchAll(PAUSE)) {
    const start = from + m.index!;
    if (start < at && at < start + m[0].length) return true;
  }
  return false;
}

/**
 * The longest start of `text` within `max` characters that ends a sentence or a paragraph; between words when
 * there is no such end, or when it keeps under a quarter of a large room; as a last resort (text without spaces,
 * as Chinese or Japanese is written) at `max`, between whole characters. Never inside a pause marker; undefined
 * when nothing fits. Only the first `max` characters are looked at, so a huge paragraph costs no more than a short one.
 */
export function head(text: string, max: number): string | undefined {
  if (text.length <= max) return text;
  const window = text.slice(0, max + 1);
  let sentence = -1;
  for (const m of window.matchAll(SENTENCE_END)) if (m.index! + m[0].length <= max) sentence = m.index! + m[0].length;
  sentence = Math.max(sentence, window.lastIndexOf(SEPARATOR, max));
  let word = -1;
  for (let i = Math.min(max, window.length - 1); i >= MIN_PIECE; i--) {
    if (/\s/.test(window[i]) && !insidePause(text, i)) {
      word = i;
      break;
    }
  }
  let cut: number;
  if (sentence > 0 && !(sentence < max / 4 && max > 1000 && word > sentence)) cut = sentence;
  else if (word > 0) cut = word;
  else {
    cut = max;
    // Not between the halves of a surrogate pair, nor inside a marker, and never a fragment.
    if (/[\udc00-\udfff]/.test(text[cut] ?? "")) cut--;
    while (cut > 0 && insidePause(text, cut)) cut--;
    if (cut < MIN_PIECE) cut = -1;
  }
  const piece = cut > 0 ? text.slice(0, cut).trim() : "";
  return piece && hasWords(piece) ? piece : undefined;
}

/** Paragraphs packed in order into at most `MAX_SCENES` scenes of about even length; joining keeps the separator, so the total is unchanged. */
function pack(paras: string[]): string[] {
  if (paras.length <= MAX_SCENES) return paras;
  const total = paras.join(SEPARATOR).length;
  const target = Math.ceil(total / MAX_SCENES);
  const scenes: string[] = [];
  let current = "";
  paras.forEach((p, i) => {
    // Close a scene once it reaches the target, unless the rest would no longer fit in the scenes left.
    const left = paras.length - i;
    if (current && (current.length >= target || left <= MAX_SCENES - scenes.length - 1) && scenes.length < MAX_SCENES - 1) {
      scenes.push(current);
      current = p;
    } else {
      current = current ? `${current}${SEPARATOR}${p}` : p;
    }
  });
  if (current) scenes.push(current);
  return scenes;
}

/** Leading YAML front matter (`---`, lowercase `key: value` lines, `---`) holds metadata, not script. */
function withoutFrontMatter(lines: string[]): string[] {
  if (!/^---\s*$/.test(lines[0] ?? "")) return lines;
  const end = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(l));
  if (end < 2) return lines;
  const body = lines.slice(1, end);
  return body.some((l) => /^[a-z_][\w-]*\s*:/.test(l)) && body.every((l) => !l.trim() || /^[a-z_][\w-]*\s*:/.test(l) || /^\s+\S/.test(l)) ? lines.slice(end + 1) : lines;
}

/** A whole document wrapped in one ```markdown (or plain) fence, as a chat assistant hands over a script, unwrapped. */
function withoutDocumentFence(lines: string[]): string[] {
  const first = lines.findIndex((l) => l.trim());
  let last = lines.length - 1;
  while (last > first && !lines[last].trim()) last--;
  const open = first >= 0 ? FENCE.exec(lines[first]) : null;
  if (!open || last <= first || !DOCUMENT_FENCE.has(open[2].toLowerCase())) return lines;
  const close = FENCE.exec(lines[last]);
  if (!close || close[1] !== open[1] || close[2]) return lines;
  const inner = lines.slice(first + 1, last);
  // Only when no other fence of the same kind sits inside (which would make the outer pair two code blocks).
  return inner.some((l) => FENCE.exec(l)?.[1] === open[1]) ? lines : inner;
}

/**
 * Each ```markdown (or md) fence and the fence that closes it. A chat answer often holds a ```bash block inside
 * the script: a labelled fence of the same marker opens such a block, the next bare one closes it, and the first
 * bare fence with no block open closes the script.
 */
function markdownFenceSpans(lines: string[]): { open: number; close: number }[] {
  const spans: { open: number; close: number }[] = [];
  let open = -1;
  let marker = "";
  let inner = false;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (!f) continue;
    if (open < 0) {
      if (MARKDOWN_FENCE.has(f[2].toLowerCase())) [open, marker, inner] = [i, f[1], false];
    } else if (f[1] === marker) {
      if (f[2]) inner = true;
      else if (inner) inner = false;
      else {
        spans.push({ open, close: i });
        open = -1;
      }
    }
  }
  // A script fence left open (the reply cut short, or its last line not copied) runs to the end.
  if (open >= 0) spans.push({ open, close: lines.length });
  return spans;
}

/** HTML comments removed; one that never closes is left as text, and the search stops there. */
function withoutComments(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    if (open < 0) break;
    const close = text.indexOf("-->", open + 4);
    if (close < 0) break;
    out += text.slice(at, open);
    at = close + 3;
  }
  return out + text.slice(at);
}

/**
 * Images embedded as data: URLs replaced by their alt text, in one pass: each `](data:` is closed by the next `)`,
 * and when none follows, no later one can close either.
 */
function withoutDataImages(text: string): string {
  let out = "";
  let at = 0;
  let from = 0;
  for (;;) {
    const mid = text.indexOf("](", from);
    if (mid < 0) break;
    const angle = text[mid + 2] === "<";
    const start = mid + 2 + (angle ? 1 : 0);
    if (!text.startsWith("data:", start)) {
      from = mid + 2;
      continue;
    }
    // A data URL has no spaces: it ends at the first ) (or >), and one cut short by a space is no image.
    let end = start;
    while (end < text.length && text[end] !== ")" && text[end] !== ">" && !/\s/.test(text[end])) end++;
    if (text[end] === ">") end++;
    // An image's optional title: ![alt](data:… "title").
    const titled = /\s+(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'|\([^()\n]{0,300}\))\s*(?=\))/y;
    titled.lastIndex = end;
    if (titled.test(text)) end = titled.lastIndex;
    if (end >= text.length) break;
    if (text[end] !== ")") {
      from = end;
      continue;
    }
    const open = text.lastIndexOf("![", mid);
    const alt = open >= at && mid - open <= 1000 ? text.slice(open + 2, mid) : undefined;
    if (alt === undefined || alt.includes("]") || alt.includes("\n")) {
      from = end;
      continue;
    }
    out += text.slice(at, open) + alt;
    at = from = end + 1;
  }
  return out + text.slice(at);
}

/**
 * Blocks with only pauses join their neighbour (the one before, or else the one after), so no scene is a pause alone;
 * with `keepSilent`, a section of only pauses set apart by headings or `---` is kept as a silent scene when its length
 * fits one (a document of nothing but pauses still gives no scenes).
 */
export function joinPauseOnly(blocks: string[], keepSilent = false): string[] {
  const out: string[] = [];
  const pending: string[] = [];
  const anyWords = blocks.some(hasWords);
  for (const block of blocks) {
    if (keepSilent && anyWords && !hasWords(block) && !silentProblem(block)) {
      out.push(block);
    } else if (hasWords(block)) {
      out.push(pending.length ? `${pending.join(" ")} ${block}` : block);
      pending.length = 0;
    } else if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${block}`;
    else pending.push(block);
  }
  return out;
}

/**
 * Scenes from a plain-text or Markdown document. A heading or a line of `---` (or `***`, `___`) starts a new
 * scene, and the paragraphs between are that scene's script; a document with neither (a title heading aside)
 * gets one scene per paragraph, packed together when there are more paragraphs than a video has scenes. With
 * `markdown`, list markers, emphasis, links, tags, comments, link and footnote definitions, and footnote marks
 * are left out of what is spoken, and code inside fences is read as written (a fence around the whole document
 * is taken off); plain text is taken as written. A video holds `MAX_SCRIPT_CHARS` of script in all, so a longer
 * document is cut at a sentence end and the rest left out.
 */
export function scenesFromText(text: string, { markdown = true }: { markdown?: boolean } = {}): ImportedScript {
  let source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  // Embedded images (data: URLs, as document exports inline them) can be far longer than a line is read; they
  // leave their alt text, like any other image.
  if (markdown) source = withoutDataImages(withoutComments(source));
  let lines = source.split("\n");
  if (markdown) lines = withoutFrontMatter(withoutDocumentFence(withoutFrontMatter(lines)));
  // A chat answer: a short lead-in, the script in a ```markdown fence (perhaps holding code blocks of its own),
  // a short sign-off. The fence's content is the script; with little around it, only the content is read.
  let skip = new Set<number>();
  // Several such fences (two versions to choose from) are all read, without their fence lines; so is one that
  // holds only a heading, which is an example in the prose around it rather than the script.
  const spans = markdown ? markdownFenceSpans(lines) : [];
  if (spans.length === 1) {
    const [span] = spans;
    const outside = [...lines.slice(0, span.open), ...lines.slice(span.close + 1)].filter((l) => l.trim());
    const inside = lines.slice(span.open + 1, span.close);
    const prose = inside.some((l) => l.trim() && !HEADING.test(l));
    // A bare fence after the close that closes no code block of its own means the script went on past it.
    const marker = FENCE.exec(lines[span.open])![1];
    let block = false;
    let stray = false;
    for (const l of lines.slice(span.close + 1)) {
      const f = FENCE.exec(l);
      if (!f || f[1] !== marker) continue;
      if (f[2]) block = true;
      else if (block) block = false;
      else stray = true;
    }
    if (prose && !stray && outside.length <= 4 && outside.every((l) => l.length <= 300)) lines = withoutFrontMatter(inside);
    else skip = new Set([span.open, span.close]);
  } else skip = new Set(spans.flatMap((s) => [s.open, s.close]));
  // Labels the document refers to ([text][label], [label][]): a definition of one is never spoken, whatever it points at.
  const referenced = new Set<string>();
  if (markdown) for (const m of source.matchAll(/\]\[([^\][\n]{1,200})\]|\[([^\][\n]{1,200})\]\[\]/g)) referenced.add((m[1] ?? m[2]).trim().toLowerCase());
  // Where each fence marker next appears, so an opening fence with no close is read as an ordinary line.
  const fenceAt = new Map<string, number[]>();
  if (markdown) lines.forEach((l, i) => {
    const f = FENCE.exec(l);
    if (!f) return;
    let at = fenceAt.get(f[1]);
    if (!at) fenceAt.set(f[1], (at = []));
    at.push(i);
  });
  // Lines are read in order, so each marker keeps a pointer past the fences already behind.
  const fencePtr = new Map<string, number>();
  const nextFence = (kind: string, after: number) => {
    const at = fenceAt.get(kind) ?? [];
    let ptr = fencePtr.get(kind) ?? 0;
    while (ptr < at.length && at[ptr] <= after) ptr++;
    fencePtr.set(kind, ptr);
    return at[ptr] ?? -1;
  };
  let title: string | undefined;
  const sections: string[][] = [[]];
  let explicit = false;
  let seen = false;
  let read = 0;
  let cutShort = false;
  let fence: string | undefined;
  let footnote = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (markdown) {
      // The ```markdown fence's own lines; its close also ends any code block left open inside it.
      if (skip.has(i)) {
        fence = undefined;
        continue;
      }
      const opens = FENCE.exec(line);
      if (fence) {
        if (opens && opens[1] === fence && !opens[2]) fence = undefined;
        else {
          sections[sections.length - 1].push(VERBATIM + line.slice(0, MAX_LINE_CHARS));
          if (line.trim()) seen = true;
          read += Math.min(line.length, MAX_LINE_CHARS) + 1;
        }
        continue;
      }
      // A backtick fence's info has no backtick (```npm i``` is inline code). A fence that never closes fences
      // nothing: its own line is markup, and what follows is read as Markdown.
      if (opens && !(opens[1][0] === "`" && line.slice(line.indexOf(opens[1]) + opens[1].length).includes("`"))) {
        if (nextFence(opens[1], i) > i) fence = opens[1];
        continue;
      }
      // Definitions and table rules are never spoken; a footnote's indented continuation lines go with it.
      if (footnote && /^(?: {4}|\t)/.test(line)) continue;
      footnote = FOOTNOTE_DEFINITION.test(line);
      if (footnote || LINK_DEFINITION.test(line) || TABLE_RULE.test(line)) continue;
      const definition = REFERENCE_DEFINITION.exec(line);
      // Unless its target reads as a reply ("[HOST]: Absolutely!", "[HOST]: (laughs)"), which no link points at.
      if (definition && referenced.has(definition[1].trim().toLowerCase()) && !/^\(|[.!?…]$/.test(definition[2])) continue;
    }
    // Reading stops well past what a video keeps; the rest could only be left out.
    if (read > READ_CHARS) {
      cutShort = true;
      break;
    }
    if (line.length > MAX_LINE_CHARS) {
      line = line.slice(0, MAX_LINE_CHARS);
      cutShort = true;
    }
    read += line.length + 1;
    const atx = markdown ? HEADING.exec(line) : null;
    // A text line underlined with === is a heading too (Markdown's other spelling); a list item, quote, or table row is not.
    const setext = markdown && !atx && !!line.trim() && SETEXT.test(lines[i + 1] ?? "") && !(lines[i - 1] ?? "").trim() && !/^\s*(?:[-*+>|]|\d{1,3}[.)]\s)/.test(line);
    if (atx || setext) {
      const name = spokenInline(lineText(atx ? atx[2] : line, false));
      const top = atx ? atx[1] === "#" : true;
      if (setext) i++;
      // A title before any script names the video; it does not divide the document into scenes.
      if (top && !title && !seen && name) {
        title = name.slice(0, 120);
        continue;
      }
      explicit = true;
      sections.push([]);
    } else if (BREAK.test(line) || (markdown && RULE.test(line))) {
      explicit = true;
      sections.push([]);
    } else {
      sections[sections.length - 1].push(line);
      if (line.trim()) seen = true;
    }
  }
  const blocks = explicit ? joinPauseOnly(sections.map((s) => paragraphs(s, markdown).join(SEPARATOR)).filter(Boolean), true) : joinPauseOnly(paragraphs(sections.flat(), markdown));

  // Keep what a video holds, in order: blocks while the whole script fits, the next one cut to the room left.
  const kept: string[] = [];
  let used = 0;
  let truncated = cutShort;
  for (const block of blocks) {
    const room = MAX_SCRIPT_CHARS - used - (kept.length ? SEPARATOR.length : 0);
    if (block.length <= room) {
      used += block.length + (kept.length ? SEPARATOR.length : 0);
      kept.push(block);
      continue;
    }
    truncated = true;
    const piece = room > 0 ? head(block, room) : undefined;
    if (piece) kept.push(piece);
    break;
  }
  // More sections or paragraphs than a video has scenes are packed together, so text that fits is never dropped.
  let scenes = pack(kept);
  if (scenes.length > MAX_SCENES) {
    scenes = scenes.slice(0, MAX_SCENES);
    truncated = true;
  }
  return { scenes, ...(title ? { title } : {}), truncated };
}
