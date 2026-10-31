// A copy of a video in another language: every scene's words translated and a voice that speaks it, for the editor.
import { z } from "zod";
import { baseLanguageCode, isSpecialLanguageCode, languageTag } from "../language";
import { stripPauses } from "../pauses";
import { LOCAL_OWNER } from "../owner-id";
import { ConflictError, LimitError, ValidationError } from "../errors";
import { MAX_SCENE_NAME, type Voice } from "../types";
import { capSceneText } from "../scene-text";
import { graphemes } from "../text";
import { reviseScript } from "./scripts";
import { getVideo } from "./videos";
import { listVoices } from "./voices";

export const languageCopySchema = z.object({ language: z.string().trim().min(2).max(40) }).strict();

/**
 * Scenes translated at once, and how long a copy may go on starting scenes: a scene started just before the deadline
 * still has the rest of the route's five minutes to finish.
 */
const AT_ONCE = 4;
const DEADLINE_MS = 150_000;

let displayNames: Intl.DisplayNames | null | undefined;
/**
 * The English name of a language a person named in full ("Spanish", "Chinese (Mandarin)"), as a code ("es"), or as a
 * tag ("es-MX" is "Spanish (Mexico)", the form the brand kit's rules for a country are written in); undefined for
 * anything else, a code no language has ("zz") and the codes for no language ("und") included, so only a language's own
 * name reaches the script writer and the brand kit's rules.
 */
export function languageName(input: string): string | undefined {
  const tag = languageTag(input);
  if (!tag || isSpecialLanguageCode(tag)) return undefined;
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard", fallback: "none" });
    } catch {
      displayNames = null;
    }
  }
  try {
    return displayNames?.of(tag) ?? undefined;
  } catch {
    return undefined;
  }
}

export interface LanguageCopy {
  /** The language's English name ("Spanish" for "es"), for the copy's title. */
  language: string;
  /** One script per scene, in order (one for a video without scenes); a scene with nothing to say keeps its own. */
  scripts: string[];
  /** For each voice the video speaks in, one of the account's voices that speaks the language, where there is one. */
  voices: Record<string, string>;
  /** Each scene's on-screen text translated, in order, within its limit; null for a scene without any. */
  overlays: (string | null)[];
  /** Each scene's name translated (its tab and chapter title), in order, within its limit; null for a scene without one. */
  names: (string | null)[];
}

/** A name cut to the limit as a reader counts it, its spaces collapsed, as the scene schema keeps one. */
const capName = (raw: string) => graphemes(raw.replace(/\s+/g, " ").trim()).slice(0, MAX_SCENE_NAME).join("").trim();

/**
 * Every scene's words translated into `language` as the editor's Translate does (pause markers kept, the brand kit's
 * terms left as they are and its fixed translations used), and, for each voice the video speaks in, a voice in that
 * language: the same voice when it already speaks it, else one of the same gender, else any. A scene lip-synced to a
 * recording, or with only pauses, keeps its script; on-screen text and scene names are translated too, each cut to its
 * limit. Nothing is saved; the editor opens the copy to review.
 */
export async function languageCopy(
  id: string,
  input: z.infer<typeof languageCopySchema>,
  ownerId: string = LOCAL_OWNER,
  /** The route's allowance, used only by a copy that passed every check, so a refused one costs nothing. */
  allowed: () => boolean = () => true,
): Promise<LanguageCopy> {
  const video = await getVideo(id, ownerId, false);
  if (video.deletedAt) throw new ConflictError("Restore the video from the trash first");
  if (video.cinematic || video.directed || video.studioTemplate) throw new ValidationError("This video has no scenes of its own to translate");
  const language = languageName(input.language);
  const code = language && baseLanguageCode(input.language);
  if (!language || !code) throw new ValidationError(`"${input.language}" is not a language the studio knows; name it in English, as "Spanish" or "Japanese", or by its code, as "es"`);
  const scenes = video.scenes?.length ? video.scenes : [{ script: video.script, voiceId: video.voiceId, audioId: undefined }];
  if (!scenes.some((sc) => !sc.audioId && stripPauses(sc.script).trim())) throw new ValidationError("This video has no words to translate");
  if (!allowed()) throw new LimitError("Too many copies translated for now; try again in an hour");
  // A few scenes at a time, in their places: twenty one after another could outlast the request, twenty at once would
  // crowd the script writer. A copy that takes too long is given up with a reason rather than cut off.
  // On-screen text and scene names go with the scripts, so the copy reads in one language throughout.
  const scripts = scenes.map((sc) => sc.script);
  const overlays: (string | null)[] = scenes.map(() => null);
  const names: (string | null)[] = scenes.map(() => null);
  // A label's translation longer than its place is cut to fit it, as the editor does with pasted text; one cut to
  // nothing leaves the original standing.
  type Job = { kind: "script" | "overlay" | "name"; i: number; text: string };
  const todo: Job[] = scenes.flatMap((sc, i) => {
    const jobs: Job[] = [];
    if (!sc.audioId && stripPauses(sc.script).trim()) jobs.push({ kind: "script", i, text: sc.script });
    // A label without letters ("$450,000", "2026") has nothing to translate and is kept exactly as it is.
    const overlay = "overlay" in sc ? sc.overlay?.text.trim() : undefined;
    if (overlay && /\p{L}/u.test(overlay)) jobs.push({ kind: "overlay", i, text: overlay });
    const name = "name" in sc ? sc.name?.trim() : undefined;
    if (name && /\p{L}/u.test(name)) jobs.push({ kind: "name", i, text: name });
    return jobs;
  });
  const started = Date.now();
  let next = 0;
  // Once one scene fails the copy has failed: the other workers start no more scenes for an answer already given.
  let failed = false;
  const worker = async () => {
    while (!failed && next < todo.length) {
      const job = todo[next++];
      try {
        if (Date.now() - started > DEADLINE_MS) throw new ValidationError("This video took too long to translate at once; try again, or translate a few scenes in the editor");
        if (job.kind !== "script") {
          // A label the script writer will not translate keeps its own words rather than failing the whole copy.
          const out = await reviseScript({ script: job.text, action: "translate", language, label: true }, ownerId).catch(() => null);
          if (out === null) continue;
          if (job.kind === "overlay") overlays[job.i] = capSceneText(out.replace(/\s+/g, " ").trim()) || null;
          else names[job.i] = capName(out) || null;
          continue;
        }
        scripts[job.i] = await reviseScript({ script: job.text, action: "translate", language }, ownerId);

      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, todo.length) }, worker));
  const all = await listVoices(ownerId);
  const voices: Record<string, string> = {};
  for (const voiceId of new Set([video.voiceId, ...scenes.map((sc) => sc.voiceId)].filter((v): v is string => !!v))) {
    const match = voiceFor(all, voiceId, code);
    if (match) voices[voiceId] = match;
  }
  return { language, scripts, voices, overlays, names };
}

/**
 * A voice that speaks `code` for one that may not: the voice itself when it does or speaks many languages (a
 * multilingual voice), else one of its gender, else any.
 */
export function voiceFor(voices: Voice[], voiceId: string, code: string): string | undefined {
  const speaks = (v: Voice) => baseLanguageCode(v.language ?? "") === code;
  const original = voices.find((v) => v.id === voiceId);
  if (original && (speaks(original) || /multilingual/i.test(original.language ?? ""))) return original.id;
  const candidates = voices.filter(speaks);
  return (candidates.find((v) => original?.gender && v.gender === original.gender) ?? candidates[0])?.id;
}
