"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { AudioLines, Clapperboard, FileAudio, Image as ImageIcon, ImagePlus, Pencil, Trash2, Upload } from "lucide-react";
import { Card, EmptyState, ErrorBanner, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ApiError, api, formatDate, formatSeconds } from "@/lib/client";
import { clipBody } from "@/lib/clip-upload";
import { toUploadable } from "@/lib/image-upload";
import { MAX_BACKDROPS, MAX_CLIPS, type AudioClip, type Backdrop } from "@/lib/types";
/** What the pictures route takes (3 MB decoded); larger pictures, and other formats, are redrawn as a JPEG first. */
const MAX_PICTURE_BYTES = 3 * 1024 * 1024;
const MAX_PICTURE_EDGE = 3840;

/**
 * The account's assets in one place: the audio clips scenes and lip syncs speak (uploaded, recorded in the editor, or
 * kept from the voice changer) and the pictures scenes use as backgrounds. Each can be renamed or deleted here, a clip
 * can keep the words it says and start a video, and new ones can be uploaded.
 */
export default function AssetsPage() {
  const canEdit = useCanEdit();
  const clipsApi = useApi<{ clips: AudioClip[] }>("/api/clips");
  const picturesApi = useApi<{ backdrops: Backdrop[] }>("/api/backdrops");
  const clips = clipsApi.data?.clips ?? [];
  const pictures = picturesApi.data?.backdrops ?? [];
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState<"clip" | "picture" | null>(null);
  const clipInput = useRef<HTMLInputElement>(null);
  const pictureInput = useRef<HTMLInputElement>(null);
  const clipsHeading = useRef<HTMLHeadingElement>(null);
  const picturesHeading = useRef<HTMLHeadingElement>(null);

  const say = (message: string) => {
    setErr(null);
    setNote(message);
  };
  const fail = (e: unknown, fallback: string) => {
    setNote(null);
    setErr(e instanceof Error ? e.message : fallback);
  };
  const putClip = (clip: AudioClip) => clipsApi.setData((prev) => ({ clips: prev?.clips.some((c) => c.id === clip.id) ? prev.clips.map((c) => (c.id === clip.id ? clip : c)) : [clip, ...(prev?.clips ?? [])] }));
  const dropClip = (id: string) => clipsApi.setData((prev) => (prev ? { clips: prev.clips.filter((c) => c.id !== id) } : prev));
  const putPicture = (b: Backdrop) => picturesApi.setData((prev) => ({ backdrops: prev?.backdrops.some((x) => x.id === b.id) ? prev.backdrops.map((x) => (x.id === b.id ? b : x)) : [b, ...(prev?.backdrops ?? [])] }));
  const dropPicture = (id: string) => picturesApi.setData((prev) => (prev ? { backdrops: prev.backdrops.filter((x) => x.id !== id) } : prev));

  async function uploadClip(file: File) {
    setUploading("clip");
    try {
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Uploaded audio";
      const { clip } = await api<{ clip: AudioClip }>("/api/clips", { method: "POST", body: JSON.stringify(await clipBody(file, name)) });
      putClip(clip);
      say(`Uploaded the audio clip “${clip.name}”.`);
    } catch (e) {
      fail(e, "The audio could not be uploaded");
    } finally {
      setUploading(null);
    }
  }

  async function uploadPicture(file: File) {
    setUploading("picture");
    try {
      const image = await toUploadable(file, { maxBytes: MAX_PICTURE_BYTES, maxEdge: MAX_PICTURE_EDGE });
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Picture";
      const { backdrop } = await api<{ backdrop: Backdrop }>("/api/backdrops", { method: "POST", body: JSON.stringify({ name, image }) });
      putPicture(backdrop);
      say(`Uploaded the picture “${backdrop.name}”.`);
    } catch (e) {
      fail(e, "The picture could not be uploaded");
    } finally {
      setUploading(null);
    }
  }

  async function renameClip(clip: AudioClip) {
    const answer = window.prompt("Clip name", clip.name);
    const name = answer?.trim();
    if (!name || name === clip.name) return;
    try {
      const { clip: saved } = await api<{ clip: AudioClip }>(`/api/clips/${clip.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      putClip(saved);
      say(`Renamed the clip to “${saved.name}”.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        dropClip(clip.id);
        say(`The clip “${clip.name}” was already deleted.`);
      } else fail(e, "The clip could not be renamed");
    }
  }

  async function removeClip(clip: AudioClip) {
    if (!window.confirm(`Delete the audio clip “${clip.name}”? Videos, lip syncs, voices, and recordings already made from it are kept, but a scene or draft still using it will need another clip.`)) return;
    try {
      await api(`/api/clips/${clip.id}`, { method: "DELETE" });
      say(`Deleted the clip “${clip.name}”.`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) return fail(e, "The clip could not be deleted");
      say(`The clip “${clip.name}” was already deleted.`);
    }
    dropClip(clip.id);
    // The card and its buttons are gone; the focus goes to the section's heading.
    clipsHeading.current?.focus();
  }

  async function renamePicture(b: Backdrop) {
    const answer = window.prompt("Picture name", b.name);
    const name = answer?.trim();
    if (!name || name === b.name) return;
    try {
      const { backdrop } = await api<{ backdrop: Backdrop }>(`/api/backdrops/${b.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      putPicture(backdrop);
      say(`Renamed the picture to “${backdrop.name}”.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        dropPicture(b.id);
        say(`The picture “${b.name}” was already deleted.`);
      } else fail(e, "The picture could not be renamed");
    }
  }

  async function removePicture(b: Backdrop) {
    if (!window.confirm(`Delete the picture “${b.name}”? Scenes, templates, and the brand kit using it go back to a plain background; videos already rendered keep it.`)) return;
    try {
      await api(`/api/backdrops/${b.id}`, { method: "DELETE" });
      say(`Deleted the picture “${b.name}”.`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) return fail(e, "The picture could not be deleted");
      say(`The picture “${b.name}” was already deleted.`);
    }
    dropPicture(b.id);
    picturesHeading.current?.focus();
  }

  const uploadButton = "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400";

  return (
    <>
      <SectionTitle title="Assets" subtitle="Your audio clips and pictures, for scenes, lip syncs, and backgrounds." />
      {canEdit === false && <ViewOnlyNotice what="upload, rename, or delete assets" />}
      <ErrorBanner message={err} />
      {/* Always in the tree, so its first message is announced; the visible copy sits beside it. */}
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      {note && (
        <p aria-hidden className="mb-3 text-sm text-slate-600" data-testid="assets-note">
          {note}
        </p>
      )}

      <section className="mb-8" aria-labelledby="clips-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="clips-heading" ref={clipsHeading} tabIndex={-1} className="rounded text-sm font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            Audio clips{clipsApi.data ? ` (${clips.length} of ${MAX_CLIPS})` : ""}
          </h2>
          {canEdit === true && (
            <>
              {clips.length >= MAX_CLIPS && <span className="text-xs text-slate-500">Delete a clip to upload another.</span>}
              <button type="button" className={uploadButton} onClick={() => clipInput.current?.click()} disabled={uploading !== null || clips.length >= MAX_CLIPS}>
                <Upload className="h-3.5 w-3.5" aria-hidden /> {uploading === "clip" ? "Uploading…" : "Upload audio"}
              </button>
              <input
                ref={clipInput}
                type="file"
                accept="audio/*"
                className="hidden"
                aria-label="Upload an audio clip"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadClip(file);
                }}
              />
            </>
          )}
        </div>
        {clipsApi.error ? (
          <ErrorBanner message={`Your audio clips could not be loaded: ${clipsApi.error}`} />
        ) : !clipsApi.data ? (
          <Skeleton className="h-24" />
        ) : clips.length === 0 ? (
          <EmptyState icon={<FileAudio className="h-8 w-8" />} title="No audio clips yet" body="Upload one here, record one in the editor's Audio tab, or keep a recording made in the voice changer." />
        ) : (
          <div className="space-y-3" data-testid="asset-clips">
            {clips.map((clip) => (
              <ClipCard key={clip.id} clip={clip} canEdit={canEdit === true} roleKnown={canEdit !== null} onRename={() => void renameClip(clip)} onDelete={() => void removeClip(clip)} onSaved={putClip} onGone={() => dropClip(clip.id)} onNote={say} onError={fail} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="pictures-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="pictures-heading" ref={picturesHeading} tabIndex={-1} className="rounded text-sm font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            Pictures{picturesApi.data ? ` (${pictures.length} of ${MAX_BACKDROPS})` : ""}
          </h2>
          {canEdit === true && (
            <>
              {pictures.length >= MAX_BACKDROPS && <span className="text-xs text-slate-500">Delete a picture to upload another.</span>}
              <button type="button" className={uploadButton} onClick={() => pictureInput.current?.click()} disabled={uploading !== null || pictures.length >= MAX_BACKDROPS}>
                <ImagePlus className="h-3.5 w-3.5" aria-hidden /> {uploading === "picture" ? "Uploading…" : "Upload picture"}
              </button>
              <input
                ref={pictureInput}
                type="file"
                accept="image/*"
                className="hidden"
                aria-label="Upload a picture"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadPicture(file);
                }}
              />
            </>
          )}
        </div>
        {picturesApi.error ? (
          <ErrorBanner message={`Your pictures could not be loaded: ${picturesApi.error}`} />
        ) : !picturesApi.data ? (
          <Skeleton className="h-32" />
        ) : pictures.length === 0 ? (
          <EmptyState icon={<ImageIcon className="h-8 w-8" />} title="No pictures yet" body="Upload one here or in the editor's Background tab; a scene can show it behind or instead of the presenter." />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="asset-pictures">
            {pictures.map((b) => (
              <li key={b.id}>
                <Card className="overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element -- the owner's own upload, served by the API */}
                  <img src={`/api/backdrops/${b.id}`} alt={b.name} loading="lazy" className="aspect-video w-full bg-slate-100 object-cover" />
                  <div className="flex items-center gap-1 p-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-slate-900" title={b.name}>
                        {b.name}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {b.mimeType === "image/png" ? "PNG" : "JPEG"} · {formatDate(b.createdAt)}
                      </div>
                    </div>
                    {canEdit === true && (
                      <>
                        <button type="button" onClick={() => void renamePicture(b)} aria-label={`Rename ${b.name}`} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-700">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => void removePicture(b)} aria-label={`Delete ${b.name}`} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** One audio clip: play it, see and keep the words it says, start a video with it, rename or delete it. */
function ClipCard(props: {
  clip: AudioClip;
  canEdit: boolean;
  /** False while the person's role is still being looked up: nothing is offered or ruled out yet. */
  roleKnown: boolean;
  onRename: () => void;
  onDelete: () => void;
  onSaved: (clip: AudioClip) => void;
  onGone: () => void;
  onNote: (message: string) => void;
  onError: (e: unknown, fallback: string) => void;
}) {
  const { clip, canEdit } = props;
  const [words, setWords] = useState(clip.transcript ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The words shown follow the clip when it changes elsewhere (kept from the editor, a rename), unless being edited here.
  const [seen, setSeen] = useState(clip.transcript ?? "");
  if ((clip.transcript ?? "") !== seen) {
    setSeen(clip.transcript ?? "");
    if (words.trim() === seen.trim()) setWords(clip.transcript ?? "");
  }
  const changed = words.trim() !== (clip.transcript ?? "").trim();

  async function saveWords() {
    if (saving || !changed) return;
    setSaving(true);
    try {
      const { clip: saved } = await api<{ clip: AudioClip }>(`/api/clips/${clip.id}`, { method: "PATCH", body: JSON.stringify({ transcript: words.trim() || null }) });
      props.onSaved(saved);
      setSaved(true);
      props.onNote(saved.transcript ? `Kept the words with “${saved.name}”: a scene that uses it starts with them.` : `“${saved.name}” no longer has words kept with it.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) props.onGone();
      props.onError(e, "The words could not be kept with the clip");
    } finally {
      setSaving(false);
    }
  }

  const wordsId = `clip-words-${clip.id}`;
  return (
    <Card className="p-4" data-testid="asset-clip" data-clip={clip.id}>
      <div className="flex items-start gap-3">
        <AudioLines className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-900" data-testid="asset-clip-name">
            {clip.name}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {formatSeconds(Math.max(1, Math.round(clip.durationSec)))} · {clip.mimeType === "audio/mpeg" ? "MP3" : "WAV"} · {formatDate(clip.createdAt)}
          </div>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-1">
            <Link href={`/create?clip=${clip.id}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50" aria-label={`Make a video: ${clip.name}`}>
              <Clapperboard className="h-3.5 w-3.5" aria-hidden /> Make a video
            </Link>
            <button type="button" onClick={props.onRename} aria-label={`Rename ${clip.name}`} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-brand-700">
              <Pencil className="h-4 w-4" />
            </button>
            <button type="button" onClick={props.onDelete} aria-label={`Delete ${clip.name}`} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-700">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <audio controls preload="none" src={`/api/clips/${clip.id}`} className="mt-3 h-8 w-full" aria-label={`Play ${clip.name}`} />
      <label htmlFor={wordsId} className="mt-3 block text-xs font-medium text-slate-700">
        What it says
      </label>
      <textarea
        id={wordsId}
        value={words}
        onChange={(e) => setWords(e.target.value)}
        readOnly={!canEdit}
        maxLength={5000}
        rows={2}
        placeholder={canEdit ? "Type the words, for a scene's script and captions" : props.roleKnown ? "No words kept with this clip" : ""}
        className={`${inputClass} mt-1 text-sm`}
      />
      {canEdit && (changed || saved) && (
        // Stays once used, so the focus is not lost when the words are saved; it says so until they change again.
        <button type="button" onClick={() => void saveWords()} aria-disabled={saving || !changed} className="mt-1 text-xs font-medium text-brand-700 hover:underline aria-disabled:cursor-default aria-disabled:text-slate-500 aria-disabled:no-underline">
          {saving ? "Keeping the words…" : !changed ? (clip.transcript ? "Words kept with the clip" : "No words kept") : words.trim() ? "Keep these words with the clip" : "Forget the words"}
        </button>
      )}
    </Card>
  );
}
