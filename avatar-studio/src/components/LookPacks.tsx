"use client";
import { useEffect, useRef, useState } from "react";
import { Shirt, Trash2 } from "lucide-react";
import { Button, Card, ErrorBanner, StatusBadge } from "@/components/ui";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { ApiError, api, formatDate } from "@/lib/client";
import { LOOK_PACKS, lookPackName, type LookPackAspect, type LookPackKey } from "@/lib/look-packs";
import type { Avatar, LookPackJob } from "@/lib/types";

/** A look pack as the server lists it: never the renderer or its look ids. */
export type LookPack = Omit<LookPackJob, "ownerId" | "provider" | "lookIds">;
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

/**
 * "New looks" for one of the account's photo avatars: a pack (a wardrobe and palette, or a job with its setting), the
 * pack's women's or men's looks, and a frame. The renderer makes about five looks around the avatar's face, each kept as
 * a photo avatar of its own once it is ready.
 */
export function LookPackPanel({ avatar, onClose, onStarted }: { avatar: Avatar; onClose: () => void; onStarted: (pack: LookPack) => void }) {
  const [pack, setPack] = useState<LookPackKey>(LOOK_PACKS[0].key);
  const [gender, setGender] = useState<"female" | "male" | "">(avatar.gender === "female" || avatar.gender === "male" ? avatar.gender : "");
  const [aspect, setAspect] = useState<LookPackAspect>("16:9");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // One key per start: a retry of the same start (after a timeout, say) sends it again and gets the same pack back.
  const [requestKey, setRequestKey] = useState(() => newKey());
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const changed = () => {
    setErr(null);
    setRequestKey(newKey());
  };

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const { lookPack } = await api<{ lookPack: LookPack }>("/api/look-packs", { method: "POST", body: JSON.stringify({ avatarId: avatar.id, pack, ...(gender ? { gender } : {}), aspect }), headers: { "Idempotency-Key": requestKey } });
      onStarted(lookPack);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The new looks could not be started");
      // A refusal is an answer: trying again is a new start. A lost answer keeps its key, so a retry returns the same pack.
      if (e instanceof ApiError && e.status < 500) setRequestKey(newKey());
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6 p-5" data-testid="look-pack-panel" onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
      <div className="flex items-start justify-between gap-3">
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 break-words text-sm font-semibold text-slate-900 outline-none">
          New looks of {avatar.name}
        </h2>
        <button type="button" className="shrink-0 text-xs text-slate-500 hover:underline" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">The renderer dresses this presenter in a pack&apos;s looks, keeping the face. Each look becomes a photo avatar of its own, ready in a few minutes.</p>
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
      <ErrorBanner message={err} />
      <Button className="mt-4" onClick={submit} loading={busy} disabled={!gender}>
        <Shirt className="h-4 w-4" /> Make new looks
      </Button>
      {!gender && <p className="mt-2 text-xs text-slate-500">Choose the women&apos;s or the men&apos;s looks of the pack.</p>}
    </Card>
  );
}

/** The account's look packs: how many looks are ready, the presenters made of them, and any that failed. */
export function LookPackList({ packs, avatars, canEdit, onForget }: { packs: LookPack[]; avatars: Avatar[]; canEdit: boolean; onForget: (pack: LookPack) => Promise<void> }) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const [err, setErr] = useState<string | null>(null);
  if (packs.length === 0) return null;

  async function forget(p: LookPack) {
    if (!window.confirm(`Forget the ${lookPackName(p.pack)} looks of “${p.avatarName}”? The photo avatars made of them stay.`)) return;
    setErr(null);
    const next = packs[packs.indexOf(p) + 1] ?? packs[packs.indexOf(p) - 1];
    try {
      await onForget(p);
      focusAfterRender(() => (next ? listRef.current?.querySelector<HTMLElement>(`[data-look-pack="${next.id}"]`) : listRef.current?.querySelector<HTMLElement>("h2")));
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
          return (
            <Card key={p.id} className="p-3 outline-none focus:ring-2 focus:ring-brand-500" data-testid="look-pack" data-look-pack={p.id} tabIndex={-1}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900">
                    {lookPackName(p.pack)} looks of {p.avatarName}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500" data-testid="look-pack-meta">
                    {ready} of {p.looks.length} ready · {p.aspect} · {formatDate(p.createdAt)}
                    {failed.length ? ` · ${failed.length} could not be made` : ""}
                  </div>
                  {failed[0]?.error && <div className="mt-1 text-xs text-rose-600">{failed[0].error}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={p.status} />
                  {canEdit && (
                    <button type="button" onClick={() => forget(p)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Forget the ${lookPackName(p.pack)} looks of ${p.avatarName}`}>
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
