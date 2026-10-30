"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Camera, Clapperboard, Download, ImagePlus, Pencil, Trash2, UserRound, X } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, SectionTitle, StatusBadge, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { ApiError, api, formatDate, isRefusal } from "@/lib/client";
import { toUploadable } from "@/lib/image-upload";
import { MAX_SHOOT_IDENTITY, MAX_SHOOT_PHOTOS, SHOOT_ASPECTS, type ProviderStatus, type ShootAspect, type ShootJob } from "@/lib/types";

/** A shoot as the server lists it: never the renderer, its job id, or the pictures' digest. */
type Shoot = Omit<ShootJob, "ownerId" | "provider" | "providerJobId" | "pictureDigest" | "askedTitle">;
type Picture = { name: string; url: string };
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
/** Photos' links are renewed by the server once this old; a page left open asks again when it is looked at. */
const RELINK_MS = 30 * 60 * 1000;
/** Each picture of a start: six of them still fit in one request. */
const MAX_PICTURE_BYTES = 500 * 1024;
/** The time of day, as an untitled shoot is told apart by. */
const clock = () => new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
/** A scene picture's file name as a title: without its extension, cut to fit. */
const sceneName = (file: string) => (file.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim() || "scene").slice(0, 80);
const SHAPES: Record<ShootAspect, string> = {
  "1:1": "Square 1:1",
  "2:3": "Portrait 2:3",
  "3:2": "Landscape 3:2",
  "3:4": "Portrait 3:4",
  "4:3": "Landscape 4:3",
  "4:5": "Portrait 4:5",
  "5:4": "Landscape 5:4",
  "9:16": "Tall 9:16",
  "16:9": "Wide 16:9",
};

/**
 * "Photo shoot": photos of one person in a scene they were never photographed in (HeyGen Image). Their face comes from
 * a few photos of them; the pose, clothing, light, and setting from one scene picture. Each shoot is listed to view and
 * download its photos.
 */
export default function PhotoShootPage() {
  const canEdit = useCanEdit();
  const { data, error, setData, refetch } = useApi<{ shoots: Shoot[]; available: boolean }>("/api/shoots");
  // "Bring to life" is offered only where clips can be made.
  const { data: status } = useApi<ProviderStatus>("/api/status");
  // While a shoot is being made the list is asked again, only while the tab is visible.
  const running = (data?.shoots ?? []).some((s) => s.status === "processing");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 5_000);
    return () => clearInterval(timer);
  }, [running, refetch]);
  const [identity, setIdentity] = useState<Picture[]>([]);
  const [scene, setScene] = useState<Picture | null>(null);
  // "scene" follows the scene picture's shape.
  const [aspect, setAspect] = useState<ShootAspect | "scene">("scene");
  const [count, setCount] = useState(1);
  const [consent, setConsent] = useState(false);
  const [title, setTitle] = useState("");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A delete that fails is reported by the list, where its button was.
  const [listErr, setListErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // One key per start: a retry of the same start (after a timeout, say) sends it again and gets the same shoot back.
  const [requestKey, setRequestKey] = useState(() => newKey());
  const personRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const changed = () => {
    setErr(null);
    setRequestKey(newKey());
  };
  // A message the same as the one showing is cleared first, so it is announced again rather than ignored.
  const say = (set: (m: string | null) => void, message: string) => {
    set(null);
    setTimeout(() => set(message), 30);
  };
  // A shoot that is made or fails while the page is open is announced.
  const seen = useRef<Map<string, Shoot["status"]>>(new Map());
  useEffect(() => {
    if (!data) return;
    const parts: string[] = [];
    for (const s of data.shoots) {
      const before = seen.current.get(s.id);
      if (before === "processing" && s.status !== "processing") parts.push(s.status === "completed" ? `${s.title} is ready.` : `${s.title} could not be made: ${s.error ?? "the renderer failed"}.`);
      seen.current.set(s.id, s.status);
    }
    // Through say(), so a second shoot of the same name being ready is announced too.
    if (parts.length) say(setNote, parts.join(" "));
    // say() is a fresh function each render; what is announced depends only on the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  // A page left open past the links' lifetime asks again when it is looked at, so the photos still show.
  const loadedAt = useRef(Date.now());
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > RELINK_MS) {
        loadedAt.current = Date.now();
        void refetch();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  const items = data?.shoots ?? [];
  const canStart = canEdit !== false && data?.available !== false;
  const startNote = !identity.length
    ? "Add a photo of the person first."
    : !scene
      ? "Add the scene picture."
      : !consent
        ? "Confirm that you have the right to use this person's face."
        : null;

  async function choose(input: HTMLInputElement, into: "person" | "scene") {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    // The control stays enabled while busy (disabling it would drop its focus); a pick made then is not taken, and the
    // page says so.
    if (busy || reading) {
      setErr(reading ? "Still reading the picture added before; add this one again in a moment." : "Wait for the shoot to be started, then add the picture again.");
      return;
    }
    setReading(true);
    changed();
    try {
      const picture = { name: file.name, url: await toUploadable(file, { maxBytes: MAX_PICTURE_BYTES, maxEdge: 1536 }) };
      if (into === "scene") {
        setScene(picture);
        say(setNote, `Scene picture added (${file.name}).`);
        // The add control gives way to the picture; the focus goes to its remove button.
        focusAfterRender(() => document.getElementById("shoot-scene-remove"));
      } else {
        setIdentity((prev) => (prev.length < MAX_SHOOT_IDENTITY ? [...prev, picture] : prev));
        say(setNote, `Photo ${identity.length + 1} of the person added (${file.name}).`);
        // When the last one is added, the add control goes, so the focus moves to that photo's remove button.
        if (identity.length + 1 >= MAX_SHOOT_IDENTITY) focusAfterRender(() => document.getElementById(`shoot-person-remove-${MAX_SHOOT_IDENTITY - 1}`));
      }
    } catch (e) {
      say(setErr, `${file.name}: ${e instanceof Error ? e.message : "that picture could not be read"}`);
    } finally {
      setReading(false);
    }
  }

  function removePerson(i: number) {
    const gone = identity[i];
    setIdentity((prev) => prev.filter((_, j) => j !== i));
    changed();
    say(setNote, `Photo ${i + 1} of the person removed${gone ? ` (${gone.name})` : ""}.`);
    // The add control is there again with a place free.
    focusAfterRender(() => personRef.current);
  }

  function removeScene() {
    setScene(null);
    changed();
    say(setNote, "Scene picture removed.");
    focusAfterRender(() => sceneRef.current);
  }

  // An untitled shoot is named after its scene and the time, kept for this start's key so a retry sends the same body.
  const named = useRef<{ key: string; title: string } | null>(null);
  function defaultTitle(): string {
    if (named.current?.key !== requestKey) named.current = { key: requestKey, title: `Photo shoot: ${sceneName(scene!.name)}, ${clock()}` };
    return named.current.title;
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const body = {
        identity: identity.map((p) => p.url),
        reference: scene!.url,
        ...(aspect === "scene" ? {} : { aspect }),
        count,
        consent: true,
        // Without a title, the scene's file name tells shoots apart (the same in a retry, which sends the same body).
        title: title.trim() || defaultTitle(),
      };
      const { shoot } = await api<{ shoot: Shoot }>("/api/shoots", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": requestKey } });
      setData((prev) => ({ available: prev?.available ?? true, shoots: [shoot, ...(prev?.shoots ?? []).filter((s) => s.id !== shoot.id)] }));
      // A check that left before this shoot was started would answer without it; asking again retires it.
      void refetch();
      setRequestKey(newKey());
      // The person stays for another scene; the scene, its title, and the consent go with this shoot.
      setScene(null);
      setTitle("");
      setConsent(false);
      setNote(`Making ${shoot.title}; the photos appear here when they are ready.`);
      focusAfterRender(() => listRef.current?.querySelector<HTMLElement>(`[data-shoot="${shoot.id}"]`) ?? sceneRef.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The photo shoot could not be started");
      // A refusal is an answer: trying again is a new start. A lost answer keeps its key, so a retry returns the same shoot.
      if (isRefusal(e)) setRequestKey(newKey());
    } finally {
      setBusy(false);
    }
  }

  async function rename(s: Shoot) {
    const answer = window.prompt("Photo shoot name", s.title);
    const name = answer?.trim();
    if (!name || name === s.title) return;
    setListErr(null);
    setNote(null);
    try {
      const { shoot } = await api<{ shoot: Shoot }>(`/api/shoots/${s.id}`, { method: "PATCH", body: JSON.stringify({ title: name }) });
      setData((prev) => (prev ? { ...prev, shoots: prev.shoots.map((x) => (x.id === shoot.id ? shoot : x)) } : prev));
      setNote(`Renamed the photo shoot to “${shoot.title}”.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setData((prev) => (prev ? { ...prev, shoots: prev.shoots.filter((x) => x.id !== s.id) } : prev));
        setNote(`The photo shoot “${s.title}” is no longer available.`);
        focusAfterRender(() => headingRef.current);
      } else setListErr(e instanceof Error ? e.message : "The photo shoot could not be renamed");
    }
  }

  async function remove(s: Shoot) {
    if (!window.confirm(`Delete “${s.title}”? Its photos go too; download any you want to keep first.`)) return;
    setListErr(null);
    setNote(null);
    const next = items[items.indexOf(s) + 1] ?? items[items.indexOf(s) - 1];
    try {
      seen.current.delete(s.id);
      await api(`/api/shoots/${s.id}`, { method: "DELETE" });
      setData((prev) => (prev ? { ...prev, shoots: prev.shoots.filter((x) => x.id !== s.id) } : prev));
      void refetch();
      setNote(`Deleted ${s.title}.`);
      // Focus moves to the next shoot, or to the list's heading, rather than being lost with the button.
      focusAfterRender(() => (next ? listRef.current?.querySelector<HTMLElement>(`[data-shoot="${next.id}"]`) : headingRef.current));
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "The photo shoot could not be deleted");
    }
  }

  const addClass = `inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-brand-500 ${busy || reading || canEdit === false ? "opacity-60" : ""}`;
  const removeClass = "inline-flex min-h-6 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50";

  return (
    <>
      <SectionTitle title="Photo shoot" subtitle="Put a person in any scene: their face from a few photos of them, the pose, clothes, and light from a scene picture." />
      {canEdit === false && <ViewOnlyNotice what="make photo shoots" />}
      <ErrorBanner message={error} />
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      {/* Each column no wider than its share, so a long title or file name is cut short rather than widening the page. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card className="p-5">
          {data?.available === false ? (
            <p className="text-sm text-slate-600">Photo shoots need the HeyGen renderer; the current renderer has no such feature.</p>
          ) : (
            <div className="space-y-5">
              <fieldset disabled={canEdit === false} className="min-w-0">
                <legend className="mb-1 text-sm font-medium text-slate-700">The person</legend>
                <p id="shoot-person-hint" className="mb-2 text-xs text-slate-500">
                  1 to {MAX_SHOOT_IDENTITY} clear photos of one person&apos;s face; a few views help. Their face, hair, and expression come from these (photos looking at the camera look at it in the results). Large pictures are shrunk.
                </p>
                {identity.length > 0 && (
                  <ol className="mb-2 space-y-2" aria-label="Photos of the person">
                    {identity.map((p, i) => (
                      <li key={`${i}-${p.name}`} className="flex flex-wrap items-center gap-3" data-testid="shoot-person">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.url} alt={`Photo ${i + 1} of the person: ${p.name}`} className="h-14 w-14 rounded-md bg-slate-100 object-cover" />
                        <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{p.name}</span>
                        <button type="button" id={`shoot-person-remove-${i}`} onClick={() => removePerson(i)} disabled={busy || reading} className={removeClass} aria-label={`Remove photo ${i + 1} of the person, ${p.name}`}>
                          <X className="h-3.5 w-3.5" aria-hidden /> Remove
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                {identity.length < MAX_SHOOT_IDENTITY && (
                  <label className={addClass}>
                    <input ref={personRef} type="file" accept="image/*" className="sr-only" aria-describedby="shoot-person-hint shoot-person-count" aria-disabled={busy || reading || canEdit === false} disabled={canEdit === false} onChange={(e) => choose(e.currentTarget, "person")} />
                    <ImagePlus className="h-4 w-4" aria-hidden /> {reading ? "Reading…" : identity.length ? "Add another photo of the person" : "Add a photo of the person"}
                  </label>
                )}
                <p id="shoot-person-count" className="mt-1 text-xs text-slate-500">
                  {identity.length} of {MAX_SHOOT_IDENTITY} photos
                </p>
              </fieldset>

              <fieldset disabled={canEdit === false} className="min-w-0">
                <legend className="mb-1 text-sm font-medium text-slate-700">The scene</legend>
                <p id="shoot-scene-hint" className="mb-2 text-xs text-slate-500">
                  A picture of exactly one person, their whole head in frame. The photos take its pose, clothing, light, and setting; that person never appears.
                </p>
                {scene ? (
                  <div className="flex flex-wrap items-center gap-3" data-testid="shoot-scene">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={scene.url} alt={`The scene: ${scene.name}`} className="h-20 w-16 rounded-md bg-slate-100 object-cover" />
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{scene.name}</span>
                    <button type="button" id="shoot-scene-remove" onClick={removeScene} disabled={busy || reading} className={removeClass} aria-label={`Remove the scene picture, ${scene.name}`}>
                      <X className="h-3.5 w-3.5" aria-hidden /> Remove
                    </button>
                  </div>
                ) : (
                  <label className={addClass}>
                    <input ref={sceneRef} type="file" accept="image/*" className="sr-only" aria-describedby="shoot-scene-hint" aria-disabled={busy || reading || canEdit === false} disabled={canEdit === false} onChange={(e) => choose(e.currentTarget, "scene")} />
                    <ImagePlus className="h-4 w-4" aria-hidden /> {reading ? "Reading…" : "Add the scene picture"}
                  </label>
                )}
              </fieldset>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="shoot-shape" className="mb-1.5 block text-sm font-medium text-slate-700">
                    Shape
                  </label>
                  <select id="shoot-shape" className={inputClass} value={aspect} disabled={busy || canEdit === false} onChange={(e) => (setAspect(e.target.value as ShootAspect | "scene"), changed())}>
                    <option value="scene">Like the scene</option>
                    {SHOOT_ASPECTS.map((a) => (
                      <option key={a} value={a}>
                        {SHAPES[a]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="shoot-count" className="mb-1.5 block text-sm font-medium text-slate-700">
                    Photos
                  </label>
                  <select id="shoot-count" className={inputClass} value={count} disabled={busy || canEdit === false} onChange={(e) => (setCount(Number(e.target.value)), changed())}>
                    {Array.from({ length: MAX_SHOOT_PHOTOS }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n === 1 ? "1 photo" : `${n} photos`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="shoot-title" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Title (optional)
                </label>
                <input id="shoot-title" className={inputClass} value={title} maxLength={120} disabled={busy || canEdit === false} onChange={(e) => (setTitle(e.target.value), changed())} placeholder={scene ? `Photo shoot: ${sceneName(scene.name)}, and the time` : "Photo shoot: the scene's file name and the time"} />
              </div>

              <div>
                <label className="flex min-h-6 items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="mt-0.5 accent-brand-600" checked={consent} disabled={busy || canEdit === false} aria-describedby="shoot-consent-hint" onChange={(e) => (setConsent(e.target.checked), changed())} />
                  I have the right to use this person&apos;s face
                </label>
                <p id="shoot-consent-hint" className="mt-1 text-xs text-slate-500">
                  It is you, or the person agreed to be photographed this way. A public photo is not permission to use someone&apos;s face.
                </p>
              </div>

              {/* A refusal is shown by the button that was pressed, so it is seen on a phone too. */}
              <ErrorBanner message={err} />
              <Button onClick={submit} loading={busy} disabled={!!startNote || reading || !canStart} className="w-full" aria-describedby={startNote ? "shoot-start-note" : undefined}>
                <Camera className="h-4 w-4" /> Make the photos
              </Button>
              {startNote && (
                <p id="shoot-start-note" className="text-xs text-slate-500">
                  {startNote}
                </p>
              )}
            </div>
          )}
        </Card>

        <div ref={listRef} className="min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="mb-3 text-sm font-semibold text-slate-900 outline-none">
            Your photo shoots
          </h2>
          <ErrorBanner message={listErr} />
          {!data ? null : items.length === 0 ? (
            <EmptyState icon={<Camera className="h-8 w-8" />} title="No photo shoots yet" body="Add photos of a person and a scene on the left to make one." />
          ) : (
            <div className="space-y-3">
              {items.map((s) => (
                <Card key={s.id} className="p-4 outline-none focus:ring-2 focus:ring-brand-500" data-testid="shoot" data-shoot={s.id} tabIndex={-1}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900">{s.title}</div>
                      <div className="mt-0.5 text-xs text-slate-500" data-testid="shoot-meta">
                        {s.count === 1 ? "1 photo" : `${s.count} photos`} · {s.aspect ?? "like the scene"} · from {s.identityCount === 1 ? "1 photo" : `${s.identityCount} photos`} of the person · {formatDate(s.createdAt)}
                      </div>
                      {s.error && <div className="mt-1 text-xs text-rose-600">{s.error}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={s.status} />
                      {canEdit === true && (
                        <>
                          <button type="button" onClick={() => void rename(s)} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-brand-700" aria-label={`Rename ${s.title}`} title="Rename">
                            <Pencil className="h-4 w-4" aria-hidden />
                          </button>
                          <button type="button" onClick={() => remove(s)} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-rose-600" aria-label={`Delete ${s.title}`} title="Delete">
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {s.status === "completed" && s.photos?.length ? (
                    <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label={`Photos of ${s.title}`}>
                      {s.photos.map((p, i) => (
                        <li key={`${i}-${p.url}`} className="space-y-1" data-testid="shoot-photo">
                          {/* Shown at its size in the list, not as HeyGen's full 4K file; a click opens that. */}
                          {p.url.startsWith("https://") ? (
                            <a href={p.url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-lg bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500">
                              <Image src={p.url} alt={`Photo ${i + 1} of ${s.title}${p.width && p.height ? `, ${p.width} × ${p.height}` : ""}`} width={p.width ?? 600} height={p.height ?? 800} sizes="(min-width: 640px) 220px, 45vw" className="h-auto w-full" />
                            </a>
                          ) : (
                            // The demo's drawn stand-ins are data URLs, which a browser will not open in a new tab.
                            <Image src={p.url} alt={`Photo ${i + 1} of ${s.title}${p.width && p.height ? `, ${p.width} × ${p.height}` : ""}`} width={p.width ?? 600} height={p.height ?? 800} unoptimized className="h-auto w-full rounded-lg bg-slate-100" />
                          )}
                          <div className="flex flex-wrap gap-x-3">
                          <a href={p.url} download target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center gap-1 py-1 text-xs font-medium text-brand-700 hover:underline" aria-label={`Download photo ${i + 1} of ${s.title}`}>
                            <Download className="h-3 w-3" aria-hidden /> Download
                          </a>
                          {canEdit === true && status?.generatedFootage === true && (
                            <Link href={`/footage?shoot=${s.id}&photo=${i + 1}`} className="inline-flex min-h-6 items-center gap-1 py-1 text-xs font-medium text-brand-700 hover:underline" aria-label={`Bring to life: photo ${i + 1} of ${s.title}`}>
                              <Clapperboard className="h-3 w-3" aria-hidden /> Bring to life
                            </Link>
                          )}
                          {canEdit === true && (
                            <Link href={`/avatars?shoot=${s.id}&photo=${i + 1}`} className="inline-flex min-h-6 items-center gap-1 py-1 text-xs font-medium text-brand-700 hover:underline" aria-label={`Make a presenter: photo ${i + 1} of ${s.title}`}>
                              <UserRound className="h-3 w-3" aria-hidden /> Make a presenter
                            </Link>
                          )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
