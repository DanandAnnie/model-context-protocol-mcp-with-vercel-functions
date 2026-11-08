// HeyGen Voice audio tags: English words in square brackets in text spoken in a voice ("[excited]", "[whispers]",
// "[laughs]") that change how the voice speaks or add a sound. Public and instant voices perform them; professional
// voices do not. Shared by the server and the Voice changer page.

export type AudioTagCategory = "emotion" | "delivery" | "acoustic event" | "scenario";

/** What each category does, as HeyGen describes it. */
export const AUDIO_TAG_CATEGORY_NOTES: Record<AudioTagCategory, string> = {
  emotion: "Changes the feeling of the speech after it",
  delivery: "Changes how the words after it are spoken: volume, pace, pitch, or voice",
  "acoustic event": "Adds one sound at its spot",
  scenario: "Speaks the words after it as a role or situation would",
};

/** The tags HeyGen lists first in each category, offered first in the picker. */
export const COMMON_AUDIO_TAGS: Record<AudioTagCategory, readonly string[]> = {
  emotion: ["happy", "sad", "angry", "excited", "nervous", "frustrated", "surprised", "scared", "sarcastic", "warm", "serious", "calm", "on the verge of tears", "barely containing excitement", "deadpan, dry humor"],
  delivery: ["whispers", "softly", "shouts", "deep voice", "trembling voice", "stammers", "sings", "slowly", "quickly", "pause", "hesitates", "trying not to laugh", "through gritted teeth", "voice dropping to a whisper", "building to a shout"],
  "acoustic event": ["laughs", "chuckles", "giggles", "sighs", "gasps", "sobs", "sniffles", "coughs", "clears throat", "groans", "scoffs", "hmm"],
  scenario: ["as if sharing a secret", "like a sports commentator", "like reading a bedtime story"],
};

/** Every tag HeyGen Voice performs (October 2026), lowercase, by category. */
export const AUDIO_TAGS: Record<AudioTagCategory, readonly string[]> = {
  emotion: [
    "barely containing excitement", "deadpan, dry humor", "defensive, a little hurt", "genuinely impressed", "mock serious", "nostalgic and wistful", "passive aggressive", "quietly furious", "reluctantly admitting", "skeptical, raising an eyebrow", "trying to sound casual", "with a shrug in their voice", "with forced politeness",
    "amused", "angry", "annoyed", "anxious", "awestruck", "bored", "confident", "confused", "curious", "determined", "disgusted", "embarrassed", "excited", "exhausted", "frustrated", "grateful", "guilty", "happy", "heartbroken", "hopeful", "jealous", "lonely", "melancholic", "nervous", "panicked", "proud", "relieved", "sad", "scared", "shy", "sleepy", "surprised", "tender", "worried",
    "rising panic", "suddenly serious",
    "in disbelief", "on the verge of tears", "rolling their eyes", "with a knowing smile", "with a lump in their throat",
    "apologetic", "authoritative", "calm", "cheerful", "cold", "dismissive", "dreamy", "encouraging", "enthusiastic", "firm", "flirtatious", "gentle", "matter-of-fact", "mischievous", "playful", "reassuring", "sarcastic", "serious", "sincere", "smug", "solemn", "stern", "suspicious", "thoughtful", "warm",
  ],
  delivery: [
    "drawls", "enunciating clearly", "mumbles", "mutters", "sings", "slurring", "stammers",
    "as an afterthought", "over-the-top dramatic",
    "barely audible", "building to a shout", "catching themselves mid-sentence", "laughing while speaking", "lowering their voice", "singing it softly", "softer than before", "trailing off", "voice cracking", "voice dropping to a whisper", "whispering urgently",
    "hesitates", "pause", "quickly", "rushed", "slowly",
    "booming", "breathless", "breathy", "deep voice", "high voice", "hoarse", "low voice", "monotone", "nasal", "raspy", "sing-song", "squeaky voice", "trembling voice",
    "after a long pause", "speaking through a smile", "through gritted teeth", "trying not to laugh",
    "bellows", "calls out", "loudly", "murmurs", "quietly", "screams", "shouts", "shrieks", "softly", "under their breath", "whispers", "yells",
  ],
  "acoustic event": [
    "clears throat awkwardly", "clears throat", "coughs", "gulps", "hiccups", "sneezes", "sniffs", "snores", "snorts", "yawns",
    "exhales", "gasps", "huffs", "inhales", "long tired sigh", "pants", "sharp intake of breath", "sighs", "wheezes",
    "muffled sob", "sniffles", "sobs", "whimpers",
    "belly laugh", "cackles", "chortles", "chuckles", "giggles", "guffaws", "laughs", "nervous laugh", "short disbelieving laugh", "snickers",
    "applause", "claps", "knocks", "snaps fingers",
    "exasperated groan", "groans", "grunts", "hmm", "hums", "scoffs", "shushes", "small happy hum", "tsks", "whistles",
  ],
  scenario: [
    "as if sharing a secret", "quoting someone mockingly",
    "addressing a crowd", "comforting a friend", "explaining to a confused customer", "like a drill sergeant", "like a game show host", "like a late-night radio host", "like a museum tour guide", "like a news anchor", "like a sports commentator", "like reading a bedtime story", "talking to a small child", "teasing a close friend",
    "from across the room", "half asleep", "into a phone, distracted", "leaning in conspiratorially", "walking fast, slightly out of breath", "while catching their breath", "with a mouth full of food",
  ],
};

const KNOWN = new Set(Object.values(AUDIO_TAGS).flat());

/** Bracketed text on one line, as HeyGen reads a tag: up to 60 characters, no nested brackets. */
const BRACKETED = /\[([^[\]\n]{1,60})\]/g;

/** The tag a bracket's inside names, as HeyGen spells it, or undefined when it names none. */
function tagOf(inside: string): string | undefined {
  const tag = inside.trim().replace(/\s+/g, " ").toLowerCase();
  return KNOWN.has(tag) ? tag : undefined;
}

export interface AudioTagScan {
  /** The tags in the text, in order, as HeyGen spells them. */
  tags: string[];
  /** Bracketed text that is not a tag (HeyGen usually leaves it unspoken), each once, as written. */
  unknown: string[];
  /** Two tags with nothing but spaces between them, which HeyGen asks not to write ("[angry] [whispers]"). */
  sideBySide: string[];
}

/** The audio tags, bracketed text that is not one, and tags written side by side, in a text. */
export function scanAudioTags(text: string): AudioTagScan {
  const tags: string[] = [];
  const unknown: string[] = [];
  const sideBySide: string[] = [];
  let lastTagEnd = -1;
  let lastTag = "";
  for (const m of text.matchAll(BRACKETED)) {
    const tag = tagOf(m[1]);
    if (!tag) {
      if (!unknown.includes(m[0])) unknown.push(m[0]);
      lastTagEnd = -1;
      continue;
    }
    if (lastTagEnd >= 0 && !text.slice(lastTagEnd, m.index).trim()) {
      const pair = `[${lastTag}] [${tag}]`;
      if (!sideBySide.includes(pair)) sideBySide.push(pair);
    }
    tags.push(tag);
    lastTag = tag;
    lastTagEnd = m.index + m[0].length;
  }
  return { tags, unknown, sideBySide };
}

/** The text with each audio tag spelled as HeyGen reads it ("[ Excited ]" is "[excited]"); other brackets as written. */
export function normalizeAudioTags(text: string): string {
  return text.replace(BRACKETED, (whole, inside: string) => {
    const tag = tagOf(inside);
    return tag ? `[${tag}]` : whole;
  });
}

/**
 * The text without its audio tags: what is said, for a title or a transcript. Only the gap a tag leaves is tidied (one
 * space where it sat between words, none at the start of a line or before a mark such as a comma); a text without tags
 * comes back exactly as written.
 */
export function withoutAudioTags(text: string): string {
  let removed = false;
  const out = text.replace(/([ \t]*)\[([^[\]\n]{1,60})\]([ \t]*)/g, (whole, lead: string, inside: string, trail: string, at: number) => {
    if (!tagOf(inside)) return whole;
    removed = true;
    const before = text[at - 1];
    const after = text[at + whole.length];
    const lineStart = before === undefined || before === "\n";
    const lineEnd = after === undefined || after === "\n";
    if (lineStart || lineEnd || /[,.!?;:)\]]/.test(after)) return "";
    return lead || trail ? " " : "";
  });
  return removed ? out.trim() : text;
}

/**
 * Timed words without the audio tags a renderer may time as words ("[excited]", or "[deadpan," "dry" "humor]" split at
 * spaces): what is shown in captions. Bracketed words that are no tag are kept.
 */
export function dropTagWords<T extends { text: string }>(words: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < words.length; i++) {
    const first = words[i].text.trim();
    if (first.startsWith("[")) {
      // A tag spoken as one word, or split over a few that close it.
      let joined = first;
      let j = i;
      while (!joined.endsWith("]") && j + 1 < words.length && j - i < 6) joined += ` ${words[++j].text.trim()}`;
      if (joined.endsWith("]") && tagOf(joined.slice(1, -1))) {
        i = j;
        continue;
      }
    }
    out.push(words[i]);
  }
  return out;
}

/** Each audio tag in a text, in order, with how many of the text's words come before it and whether it sits inside other brackets. */
export function tagPlacements(text: string): Array<{ tag: string; wordsBefore: number; nested: boolean }> {
  const placed: Array<{ tag: string; wordsBefore: number; nested: boolean }> = [];
  for (const m of text.matchAll(BRACKETED)) {
    const tag = tagOf(m[1]);
    if (!tag) continue;
    const prefix = text.slice(0, m.index);
    const said = withoutAudioTags(prefix).trim();
    placed.push({ tag, wordsBefore: said ? said.split(/\s+/).length : 0, nested: prefix.lastIndexOf("[") > prefix.lastIndexOf("]") });
  }
  return placed;
}

/** Whether HeyGen leaves out the expressiveness boost for this text: any tag but [pause] turns it off. */
export function boostIgnoredFor(text: string): boolean {
  return scanAudioTags(text).tags.some((t) => t !== "pause");
}
