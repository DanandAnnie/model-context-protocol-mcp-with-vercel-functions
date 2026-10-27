"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Film } from "lucide-react";
import { Button, Card, ErrorBanner, Field, SectionTitle, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { ApiError, api, isRefusal } from "@/lib/client";
import { CINEMATIC_MAX_LOOKS, CINEMATIC_MAX_SEC, CINEMATIC_MIN_SEC, type AspectRatio, type Avatar, type ProviderStatus, type Resolution, type Video } from "@/lib/types";

/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
/** Longest description the server takes. */
const MAX_PROMPT = 4000;
/** Presenters listed at once; a search narrows a long library. */
const SHOWN = 60;
const ASPECTS: Array<{ value: AspectRatio; label: string }> = [
  { value: "16:9", label: "Landscape 16:9" },
  { value: "9:16", label: "Portrait 9:16" },
  { value: "1:1", label: "Square 1:1" },
];
const LENGTHS = Array.from({ length: CINEMATIC_MAX_SEC - CINEMATIC_MIN_SEC + 1 }, (_, i) => CINEMATIC_MIN_SEC + i);
const EXAMPLES = [
  "Walks through a sunlit open-plan office toward the camera, gesturing at a whiteboard covered in sketches; handheld, documentary style.",
  "Stands on a rooftop at golden hour, city skyline behind, and turns to the camera with a smile; slow push-in, warm light.",
  "Sits at a café table by a rainy window, looks up from a laptop and nods; shallow depth of field, soft ambient sound.",
];

export default function CinematicPage() {
  return (
    <Suspense>
      <CinematicInner />
    </Suspense>
  );
}

/**
 * "Cinematic": a short shot the renderer directs from a description (HeyGen's Cinematic Avatar), featuring one to three
 * of the account's presenters, made as a library video. There is no script or voice; the description says what
 * happens, where, and how the camera moves.
 */
function CinematicInner() {
  const router = useRouter();
  const params = useSearchParams();
  const canEdit = useCanEdit();
  const { data: status } = useApi<ProviderStatus>("/api/status");
  const { data: library, error } = useApi<{ avatars: Avatar[] }>("/api/avatars");
  const [prompt, setPrompt] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [duration, setDuration] = useState<"auto" | number>("auto");
  const [enhance, setEnhance] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // What the form was filled from, and the presenters of it the library no longer has, shown above the form.
  const [notice, setNotice] = useState<string | null>(null);
  // One key per start: a retry of the same start (after a timeout, say) sends it again and gets the same video back.
  const [requestKey, setRequestKey] = useState(() => newKey());
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // "Make the shot again" from a video's page fills the form with that shot.
  const from = params.get("from");
  const { data: source } = useApi<{ video: Video }>(from ? `/api/videos/${encodeURIComponent(from)}` : null);
  const filled = useRef(false);
  useEffect(() => {
    const shot = source?.video.cinematic;
    if (!shot || filled.current) return;
    filled.current = true;
    setPrompt(shot.prompt);
    setChosen(shot.avatarIds);
    setAspect(source.video.aspect);
    if (source.video.resolution) setResolution(source.video.resolution);
    setDuration(shot.durationSec ?? "auto");
    setEnhance(!!shot.enhancePrompt);
    setNotice(`The shot of “${source.video.title}” is filled in; change it and make it again.`);
  }, [source]);

  const avatars = library?.avatars ?? [];
  const byId = useMemo(() => new Map(avatars.map((a) => [a.id, a])), [avatars]);
  const matching = useMemo(() => {
    const words = filter.trim().toLowerCase();
    const shown = (words ? avatars.filter((a) => a.name.toLowerCase().includes(words)) : avatars).slice(0, SHOWN);
    // The chosen presenters stay listed whatever the search and however long the library, so they can be unticked.
    const extra = chosen.map((id) => byId.get(id)).filter((a): a is Avatar => !!a && !shown.includes(a));
    return [...extra, ...shown];
  }, [avatars, byId, chosen, filter]);
  const full = chosen.length >= CINEMATIC_MAX_LOOKS;
  const available = status?.cinematicShots;
  // Presenters of a shot filled in that the library no longer lists (deleted since) are left out, and the page says so.
  useEffect(() => {
    if (!library) return;
    const gone = chosen.filter((id) => !byId.has(id));
    if (!gone.length) return;
    setChosen((prev) => prev.filter((id) => byId.has(id)));
    const names = source?.video.cinematic ? gone.map((id) => source.video.cinematic!.avatarNames[source.video.cinematic!.avatarIds.indexOf(id)] ?? "A presenter") : [];
    const who = names.length ? names.join(", ") : gone.length === 1 ? "One presenter" : `${gone.length} presenters`;
    setNotice((prev) => `${prev ? `${prev} ` : ""}${who} ${gone.length === 1 ? "is" : "are"} no longer in your library and ${gone.length === 1 ? "was" : "were"} left out; choose another if you like.`);
  }, [library, byId, chosen, source]);

  function changed() {
    setErr(null);
    setRequestKey(newKey());
  }

  function toggle(id: string) {
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= CINEMATIC_MAX_LOOKS ? prev : [...prev, id]));
    changed();
  }

  // An example fills the description; one already written is replaced only once confirmed.
  function pickExample(text: string) {
    if (prompt.trim() && prompt.trim() !== text && !window.confirm("Replace the description with this example?")) return;
    setPrompt(text);
    changed();
  }

  async function submit() {
    if (prompt.trim().length < 10) {
      setErr("Describe the shot in a sentence or more");
      promptRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const body = { prompt: prompt.trim(), avatarIds: chosen, aspect, resolution, duration, enhancePrompt: enhance, ...(title.trim() ? { title: title.trim() } : {}) };
      const { video } = await api<{ video: Video }>("/api/cinematic", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": requestKey } });
      router.push(`/videos/${video.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The shot could not be started");
      // A refusal, or a shot the renderer could not start (502, the video recorded as failed), makes the next try a
      // new shot; a lost answer keeps the key, so trying again returns the shot that may have started.
      if (isRefusal(e) || (e instanceof ApiError && e.status === 502)) setRequestKey(newKey());
      setBusy(false);
    }
  }

  const locked = canEdit !== true || busy;
  return (
    <>
      <SectionTitle title="Cinematic" subtitle="Describe a shot and HeyGen directs it with your presenters: the setting, the action, and the camera." />
      {canEdit === false && <ViewOnlyNotice what="make cinematic shots" />}
      <ErrorBanner message={error} />
      <ErrorBanner message={err} />
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      {notice && (
        <p className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700" role="status" data-testid="cinematic-notice">
          {notice}
        </p>
      )}
      {available === false ? (
        <Card className="p-5">
          <p className="text-sm text-slate-600">Cinematic shots need the HeyGen renderer; the current renderer has no such feature.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr]">
          <Card className="space-y-4 p-5">
            <Field label="Describe the shot" hint="What happens, where, and how the camera moves; there is no script.">
              <textarea
                ref={promptRef}
                className={`${inputClass} min-h-32`}
                value={prompt}
                maxLength={MAX_PROMPT}
                disabled={locked}
                onChange={(e) => (setPrompt(e.target.value), changed())}
                placeholder="Walks through a sunlit office toward the camera, gesturing at a whiteboard; handheld, documentary style."
                aria-describedby="prompt-count"
              />
            </Field>
            {/* Outside the label, so the count is not part of the field's name. */}
            <p id="prompt-count" className="-mt-3 text-right text-xs text-slate-500">
              {prompt.length}/{MAX_PROMPT}
            </p>
            <div>
              <p className="mb-1.5 text-xs text-slate-500">Examples</p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex, i) => (
                  <button key={ex} type="button" disabled={locked} title={ex} onClick={() => pickExample(ex)} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-50">
                    {["Office walkthrough", "Rooftop at golden hour", "Rainy café"][i]}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5 accent-brand-600" checked={enhance} disabled={locked} onChange={(e) => (setEnhance(e.target.checked), changed())} />
              <span>
                Let HeyGen enrich a short description
                <span className="block text-xs text-slate-500">It expands the description into a fuller one before directing the shot.</span>
              </span>
            </label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Shape">
                <select className={inputClass} value={aspect} disabled={locked} onChange={(e) => (setAspect(e.target.value as AspectRatio), changed())}>
                  {ASPECTS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Quality">
                <select className={inputClass} value={resolution} disabled={locked} onChange={(e) => (setResolution(e.target.value as Resolution), changed())}>
                  <option value="1080p">1080p</option>
                  <option value="720p">720p</option>
                </select>
              </Field>
              <Field label="Length">
                <select className={inputClass} value={String(duration)} disabled={locked} onChange={(e) => (setDuration(e.target.value === "auto" ? "auto" : Number(e.target.value)), changed())}>
                  <option value="auto">HeyGen decides</option>
                  {LENGTHS.map((n) => (
                    <option key={n} value={n}>
                      {n} seconds
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Title (optional)">
              <input className={inputClass} value={title} maxLength={120} disabled={locked} onChange={(e) => (setTitle(e.target.value), changed())} placeholder="The description's first words" />
            </Field>
            {canEdit === true && !chosen.length && <p className="text-xs text-slate-500" id="shot-needs">Choose at least one presenter to make the shot.</p>}
            <Button onClick={submit} loading={busy} disabled={canEdit !== true || available !== true || !chosen.length} className="w-full" aria-describedby={!chosen.length ? "shot-needs" : undefined}>
              <Film className="h-4 w-4" /> Make the shot
            </Button>
            <p className="text-xs text-slate-500">The shot is added to your library and counts as one render. It has no captions, as nothing is scripted.</p>
          </Card>

          <Card className="p-5">
            <fieldset>
              <legend className="text-sm font-semibold text-slate-900">Presenters</legend>
              <p className="mt-0.5 text-xs text-slate-500" id="presenters-hint">
                Up to {CINEMATIC_MAX_LOOKS} in the shot · {chosen.length} chosen{full ? " (the most a shot takes)" : ""}
              </p>
              <input className={`${inputClass} mt-3`} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search presenters" aria-label="Search presenters" />
              {!library ? (
                <p className="mt-3 text-xs text-slate-500">Loading your presenters…</p>
              ) : avatars.length === 0 ? (
                <p className="mt-3 text-xs text-slate-500">No presenters yet; add one on the Avatars page.</p>
              ) : (
                <ul className="mt-3 grid max-h-[28rem] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3" data-testid="cinematic-presenters">
                  {matching.map((a) => {
                    const on = chosen.includes(a.id);
                    return (
                      <li key={a.id}>
                        <label className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-2 text-xs ${on ? "border-brand-500 bg-brand-50" : "border-slate-200"} ${!on && full ? "opacity-50" : ""}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={a.imageUrl} alt="" className="aspect-square w-full rounded object-cover" />
                          <span className="flex items-center gap-1.5">
                            <input type="checkbox" className="accent-brand-600" checked={on} disabled={locked || (!on && full)} aria-describedby="presenters-hint" onChange={() => toggle(a.id)} />
                            <span className="min-w-0 truncate font-medium text-slate-800">{a.name}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {library && avatars.length > SHOWN && !filter.trim() && <p className="mt-2 text-xs text-slate-500">Showing {SHOWN} of {avatars.length}; search to find others.</p>}
            </fieldset>
          </Card>
        </div>
      )}
    </>
  );
}
