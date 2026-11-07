// The share page's transcript as plain text, for a viewer to copy or save: the lines shown (in the subtitle language
// they picked), each with its time unless they asked for the words alone. Built in the browser from what the page
// already holds, so it needs no request. A plain module, so the rules can be tested without a page.
import { safeFileStem } from "./attachment";
import { formatTimestamp } from "./text";

export type TranscriptCue = { startMs: number; text: string };

/**
 * The transcript as text: the video's title (and the language, for a translated one) on the first line, a blank line,
 * then one line per caption, `0:05  Words`, or the words alone without times. A caption's own line breaks become
 * spaces, so each caption stays one line. Lines with no words are left out. Ends with a newline.
 */
export function transcriptText(cues: TranscriptCue[], opts: { title: string; language?: string; times: boolean }): string {
  // One line, whatever line breaks a title typed through the API carries.
  const heading = [opts.title.replace(/\s+/g, " ").trim(), opts.language].filter(Boolean).join(" · ");
  const lines = cues
    .map((c) => ({ at: c.startMs, words: c.text.replace(/\s+/g, " ").trim() }))
    .filter((c) => c.words)
    .map((c) => (opts.times ? `${formatTimestamp(c.at / 1000)}  ${c.words}` : c.words));
  return [...(heading ? [heading, ""] : []), ...lines].join("\n") + "\n";
}

/**
 * A file name for the transcript: the video's title, the language when translated, safe to save under. A long title is
 * cut to make room for " transcript (Language)", so each language's file keeps a name of its own.
 */
export function transcriptFileName(title: string, language?: string): string {
  const lang = language ? safeFileStem(language, [], 30) : "";
  const suffix = ` transcript${lang ? ` (${lang})` : ""}`;
  const stem = safeFileStem(title, ["txt"], Math.max(20, 80 - suffix.length)) || "Video";
  return `${stem}${suffix}.txt`;
}
