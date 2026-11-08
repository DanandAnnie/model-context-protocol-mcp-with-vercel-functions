"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { VIDEO_TAGS_MAX, VIDEO_TAG_MAX, cleanTags, sameTag, tagText } from "@/lib/tags";

/** Where the focus goes once a save is done and the list shows its result. */
type FocusAfter = { to: "field" } | { to: "chip"; at: number; removed?: string };

/**
 * A video's tags on its page: each a chip with a button to take it off, and a field to add one (Enter or a comma adds
 * it; a pasted list with commas adds each; the tags already used in the library are offered). Each change saves at once;
 * viewers see the chips only.
 */
export function VideoTags({ tags, canEdit, suggestions, onSave }: { tags: string[]; canEdit: boolean; suggestions: string[]; onSave: (tags: string[]) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const fieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfter = useRef<FocusAfter | null>(null);
  const listId = useId();
  const offered = suggestions.filter((s) => !tags.some((t) => sameTag(t, s)));
  const full = tags.length >= VIDEO_TAGS_MAX;

  // Moved once the save is over and the chips show it: a removed tag's button is gone by then, so the next one (or the one
  // before, or the field when none is left) takes the focus, and the field is enabled again after an add.
  useEffect(() => {
    const want = focusAfter.current;
    if (busy || !want) return;
    if (want.to === "chip" && want.removed !== undefined && tags.includes(want.removed)) return;
    focusAfter.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
    const chip = buttons?.length ? buttons[want.to === "chip" ? Math.min(want.at, buttons.length - 1) : buttons.length - 1] : null;
    // The field is gone once the tenth tag is on: the last tag's button holds the focus then.
    (want.to === "chip" ? (chip ?? fieldRef.current) : (fieldRef.current ?? chip))?.focus();
  }, [busy, tags]);

  function say(text: string) {
    // Cleared first, so the same words said again are heard again.
    setNote("");
    requestAnimationFrame(() => setNote(text));
  }
  async function save(next: string[], said: string, then: FocusAfter): Promise<boolean> {
    setBusy(true);
    try {
      await onSave(next);
      setError(null);
      say(said);
      focusAfter.current = then;
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the tags");
      // Back where it was: the field, or the button of the tag that is still on.
      focusAfter.current = then.to === "field" ? then : { to: "chip", at: then.at };
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function add(value = draft) {
    if (busy) return;
    // Each comma ends a tag, so "spring, open house" pasted in adds two.
    const asked = value.split(",").map(tagText).filter(Boolean);
    if (!asked.length) return;
    const fresh = cleanTags(asked).filter((t) => !tags.some((have) => sameTag(have, t)));
    if (!fresh.length) {
      setDraft("");
      say(asked.length === 1 ? `Already tagged “${asked[0]}”` : "Already tagged with these");
      return;
    }
    const long = fresh.find((t) => Array.from(t).length > VIDEO_TAG_MAX);
    if (long) {
      setError(`A tag is at most ${VIDEO_TAG_MAX} characters`);
      return;
    }
    if (tags.length + fresh.length > VIDEO_TAGS_MAX) {
      setError(`A video takes at most ${VIDEO_TAGS_MAX} tags; ${VIDEO_TAGS_MAX - tags.length} more fit`);
      return;
    }
    const said = fresh.length === 1 ? `Tag “${fresh[0]}” added` : `${fresh.length} tags added: ${fresh.join(", ")}`;
    if (await save([...tags, ...fresh], said, { to: "field" })) setDraft("");
  }
  async function remove(tag: string, at: number) {
    if (busy) return;
    await save(
      tags.filter((t) => t !== tag),
      `Tag “${tag}” removed`,
      { to: "chip", at, removed: tag },
    );
  }

  return (
    <div className="flex flex-col items-end gap-1" data-testid="video-tags">
      {tags.length > 0 ? (
        <ul ref={listRef} className="flex flex-wrap justify-end gap-1" aria-label="Tags">
          {tags.map((t, i) => (
            <li key={t} className="inline-flex max-w-full items-center rounded-full bg-slate-100 text-xs font-medium text-slate-700">
              <span className={`truncate py-0.5 ${canEdit ? "pl-2 pr-1" : "px-2"}`} data-testid="video-tag">
                {t}
              </span>
              {canEdit && (
                <button type="button" onClick={() => remove(t, i)} disabled={busy} aria-label={`Remove tag ${t}`} title="Remove this tag" className="rounded-r-full py-0.5 pl-0.5 pr-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-50">
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        !canEdit && <span className="text-slate-400">None</span>
      )}
      {canEdit &&
        (full ? (
          <span className="text-xs text-slate-500">{VIDEO_TAGS_MAX} tags, the most a video takes</span>
        ) : (
          <>
            {/* Read-only, not disabled, while saving: a disabled field drops the focus, so the keyboard would lose its place. */}
            <input
              ref={fieldRef}
              list={listId}
              aria-label="Add a tag"
              aria-busy={busy}
              placeholder="Add a tag"
              value={draft}
              maxLength={200}
              readOnly={busy}
              onChange={(e) => {
                // A comma ends a tag, as Enter does.
                if (e.target.value.endsWith(",")) {
                  setDraft(e.target.value.slice(0, -1));
                  void add(e.target.value.slice(0, -1));
                } else setDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
                if (e.key === "Escape" && draft) {
                  e.preventDefault();
                  setDraft("");
                }
              }}
              className={`w-36 rounded border border-slate-200 px-2 py-0.5 text-right text-sm focus:border-brand-500 focus:outline-none ${busy ? "opacity-60" : ""}`}
            />
            <datalist id={listId}>
              {offered.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        ))}
      {error && (
        <span role="alert" className="text-xs text-rose-700">
          {error}
        </span>
      )}
      <span role="status" className="sr-only" data-testid="video-tags-note">
        {note}
      </span>
    </div>
  );
}
