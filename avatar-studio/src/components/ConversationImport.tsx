"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { Button, inputClass } from "@/components/ui";
import { MAX_SPEAKERS, parseDialogue } from "@/lib/dialogue";
import { foldTerm } from "@/lib/glossary";
import { languageCode } from "@/lib/language";
import { MAX_SCRIPT_CHARS } from "@/lib/script-import";
import { MAX_SCENES, type Avatar, type Voice } from "@/lib/types";

/** One scene of the conversation: what is said, and by which presenter and voice ("" for the video's own). */
export interface CastTurn {
  script: string;
  avatarId: string;
  voiceId: string;
}

type Choice = { avatarId?: string; voiceId?: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const TOO_LONG = `the rest did not fit (a video holds up to ${MAX_SCENES} scenes and ${MAX_SCRIPT_CHARS} characters of script)`;
/** The panel's id, for the toggle's `aria-controls`. */
export const CONVERSATION_PANEL_ID = "conversation-import";

/**
 * The voice offered with a presenter: its own where it has one no one has been offered; else a voice no one has been
 * offered that speaks the conversation's language, of the presenter's gender where one is; else "" (the video's).
 */
function offerVoice(avatar: Avatar | undefined, voices: Voice[], taken: Set<string>, language: string | undefined): string {
  if (!avatar) return "";
  const own = avatar.defaultVoiceId;
  if (own && !taken.has(own) && voices.some((v) => v.id === own)) return own;
  // A voice whose language is not known could speak anything, so it is only offered when the video's is not known either.
  const free = voices.filter((v) => !taken.has(v.id) && (!language || languageCode(v.language) === language));
  return (free.find((v) => avatar.gender && v.gender === avatar.gender) ?? free[0])?.id ?? "";
}

/**
 * Paste a conversation ("Alex: …" / "Sam: …"), cast each speaker with a presenter and a voice, and make one scene per
 * turn. The first speaker is the video's own presenter and voice unless changed; each other speaker is offered a
 * presenter, and a voice in the video voice's language, that neither the video nor an earlier speaker is offered.
 */
export function ConversationImport({
  avatars,
  voices,
  videoAvatar,
  videoVoice,
  onMake,
  onCancel,
}: {
  avatars: Avatar[];
  voices: Voice[];
  videoAvatar: Avatar | null;
  videoVoice: Voice | null;
  /** Makes the scenes (once the person agrees to replace any they have), with a line saying what was made. */
  onMake: (turns: CastTurn[], summary: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  // What the person chose for each speaker (by name, in any case), field by field; anything not chosen is offered.
  const [picks, setPicks] = useState<Record<string, Choice>>({});
  const dialogue = useMemo(() => parseDialogue(text), [text]);
  // "No speakers found" waits for a pause in the typing, so it is not shown (and read out) from the first letter.
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), 800);
    return () => clearTimeout(timer);
  }, [text]);
  const { speakers, turns } = dialogue;

  const cast = useMemo(() => {
    const voiceIds = new Set(voices.map((v) => v.id));
    const avatarIds = new Set(avatars.map((a) => a.id));
    /** A presenter's own voice, where it has one that is listed. */
    const ownVoice = (avatarId: string) => {
      const own = avatars.find((a) => a.id === avatarId)?.defaultVoiceId;
      return own && voiceIds.has(own) ? own : undefined;
    };
    // What each speaker is offered depends only on their place in the conversation, so choosing for one speaker never
    // changes what another is shown: a presenter (and voice) neither the video nor an earlier speaker is offered.
    // The conversation is in the video voice's language, so the others are offered voices that speak it.
    const language = languageCode(videoVoice?.language);
    const usedAvatars = new Set([videoAvatar?.id ?? ""]);
    const usedVoices = new Set([videoVoice?.id ?? ""]);
    const offered = speakers.map((_, i) => {
      if (i === 0) return { avatarId: "", voiceId: "" };
      // With fewer presenters than speakers, the rest are the video's own until one is chosen.
      const avatar = avatars.find((a) => !usedAvatars.has(a.id));
      const avatarId = avatar?.id ?? "";
      const voiceId = offerVoice(avatar, voices, usedVoices, language);
      usedAvatars.add(avatarId);
      usedVoices.add(voiceId);
      return { avatarId, voiceId };
    });
    return speakers.map((s, i) => {
      const p = picks[foldTerm(s)] ?? {};
      // A choice whose presenter or voice is no longer listed is the video's own.
      const avatarId = p.avatarId === undefined ? offered[i].avatarId : avatarIds.has(p.avatarId) ? p.avatarId : "";
      // A presenter chosen here brings its own voice where it has one, unless a voice was chosen too.
      let voiceId = offered[i].voiceId;
      if (p.voiceId !== undefined) voiceId = voiceIds.has(p.voiceId) ? p.voiceId : "";
      else if (p.avatarId !== undefined) voiceId = avatarId ? (ownVoice(avatarId) ?? offered[i].voiceId) : "";
      return { avatarId, voiceId };
    });
  }, [speakers, picks, avatars, voices, videoAvatar, videoVoice]);

  const choose = (speaker: string, patch: Choice) => setPicks((prev) => ({ ...prev, [foldTerm(speaker)]: { ...prev[foldTerm(speaker)], ...patch } }));
  const tooMany = speakers.length > MAX_SPEAKERS;
  const turnsBy = (s: string) => turns.filter((t) => t.speaker === s).length;

  const notes = [
    dialogue.skipped ? `${plural(dialogue.skipped, "line")} before the first name ${dialogue.skipped === 1 ? "is" : "are"} left out` : "",
    dialogue.directions ? `${plural(dialogue.directions, "stage direction")} in parentheses ${dialogue.directions === 1 ? "is" : "are"} not spoken` : "",
    dialogue.truncated ? TOO_LONG : "",
  ].filter(Boolean);
  const status = !text.trim()
    ? ""
    : tooMany
    ? `This conversation has ${speakers.length} speakers (${speakers.join(", ")}); a video can cast up to ${MAX_SPEAKERS}. A line that starts with a name and a colon begins a turn.`
    : !turns.length
    ? settled !== text
      ? ""
      : "No speakers found: start each turn with the speaker's name and a colon, as in “Alex: Welcome back.”"
    : `${plural(speakers.length, "speaker")}, ${plural(turns.length, "scene")}${notes.length ? `; ${notes.join("; ")}` : ""}.`;

  function make() {
    if (tooMany || !turns.length) return;
    const index = new Map(speakers.map((s, i) => [s, i]));
    const made = turns.map((t) => ({ script: t.text, ...cast[index.get(t.speaker)!] }));
    const who = speakers.map((s) => `${s} in ${turnsBy(s)}`).join(", ");
    onMake(made, `Made ${plural(made.length, "scene")} from the conversation: ${who}${dialogue.truncated ? `; ${TOO_LONG}` : ""}.`);
  }

  return (
    <div
      id={CONVERSATION_PANEL_ID}
      role="group"
      aria-labelledby={`${id}-title`}
      // Escape closes the panel, as Cancel does.
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onCancel();
        }
      }}
      className="mb-3 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600" data-testid="conversation-import">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 id={`${id}-title`} className="text-sm font-semibold text-slate-800">
          Conversation
        </h3>
        <span className="text-slate-500">Replaces the scenes: one per turn, each spoken by its speaker</span>
      </div>
      <label htmlFor={`${id}-text`} className="mb-1 block font-medium text-slate-700">
        Paste or write the conversation
      </label>
      <textarea
        id={`${id}-text`}
        autoFocus
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-describedby={`${id}-hint ${id}-status`}
        placeholder={"Alex: Welcome back to the show.\nSam: Thanks for having me.\nAlex: Let's start with the market."}
        className={`${inputClass} font-mono text-xs`}
      />
      <p id={`${id}-hint`} className="mt-1 text-slate-500">
        Start each turn with the speaker&apos;s name and a colon. Lines without a name carry the turn on, and a line of only a stage direction in parentheses is not spoken.
      </p>
      {speakers.length > 0 && !tooMany && (
        <ul className="mt-3 space-y-2" aria-label="Speakers">
          {speakers.map((s, i) => (
            <li key={s} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <span className="min-w-24 font-medium text-slate-800">
                {s} <span className="font-normal text-slate-500">· {plural(turnsBy(s), "scene")}</span>
              </span>
              <select aria-label={`${s}'s presenter`} className={`${inputClass} w-auto py-1 text-xs`} value={cast[i].avatarId} onChange={(e) => choose(s, { avatarId: e.target.value })}>
                <option value="">{videoAvatar ? `Video avatar (${videoAvatar.name})` : "Video avatar"}</option>
                {avatars.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <select aria-label={`${s}'s voice`} className={`${inputClass} w-auto py-1 text-xs`} value={cast[i].voiceId} onChange={(e) => choose(s, { voiceId: e.target.value })}>
                <option value="">{videoVoice ? `Video voice (${videoVoice.name})` : "Video voice"}</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
      <p id={`${id}-status`} role="status" className={`mt-2 ${tooMany || !turns.length ? "text-amber-800" : "text-slate-600"}`} data-testid="conversation-status">
        {status}
      </p>
      <div className="mt-3 flex gap-2">
        <Button type="button" onClick={make} disabled={tooMany || !turns.length} className="px-3 py-1.5 text-xs">
          {turns.length && !tooMany ? `Make ${plural(turns.length, "scene")}` : "Make scenes"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} className="px-3 py-1.5 text-xs">
          Cancel
        </Button>
      </div>
    </div>
  );
}
