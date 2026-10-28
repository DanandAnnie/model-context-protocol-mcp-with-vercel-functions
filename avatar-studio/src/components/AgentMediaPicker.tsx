"use client";
import { useId, useRef, useState } from "react";
import { Film, ImagePlus, X } from "lucide-react";
import { Button, ErrorBanner, inputClass } from "@/components/ui";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { api } from "@/lib/client";
import { toUploadable } from "@/lib/image-upload";
import { MAX_DIRECTED_MEDIA, backdropPath, type Backdrop, type FootageJob, type ShootJob } from "@/lib/types";

/** One of the account's pictures, clips, or shoot photos chosen for HeyGen's agent, as the request names it. */
export type MediaRef = { kind: "picture"; id: string } | { kind: "clip"; id: string } | { kind: "photo"; shootId: string; photo: number };

/** What the server takes (3 MB decoded); larger pictures, and other formats, are redrawn as a JPEG first. */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_EDGE = 3840;

export const mediaKey = (m: MediaRef) => (m.kind === "photo" ? `photo:${m.shootId}:${m.photo}` : `${m.kind}:${m.id}`);

/** Something the account has that the agent can be given: how it is named, shown, and grouped. */
interface Offer {
  ref: MediaRef;
  name: string;
  thumb?: string;
  group: "Pictures" | "B-roll clips" | "Photo shoot photos";
}

/** How a chosen one is called before the lists say its name. */
const KIND_NAMES = { picture: "picture", clip: "clip", photo: "photo" } as const;

/**
 * The account's own pictures (uploaded images), finished b-roll clips, and finished photo shoot photos HeyGen's Video
 * Agent may use in a directed video, chosen from one list (then Add, so moving through the list adds nothing) or a
 * picture uploaded here; each chosen one can be removed. The lists are the page's (`backdrops`, `clips`, `shoots`), so
 * it can tell which chosen ones are gone. `onChange` takes an update of the latest choice, as an upload ends later.
 */
export function AgentMediaPicker({
  value,
  onChange,
  backdrops,
  clips,
  shoots,
  onUploaded,
  onBusy,
  disabled,
}: {
  value: MediaRef[];
  onChange: (update: (current: MediaRef[]) => MediaRef[]) => void;
  backdrops: Backdrop[] | undefined;
  clips: Pick<FootageJob, "id" | "title" | "status">[] | undefined;
  shoots: Pick<ShootJob, "id" | "title" | "status" | "photos">[] | undefined;
  onUploaded: (b: Backdrop) => void;
  /** Whether a picture is uploading, so the page does not send the brief without it. */
  onBusy?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pick, setPick] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const removeButtons = useRef<Map<string, HTMLButtonElement>>(new Map());
  const focusAfterRender = useFocusAfterRender();
  // Where the focus goes when the control it was on goes or is disabled: the list to add from, else the upload field.
  const addFrom = () => (select.current && !select.current.disabled ? select.current : fileInput.current);

  const offers: Offer[] = [
    ...(backdrops ?? []).map((b): Offer => ({ ref: { kind: "picture", id: b.id }, name: b.name, thumb: backdropPath(b.id), group: "Pictures" })),
    ...(clips ?? []).filter((c) => c.status === "completed").map((c): Offer => ({ ref: { kind: "clip", id: c.id }, name: c.title, group: "B-roll clips" })),
    ...(shoots ?? [])
      .filter((s) => s.status === "completed")
      .flatMap((s) => (s.photos ?? []).map((p, i): Offer => ({ ref: { kind: "photo", shootId: s.id, photo: i + 1 }, name: `${s.title}, photo ${i + 1}`, thumb: p.url, group: "Photo shoot photos" }))),
  ];
  const byKey = new Map(offers.map((o) => [mediaKey(o.ref), o]));
  const chosen = new Set(value.map(mediaKey));
  const full = value.length >= MAX_DIRECTED_MEDIA;
  const groups = (["Pictures", "B-roll clips", "Photo shoot photos"] as const).map((g) => [g, offers.filter((o) => o.group === g && !chosen.has(mediaKey(o.ref)))] as const).filter(([, list]) => list.length > 0);

  /** Adds one to the latest choice, unless it is there already or the choice is full; says whether it was added. */
  function add(ref: MediaRef, name: string) {
    onChange((current) => {
      if (current.some((m) => mediaKey(m) === mediaKey(ref))) return current;
      if (current.length >= MAX_DIRECTED_MEDIA) {
        setNote(`${name} was not added: ${MAX_DIRECTED_MEDIA} are chosen, the most it takes.`);
        return current;
      }
      setNote(`${name} added, ${current.length + 1} of ${MAX_DIRECTED_MEDIA}.`);
      return [...current, ref];
    });
  }

  function remove(index: number) {
    const gone = value[index];
    const after = value[index + 1] ?? value[index - 1];
    onChange((current) => current.filter((m) => mediaKey(m) !== mediaKey(gone)));
    setNote(`${byKey.get(mediaKey(gone))?.name ?? `The ${KIND_NAMES[gone.kind]}`} removed.`);
    // The next one's Remove button, else the previous one's, else where more are added.
    focusAfterRender(() => (after ? removeButtons.current.get(mediaKey(after)) : null) ?? addFrom());
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    onBusy?.(true);
    setErr(null);
    try {
      const image = await toUploadable(file, { maxBytes: MAX_UPLOAD_BYTES, maxEdge: MAX_EDGE });
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Picture";
      const { backdrop } = await api<{ backdrop: Backdrop }>("/api/backdrops", { method: "POST", body: JSON.stringify({ name, image }) });
      onUploaded(backdrop);
      add({ kind: "picture", id: backdrop.id }, backdrop.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not upload the picture");
    } finally {
      setUploading(false);
      onBusy?.(false);
      if (fileInput.current) fileInput.current.value = "";
      // The field is disabled while the picture uploads, which drops the focus; it comes back once it is enabled.
      focusAfterRender(() => fileInput.current);
    }
  }

  return (
    <fieldset className="min-w-0" disabled={disabled} aria-describedby={`${id}-hint`} data-testid="agent-media">
      <legend className="mb-1.5 block text-sm font-medium text-slate-700">Pictures and clips (optional)</legend>
      <p id={`${id}-hint`} className="mb-2 text-xs text-slate-500">
        Your own pictures, b-roll clips, and photo shoot photos for HeyGen&apos;s agent to use where they fit, up to {MAX_DIRECTED_MEDIA}. They are sent again if the video is retried.
      </p>
      {value.length > 0 && (
        <ul className="mb-2 space-y-1.5" aria-label="Chosen pictures and clips">
          {value.map((ref, i) => {
            const key = mediaKey(ref);
            const offer = byKey.get(key);
            const name = offer?.name ?? `A ${KIND_NAMES[ref.kind]}`;
            return (
              <li key={key} className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm">
                {offer?.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={offer.thumb} alt="" referrerPolicy="no-referrer" className="h-8 w-12 shrink-0 rounded bg-white object-contain" />
                ) : (
                  <Film className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                )}
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{offer ? name : `${name} (checking…)`}</span>
                <button
                  type="button"
                  ref={(el) => void (el ? removeButtons.current.set(key, el) : removeButtons.current.delete(key))}
                  onClick={() => remove(i)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-800"
                  aria-label={`Remove ${name}`}
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor={`${id}-add`} className="sr-only">
          Add a picture or clip
        </label>
        <select id={`${id}-add`} ref={select} className={`${inputClass} min-w-0 sm:flex-1`} value={pick} disabled={full || groups.length === 0} onChange={(e) => setPick(e.target.value)}>
          <option value="">{full ? `${MAX_DIRECTED_MEDIA} chosen, the most it takes` : groups.length ? "Add a picture or clip…" : backdrops ? "Nothing more to add; upload a picture" : "Loading your pictures and clips…"}</option>
          {groups.map(([group, list]) => (
            <optgroup key={group} label={group}>
              {list.map((o) => (
                <option key={mediaKey(o.ref)} value={mediaKey(o.ref)}>
                  {o.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <Button
          type="button"
          variant="secondary"
          className="shrink-0"
          disabled={!byKey.has(pick) || chosen.has(pick) || full}
          onClick={() => {
            const offer = byKey.get(pick);
            if (!offer) return;
            add(offer.ref, offer.name);
            setPick("");
            // The button is disabled once nothing is picked: the focus goes back to the list.
            focusAfterRender(addFrom);
          }}
        >
          Add
        </Button>
        <label className={`inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500 ${full || uploading || !backdrops ? "pointer-events-none opacity-60" : ""}`}>
          <ImagePlus className="h-4 w-4" aria-hidden />
          {uploading ? "Uploading…" : "Upload a picture"}
          <input ref={fileInput} type="file" accept="image/*" className="sr-only" disabled={full || uploading || !backdrops} onChange={(e) => void upload(e.target.files?.[0])} />
        </label>
      </div>
      <ErrorBanner message={err} />
      <p className="sr-only" aria-live="polite">
        {note}
      </p>
    </fieldset>
  );
}
