"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Sparkles, Undo2 } from "lucide-react";
import { Button } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/client";
import { AUDIO_TAGS, AUDIO_TAG_CATEGORY_NOTES, COMMON_AUDIO_TAGS, scanAudioTags, type AudioTagCategory } from "@/lib/audio-tags";
import type { ProviderStatus } from "@/lib/types";

const CATEGORIES = Object.keys(COMMON_AUDIO_TAGS) as AudioTagCategory[];
const LABELS: Record<AudioTagCategory, string> = { emotion: "Emotion", delivery: "Delivery", "acoustic event": "Sounds", scenario: "Scenario" };

/**
 * HeyGen Voice audio tags for a text to speak: a picker that puts a tag at the cursor, Claude's draft of tags for the
 * whole text (undoable), and notes on what HeyGen will not perform: bracketed text that is no tag, tags side by side,
 * and any tag at all for a professional voice.
 */
export function AudioTagTools({
  text,
  onText,
  field,
  disabled,
  professional,
  max,
  onDrafting,
}: {
  text: string;
  onText: (text: string) => void;
  field: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  /** The chosen voice's name when it is a professional voice, which performs no tags. */
  professional?: string;
  max: number;
  /** Told while Claude drafts, so the text is not edited under it. */
  onDrafting?: (drafting: boolean) => void;
}) {
  const { data: status } = useApi<ProviderStatus>("/api/status");
  const [drafting, setDrafting] = useState(false);
  // The text before Claude's draft, and the draft: Undo is offered while the text is still the draft.
  const [before, setBefore] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scan = scanAudioTags(text);
  // The text as it is now, for an answer arriving later; and the text this component last set, so typing clears its note.
  const latest = useRef(text);
  latest.current = text;
  const setByUs = useRef<string | null>(null);
  useEffect(() => {
    if (setByUs.current === text) return;
    setNote(null);
    setErr(null);
  }, [text]);
  const put = (next: string) => {
    setByUs.current = next;
    onText(next);
  };

  function insert(tag: string) {
    const el = field.current;
    // After the cursor, or after the words selected, which are kept.
    const at = el ? el.selectionEnd : text.length;
    // A space before the tag when it follows a word, and one after it, where the words go on.
    const lead = at > 0 && !/\s$/.test(text.slice(0, at)) ? " " : "";
    const piece = `${lead}[${tag}] `;
    const rest = text.slice(at).replace(/^[ \t]+/, "");
    const next = text.slice(0, at) + piece + rest;
    if (next.length > max) {
      setNote(null);
      setErr(`There is no room for [${tag}]: the text would be over ${max.toLocaleString("en-US")} characters. Shorten it first.`);
      return;
    }
    put(next);
    setBefore(null);
    setDrafted(null);
    setNote(`Added [${tag}].`);
    setErr(null);
    // The cursor goes after the tag, so the next words or tag follow it.
    requestAnimationFrame(() => {
      if (!field.current) return;
      const pos = Math.min(next.length, at + piece.length);
      field.current.focus();
      field.current.setSelectionRange(pos, pos);
    });
  }

  async function draft() {
    const sent = text;
    setDrafting(true);
    onDrafting?.(true);
    setErr(null);
    setNote(null);
    try {
      const out = await api<{ text: string; added: number }>("/api/voice-changer/speech/tags", { method: "POST", body: JSON.stringify({ text: sent }) });
      if (latest.current !== sent) {
        // Edited meanwhile (the field is locked, but another control may have set it): the draft is of an old text.
        setErr("The text changed while Claude was adding tags; ask again for the text as it is now.");
      } else if (out.text === sent.trim() || out.added === 0) {
        setNote("Claude found no spot for another tag; the text is as it was.");
      } else {
        setBefore(sent);
        setDrafted(out.text);
        put(out.text);
        setNote(`Claude added ${out.added} ${out.added === 1 ? "tag" : "tags"}, leaving the words as they were. Read them before speaking the text.`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Claude could not add tags just now");
    } finally {
      setDrafting(false);
      onDrafting?.(false);
    }
  }

  const warnings = [
    professional && scan.tags.length ? `${professional} is one of HeyGen's professional voices, which do not perform audio tags; take them out, or choose an instant voice.` : null,
    scan.unknown.length ? `${scan.unknown.slice(0, 3).join(", ")}${scan.unknown.length > 3 ? ", and more," : ""} ${scan.unknown.length === 1 ? "is not a HeyGen tag, so it" : "are not HeyGen tags, so they"} will usually not be spoken; take off the brackets to have the words read.` : null,
    scan.sideBySide.length ? `Put one tag at a spot: ${scan.sideBySide[0]} are side by side.` : null,
  ].filter((w): w is string => !!w);

  return (
    <div className="space-y-2" data-testid="audio-tags">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="audio-tag-pick" className="text-sm text-slate-700">
          Audio tag
        </label>
        <select
          id="audio-tag-pick"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          value=""
          disabled={disabled || drafting}
          aria-describedby="audio-tag-hint"
          onChange={(e) => e.target.value && insert(e.target.value)}
        >
          <option value="">Put a tag at the cursor…</option>
          {CATEGORIES.map((c) => (
            <optgroup key={c} label={`${LABELS[c]}: ${AUDIO_TAG_CATEGORY_NOTES[c].toLowerCase()}`}>
              {COMMON_AUDIO_TAGS[c].map((t) => (
                <option key={t} value={t}>
                  [{t}]
                </option>
              ))}
            </optgroup>
          ))}
          {CATEGORIES.map((c) => (
            <optgroup key={`more-${c}`} label={`More ${LABELS[c].toLowerCase()}`}>
              {AUDIO_TAGS[c]
                .filter((t) => !COMMON_AUDIO_TAGS[c].includes(t))
                .map((t) => (
                  <option key={t} value={t}>
                    [{t}]
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        {status?.audioTagDrafts && (
          <Button type="button" variant="secondary" onClick={() => void draft()} loading={drafting} disabled={disabled || !text.trim()} title="Claude adds tags where the delivery changes or a sound fits, without changing a word">
            <Sparkles className="h-4 w-4" /> Add tags with Claude
          </Button>
        )}
        {before !== null && drafted !== null && text === drafted && (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              put(before);
              setBefore(null);
              setDrafted(null);
              setNote("The text is back as it was before the tags were added.");
            }}
          >
            <Undo2 className="h-4 w-4" /> Undo tags
          </Button>
        )}
      </div>
      <p id="audio-tag-hint" className="text-xs text-slate-500">
        Tags such as [excited], [whispers], or [laughs] direct how HeyGen&apos;s instant and public voices speak. A feeling or delivery lasts about 17 seconds of speech; write it again to keep it longer. Tags are always English and count toward the limit.
      </p>
      <p role="status" className="text-xs empty:hidden" data-testid="audio-tag-note">
        {err ? <span className="text-rose-700">{err}</span> : note ? <span className="text-emerald-700">{note}</span> : null}
      </p>
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="audio-tag-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
