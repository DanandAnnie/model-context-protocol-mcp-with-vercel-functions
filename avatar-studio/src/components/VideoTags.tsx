"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { VIDEO_TAGS_MAX, VIDEO_TAG_MAX, cleanTags, sameTag, tagText } from "@/lib/tags";

/** Where the focus goes once a removal is done and the list shows it: the tag button at `at`, or the field. */
type FocusAfter = { at: number; removed?: string; from: Element | null };

/**
 * A video's tags on its page: each a chip with a button to take it off, and a field to add one (Enter or a comma adds
 * it; a pasted list with commas adds each; the tags already used in the library are offered). Each change saves at once,
 * as a change the server makes to the tags it holds (`onSave` gets the tags to add or remove and answers with the tags
 * as saved); viewers see the chips only.
 */
export function VideoTags({ tags, canEdit, suggestions, onSave }: { tags: string[]; canEdit: boolean; suggestions: string[]; onSave: (change: { add?: string[]; remove?: string[] }) => Promise<string[]> }) {
  const [draft, setDraft] = useState("");
  // How many saves are under way: they run one after another, so tags typed while one saves are not lost.
  const [pending, setPending] = useState(0);
  const running = useRef(0);
  const busy = pending > 0;
  // The tags as the last save left them, for the checks made before a queued save (already there, room for more); the
  // server works the change out from what it holds, so a tag set elsewhere meanwhile stays.
  const latest = useRef(tags);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  if (!busy) latest.current = tags;
  // Text of this burst's adds that could not be saved, in the order they were typed, put back ahead of anything typed since.
  const back = useRef("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const fieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfter = useRef<FocusAfter | null>(null);
  const listId = useId();
  const fullId = useId();
  const offered = suggestions.filter((s) => !tags.some((t) => sameTag(t, s)));
  const full = tags.length >= VIDEO_TAGS_MAX;

  // After a removal, once the chips show it: the next tag's button, or the one before, or the field when none is left. The
  // focus moves only if it is still on the button that was pressed (or was dropped with it), never from the field or
  // wherever else the user went meanwhile.
  useEffect(() => {
    const want = focusAfter.current;
    if (busy || !want) return;
    if (want.removed !== undefined && tags.includes(want.removed)) return;
    focusAfter.current = null;
    const now = document.activeElement;
    if (now && now !== document.body && now !== want.from) return;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
    (buttons?.length ? buttons[Math.min(want.at, buttons.length - 1)] : fieldRef.current)?.focus();
  }, [busy, tags]);

  function say(text: string) {
    // Cleared first, so the same words said again are heard again.
    setNote("");
    requestAnimationFrame(() => setNote(text));
  }
  /** Runs `work` after the saves already asked for. */
  function enqueue(work: () => Promise<void>) {
    // A new burst of typing starts with nothing put back yet.
    if (running.current === 0) back.current = "";
    running.current += 1;
    setPending((n) => n + 1);
    const run = queue.current.then(work).finally(() => {
      running.current -= 1;
      setPending((n) => n - 1);
    });
    queue.current = run.catch(() => {});
  }
  /** Puts back text taken from the field for an add that did not happen: after the burst's earlier ones, before what is typed since. */
  function restore(value: string) {
    const before = back.current;
    const text = tagText(value.replace(/,/g, ", "));
    back.current = before ? `${before}, ${text}` : text;
    setDraft((typed) => {
      const since = before && typed.startsWith(before) ? typed.slice(before.length).replace(/^\s*,\s*/, "") : typed;
      return since.trim() ? `${back.current}, ${since}` : back.current;
    });
  }
  function add(value = draft) {
    // Each comma ends a tag, so "spring, open house" pasted in adds two.
    if (!value.split(",").some((t) => tagText(t))) return;
    // What was put back is sent again with the rest, so it is no longer waiting in front of the field.
    back.current = "";
    // The field is free for the next tag at once; the text comes back if this one cannot be saved. An earlier refusal's
    // words go only when the user tries again, not when a later tag of the same burst saves.
    setDraft("");
    setError(null);
    enqueue(async () => {
      const asked = value.split(",").map(tagText).filter(Boolean);
      const current = latest.current;
      const fresh = cleanTags(asked).filter((t) => !current.some((have) => sameTag(have, t)));
      if (!fresh.length) {
        say(asked.length === 1 ? `Already tagged “${asked[0]}”` : "Already tagged with these");
        return;
      }
      // The ones that can go on are saved; a tag too long, or past the ten, comes back into the field on its own.
      const fits = fresh.filter((t) => Array.from(t).length <= VIDEO_TAG_MAX);
      const room = Math.max(0, VIDEO_TAGS_MAX - current.length);
      const saving = fits.slice(0, room);
      const kept = fresh.filter((t) => !saving.includes(t));
      if (kept.length) {
        restore(kept.join(", "));
        setError(fits.length < fresh.length ? `A tag is at most ${VIDEO_TAG_MAX} characters` : `A video takes at most ${VIDEO_TAGS_MAX} tags; ${room} more ${room === 1 ? "fits" : "fit"}`);
      }
      if (!saving.length) return;
      try {
        latest.current = await onSave({ add: saving });
        say(saving.length === 1 ? `Tag “${saving[0]}” added` : `${saving.length} tags added: ${saving.join(", ")}`);
      } catch (e) {
        restore(saving.join(", "));
        setError(e instanceof Error ? e.message : "Could not save the tags");
      }
    });
  }
  function remove(tag: string, at: number) {
    setError(null);
    const from = document.activeElement;
    enqueue(async () => {
      try {
        latest.current = await onSave({ remove: [tag] });
        say(`Tag “${tag}” removed`);
        focusAfter.current = { at, removed: tag, from };
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save the tags");
        // Back on the button of the tag that is still on.
        focusAfter.current = { at, from };
      }
    });
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
      {canEdit && (
          <>
            {/*
              Never disabled while saving: a disabled field drops the focus, and what is typed meanwhile is the next tag.
              With ten tags on it stays, read-only, so keys typed on land here rather than on a tag's remove button.
            */}
            <input
              ref={fieldRef}
              list={full ? undefined : listId}
              aria-label="Add a tag"
              aria-busy={busy}
              aria-describedby={full ? fullId : undefined}
              readOnly={full}
              placeholder={full ? `${VIDEO_TAGS_MAX} tags on` : "Add a tag"}
              value={draft}
              maxLength={200}
              onChange={(e) => {
                // A comma ends a tag, as Enter does.
                if (e.target.value.endsWith(",")) add(e.target.value.slice(0, -1));
                else setDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!full) add();
                }
                if (e.key === "Escape" && draft) {
                  e.preventDefault();
                  setDraft("");
                }
              }}
              className="w-36 rounded border border-slate-200 px-2 py-0.5 text-right text-sm focus:border-brand-500 focus:outline-none"
            />
            <datalist id={listId}>
              {offered.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            {full && (
              <span id={fullId} className="text-xs text-slate-500">
                {VIDEO_TAGS_MAX} tags, the most a video takes
              </span>
            )}
          </>
        )}
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
