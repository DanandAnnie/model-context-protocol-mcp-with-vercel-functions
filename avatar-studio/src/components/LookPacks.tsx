"use client";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Shirt, Sparkles, Trash2, X } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass, StatusBadge } from "@/components/ui";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { api, formatDate, isRefusal } from "@/lib/client";
import { toUploadable } from "@/lib/image-upload";
import { DESCRIBED, DESCRIBED_ASPECTS, LOOK_PACKS, lookJobTitle, lookPackName, MAX_LOOK_PROMPT, MAX_LOOK_REFERENCES, type DescribedAspect, type LookPackAspect, type LookPackKey } from "@/lib/look-packs";
import type { Avatar, LookPackJob } from "@/lib/types";

/** A look pack as the server lists it: never the renderer or its look ids. */
export type LookPack = Omit<LookPackJob, "ownerId" | "provider" | "lookIds" | "referenceDigest">;
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

/** Each wardrobe or setting picture is sent at most this large (decoded); larger ones are redrawn smaller first. */
const MAX_REFERENCE_BYTES = 1024 * 1024;
const REFERENCE_EDGE = 1600;
const FRAMES: Record<DescribedAspect, string> = { "4:5": "Portrait 4:5", "16:9": "Landscape 16:9", "9:16": "Portrait 9:16" };

/**
 * "New looks" for one of the account's photo avatars: a pack (a wardrobe and palette, or a job with its setting), the
 * pack's women's or men's looks, and a frame, from which the renderer makes about five looks around the avatar's face;
 * or one look described in words (the outfit and the setting, with up to three pictures of either to go by). Each look
 * is kept as a photo avatar of its own once it is ready.
 */
export function LookPackPanel({ avatar, canPack = true, canDescribe = false, onClose, onStarted }: { avatar: Avatar; canPack?: boolean; canDescribe?: boolean; onClose: () => void; onStarted: (pack: LookPack) => void }) {
  const [mode, setMode] = useState<"pack" | "described">(canPack ? "pack" : "described");
  const [pack, setPack] = useState<LookPackKey>(LOOK_PACKS[0].key);
  const [gender, setGender] = useState<"female" | "male" | "">(avatar.gender === "female" || avatar.gender === "male" ? avatar.gender : "");
  const [aspect, setAspect] = useState<LookPackAspect>("16:9");
  const [prompt, setPrompt] = useState("");
  const [frame, setFrame] = useState<DescribedAspect>("4:5");
  const [pictures, setPictures] = useState<Array<{ name: string; url: string }>>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // One key per start: a retry of the same start (after a timeout, say) sends it again and gets the same pack back.
  const [requestKey, setRequestKey] = useState(() => newKey());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusAfterRender = useFocusAfterRender();
  useEffect(() => headingRef.current?.focus(), []);
  const changed = () => {
    setErr(null);
    setRequestKey(newKey());
  };
  const described = mode === "described";
  const shortPrompt = prompt.trim().length < 10;

  async function addPictures(input: HTMLInputElement) {
    const picked = Array.from(input.files ?? []);
    // The control stays enabled while busy (disabling it would drop its focus); a pick made then is not taken, and
    // the page says so.
    if (!picked.length || busy || reading) {
      input.value = "";
      if (picked.length && reading) setErr("Still reading the pictures added before; add this one again in a moment.");
      return;
    }
    const room = MAX_LOOK_REFERENCES - pictures.length;
    setReading(true);
    setErr(null);
    try {
      const added: Array<{ name: string; url: string }> = [];
      for (const file of picked.slice(0, room)) added.push({ name: file.name, url: await toUploadable(file, { maxBytes: MAX_REFERENCE_BYTES, maxEdge: REFERENCE_EDGE }) });
      setPictures((list) => [...list, ...added].slice(0, MAX_LOOK_REFERENCES));
      setRequestKey(newKey());
      // With the last picture added the add control goes; the focus moves to the last picture's remove button.
      const count = Math.min(MAX_LOOK_REFERENCES, pictures.length + added.length);
      if (count === MAX_LOOK_REFERENCES) focusAfterRender(() => document.querySelector<HTMLElement>(`[data-look-reference="${count - 1}"]`));
      if (picked.length > room) setErr(`Only ${MAX_LOOK_REFERENCES} pictures can go with a look; the first ${room === 1 ? "one was" : `${room} were`} added.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That picture could not be read");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function removePicture(i: number) {
    setPictures((list) => list.filter((_, j) => j !== i));
    changed();
    // The focus goes to the next picture's remove button, or to the add button once there are none after it.
    focusAfterRender(() => document.querySelector<HTMLElement>(`[data-look-reference="${i}"]`) ?? document.querySelector<HTMLElement>(`[data-look-reference="${i - 1}"]`) ?? fileRef.current);
  }

  /** Escape closes the panel, asking first when a description or pictures would be lost with it. */
  function onPanelKey(e: React.KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented || busy) return;
    e.stopPropagation();
    if (described && (prompt.trim() || pictures.length) && !window.confirm("Discard this look? The description and pictures are not saved.")) return;
    onClose();
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body = described
        ? { avatarId: avatar.id, pack: DESCRIBED, prompt: prompt.trim(), aspect: frame, references: pictures.map((p) => p.url) }
        : { avatarId: avatar.id, pack, ...(gender ? { gender } : {}), aspect };
      const { lookPack } = await api<{ lookPack: LookPack }>("/api/look-packs", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": requestKey } });
      onStarted(lookPack);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The new looks could not be started");
      // A refusal is an answer: trying again is a new start. A lost answer, or one HeyGen is still working on, keeps its
      // key, so a retry returns the same pack instead of paying for another.
      if (isRefusal(e)) setRequestKey(newKey());
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6 p-5" data-testid="look-pack-panel" onKeyDown={onPanelKey}>
      <div className="flex items-start justify-between gap-3">
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 break-words text-sm font-semibold text-slate-900 outline-none">
          New looks of {avatar.name}
        </h2>
        <button type="button" className="shrink-0 text-xs text-slate-500 hover:underline" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        The renderer dresses this presenter in new looks, keeping the face. Each look becomes a photo avatar of its own, ready in a few minutes.
      </p>
      {canPack && canDescribe && (
        <fieldset className="mt-4">
          <legend className="mb-1.5 text-sm font-medium text-slate-700">From</legend>
          <div className="flex flex-wrap gap-4 text-sm text-slate-700">
            <label className="flex items-center gap-2">
              <input type="radio" name="look-mode" className="accent-brand-600" checked={!described} onChange={() => (setMode("pack"), changed())} />A pack of about five looks
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="look-mode" className="accent-brand-600" checked={described} onChange={() => (setMode("described"), changed())} />A look you describe
            </label>
          </div>
        </fieldset>
      )}
      {described ? (
        <>
          <div className="mt-4">
            {/* The hint (with the live count) sits outside the label, so the box's name stays "Describe the look". */}
            <label htmlFor="look-prompt" className="mb-1.5 block text-sm font-medium text-slate-700">
              Describe the look
            </label>
            <textarea
              id="look-prompt"
              className={`${inputClass} min-h-24`}
              value={prompt}
              maxLength={MAX_LOOK_PROMPT}
              aria-describedby="look-prompt-hint"
              placeholder="A navy blazer over a white shirt, in a bright office with plants behind, soft window light"
              onChange={(e) => (setPrompt(e.target.value), changed())}
            />
            <p id="look-prompt-hint" className="mt-1 text-xs text-slate-500">
              The clothes, the setting, and the light; the face stays {avatar.name}&apos;s. {prompt.length} of {MAX_LOOK_PROMPT} characters.
            </p>
          </div>
          <div className="mt-4">
            <div className="mb-1.5 text-sm font-medium text-slate-700" id="look-pictures-label">
              Pictures to go by (optional)
            </div>
            <p className="mb-2 text-xs text-slate-500" id="look-pictures-hint">
              Up to {MAX_LOOK_REFERENCES} pictures of the clothes or the place. Use pictures with no one in them, or only the garment: the face always comes from {avatar.name}.
            </p>
            {pictures.length > 0 && (
              <ul className="mb-2 flex flex-wrap gap-2" aria-labelledby="look-pictures-label">
                {pictures.map((p, i) => (
                  <li key={`${i}-${p.name}`} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt={p.name} title={p.name} className="h-16 w-16 rounded-md bg-slate-100 object-cover" />
                    <button type="button" data-look-reference={i} onClick={() => removePicture(i)} disabled={busy} className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-500 shadow hover:text-rose-600" aria-label={`Remove ${p.name}`}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {pictures.length < MAX_LOOK_REFERENCES && (
              // The input is inside its label, so the label shows the focus ring when the input has the focus.
              <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-brand-500 ${busy || reading ? "opacity-60" : ""}`}>
                <input ref={fileRef} type="file" accept="image/*" multiple className="sr-only" id="look-pictures" aria-describedby="look-pictures-hint" aria-disabled={busy || reading} onChange={(e) => addPictures(e.currentTarget)} />
                <ImagePlus className="h-4 w-4" aria-hidden /> {reading ? "Reading…" : "Add pictures"}
              </label>
            )}
          </div>
          <fieldset className="mt-4">
            <legend className="mb-1.5 text-sm font-medium text-slate-700">Frame</legend>
            <div className="flex flex-wrap gap-4 text-sm text-slate-700">
              {DESCRIBED_ASPECTS.map((a) => (
                <label key={a} className="flex items-center gap-2">
                  <input type="radio" name="look-frame" className="accent-brand-600" checked={frame === a} onChange={() => (setFrame(a), changed())} />
                  {FRAMES[a]}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : (
        <>
          <fieldset className="mt-4">
            <legend className="mb-1.5 text-sm font-medium text-slate-700">Pack</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {LOOK_PACKS.map((p) => (
                <label key={p.key} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${pack === p.key ? "border-brand-500 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}>
                  <input type="radio" name="look-pack" className="mt-0.5 accent-brand-600" checked={pack === p.key} onChange={() => (setPack(p.key), changed())} />
                  <span>
                    <span className="font-medium text-slate-900">{p.name}</span>
                    <span className="block text-xs text-slate-500">{p.kind === "style" ? "Wardrobe and palette, a neutral setting" : "Dressed and set for the job"}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-4 flex flex-wrap gap-6">
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-700">Looks</legend>
              <div className="flex gap-4 text-sm text-slate-700">
                {(["female", "male"] as const).map((g) => (
                  <label key={g} className="flex items-center gap-2">
                    <input type="radio" name="look-pack-gender" className="accent-brand-600" checked={gender === g} onChange={() => (setGender(g), changed())} />
                    {g === "female" ? "Women's" : "Men's"}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-700">Frame</legend>
              <div className="flex gap-4 text-sm text-slate-700">
                {(["16:9", "9:16"] as const).map((a) => (
                  <label key={a} className="flex items-center gap-2">
                    <input type="radio" name="look-pack-aspect" className="accent-brand-600" checked={aspect === a} onChange={() => (setAspect(a), changed())} />
                    {a === "16:9" ? "Landscape 16:9" : "Portrait 9:16"}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          {aspect === "9:16" && <p className="mt-2 text-xs text-slate-500">Portrait looks are cut from the middle of landscape ones, so a photo framed with room around the face works best.</p>}
        </>
      )}
      <ErrorBanner message={err} />
      {described ? (
        <>
          <Button className="mt-4" onClick={submit} loading={busy} disabled={shortPrompt || reading} aria-describedby={shortPrompt ? "look-draw-note" : undefined}>
            <Sparkles className="h-4 w-4" /> Draw the look
          </Button>
          {shortPrompt && (
            <p id="look-draw-note" className="mt-2 text-xs text-slate-500">
              Describe the outfit and setting in a few words first.
            </p>
          )}
        </>
      ) : (
        <>
          <Button className="mt-4" onClick={submit} loading={busy} disabled={!gender} aria-describedby={!gender ? "look-pack-note" : undefined}>
            <Shirt className="h-4 w-4" /> Make new looks
          </Button>
          {!gender && (
            <p id="look-pack-note" className="mt-2 text-xs text-slate-500">
              Choose the women&apos;s or the men&apos;s looks of the pack.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** "the Cool tech looks of Ana", or "the described look of Ana". */
function theLooks(p: LookPack, name: string): string {
  return p.pack === DESCRIBED ? `the described look of ${name}` : `the ${lookPackName(p.pack)} looks of ${name}`;
}

/** The account's look packs: how many looks are ready, the presenters made of them, and any that failed. */
export function LookPackList({ packs, avatars, canEdit, onForget, fallbackFocus }: { packs: LookPack[]; avatars: Avatar[]; canEdit: boolean; onForget: (pack: LookPack) => Promise<void>; fallbackFocus: () => HTMLElement | null }) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const [err, setErr] = useState<string | null>(null);
  // A presenter counts as deleted only once it was listed and is gone, not while the avatars are still being asked for.
  const listedOnce = useRef<Set<string>>(new Set());
  for (const a of avatars) listedOnce.current.add(a.id);
  if (packs.length === 0) return null;

  async function forget(p: LookPack) {
    const one = p.pack === DESCRIBED;
    if (!window.confirm(`Forget ${theLooks(p, `“${p.avatarName}”`)}? The photo ${one ? "avatar made of it stays" : "avatars made of them stay"}.`)) return;
    setErr(null);
    const next = packs[packs.indexOf(p) + 1] ?? packs[packs.indexOf(p) - 1];
    try {
      await onForget(p);
      // Focus moves to the next pack, or, with none left (the list goes), to the page's own control.
      focusAfterRender(() => (next ? (listRef.current?.querySelector<HTMLElement>(`[data-look-pack="${next.id}"]`) ?? fallbackFocus()) : fallbackFocus()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The look pack could not be forgotten");
    }
  }

  return (
    <section ref={listRef} className="mb-6" data-testid="look-packs">
      <h2 tabIndex={-1} className="mb-2 text-sm font-semibold text-slate-900 outline-none">
        New looks
      </h2>
      <ErrorBanner message={err} />
      <div className="space-y-2">
        {packs.map((p) => {
          const ready = p.looks.filter((l) => l.status === "completed").length;
          const failed = p.looks.filter((l) => l.status === "failed");
          const made = p.looks.map((l) => avatars.find((a) => a.id === l.avatarId)).filter((a): a is Avatar => !!a);
          const deleted = p.looks.filter((l) => l.avatarId && listedOnce.current.has(l.avatarId) && !avatars.some((a) => a.id === l.avatarId)).length;
          return (
            <Card key={p.id} className="p-3 outline-none focus:ring-2 focus:ring-brand-500" data-testid="look-pack" data-look-pack={p.id} tabIndex={-1}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900">{lookJobTitle(p)}</div>
                  {p.prompt && (
                    <div className="mt-0.5 line-clamp-2 break-words text-xs text-slate-600" data-testid="look-prompt" title={p.prompt}>
                      {p.prompt}
                    </div>
                  )}
                  <div className="mt-0.5 text-xs text-slate-500" data-testid="look-pack-meta">
                    {ready} of {p.looks.length} ready · {p.aspect}
                    {p.references ? ` · ${p.references} ${p.references === 1 ? "picture" : "pictures"}` : ""} · {formatDate(p.createdAt)}
                    {failed.length ? ` · ${failed.length} could not be made` : ""}
                    {deleted ? ` · ${deleted} since deleted` : ""}
                  </div>
                  {failed[0]?.error && <div className="mt-1 text-xs text-rose-600">{failed[0].error}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={p.status} />
                  {canEdit && (
                    <button type="button" onClick={() => forget(p)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Forget ${theLooks(p, p.avatarName)}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              {made.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2" aria-label="Presenters made of these looks">
                  {made.map((a) => (
                    <li key={a.id}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.imageUrl} alt={a.name} title={a.name} className="h-14 w-14 rounded-md bg-slate-100 object-cover" />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
