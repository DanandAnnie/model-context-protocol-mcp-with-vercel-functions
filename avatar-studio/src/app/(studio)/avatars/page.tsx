"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Camera, Pencil, Trash2, Upload, Users, Video as VideoIcon } from "lucide-react";
import { AvatarTile } from "@/components/AvatarPicker";
import { FavoriteStar } from "@/components/FavoriteStar";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { favoritesFirst, useFavorites } from "@/hooks/useFavorites";
import { api } from "@/lib/client";
import type { Avatar, Voice } from "@/lib/types";

export default function AvatarsPage() {
  return (
    <Suspense>
      <AvatarsInner />
    </Suspense>
  );
}

function AvatarsInner() {
  const params = useSearchParams();
  const { data, loading, error, refetch } = useApi<{ avatars: Avatar[] }>("/api/avatars");
  const { data: voiceData } = useApi<{ voices: Voice[] }>("/api/voices");
  const voices = voiceData?.voices ?? [];
  const [open, setOpen] = useState(params.get("new") === "1");
  const [filter, setFilter] = useState<"all" | "custom" | "library">("all");
  const [gender, setGender] = useState<"all" | NonNullable<Avatar["gender"]>>("all");
  const [q, setQ] = useState("");
  const [actionErr, setActionErr] = useState<string | null>(null);
  const genders = (["female", "male", "neutral"] as const).filter((g) => (data?.avatars ?? []).some((a) => a.gender === g));
  const needle = q.trim().toLowerCase();
  const favorites = useFavorites();
  const avatars = favoritesFirst(
    (data?.avatars ?? []).filter((a) => {
      if (filter === "custom" ? a.source !== "custom" : filter === "library" && a.source === "custom") return false;
      if (gender !== "all" && a.gender !== gender) return false;
      return !needle || [a.name, ...(a.tags ?? [])].join(" ").toLowerCase().includes(needle);
    }),
    favorites.avatarIds,
  );

  async function rename(a: Avatar) {
    const answer = window.prompt("Avatar name", a.name);
    if (answer === null) return;
    const name = answer.trim();
    if (!name || name === a.name) return;
    try {
      await api(`/api/avatars/${a.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setActionErr(null);
      refetch();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Could not rename the avatar");
    }
  }

  async function setDefaultVoice(a: Avatar, voiceId: string) {
    try {
      await api(`/api/avatars/${a.id}`, { method: "PATCH", body: JSON.stringify({ defaultVoiceId: voiceId || null }) });
      setActionErr(null);
      refetch();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Could not set the default voice");
    }
  }

  async function remove(a: Avatar) {
    if (!confirm(`Delete avatar "${a.name}"?`)) return;
    try {
      await api(`/api/avatars/${a.id}`, { method: "DELETE" });
      setActionErr(null);
      refetch();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Could not delete the avatar");
    }
  }

  return (
    <>
      <SectionTitle
        title="Avatars"
        subtitle="Library presenters plus any photo avatars you create."
        action={
          <Button onClick={() => setOpen(true)}>
            <Camera className="h-4 w-4" /> New photo avatar
          </Button>
        }
      />
      <ErrorBanner message={error ?? actionErr} />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {(["all", "library", "custom"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${filter === f ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"}`}
          >
            {f === "all" ? "All" : f === "library" ? "Library" : "My avatars"}
          </button>
        ))}
        {genders.length > 1 && (
          <select aria-label="Gender" value={gender} onChange={(e) => setGender(e.target.value as typeof gender)} className={`${inputClass} w-auto py-1 text-xs`}>
            <option value="all">Any gender</option>
            {genders.map((g) => (
              <option key={g} value={g}>{g[0].toUpperCase() + g.slice(1)}</option>
            ))}
          </select>
        )}
        <input className={`${inputClass} w-auto max-w-[220px] py-1 text-xs`} placeholder="Search by name or style" value={q} onChange={(e) => setQ(e.target.value)} />
        {data && <span className="text-xs text-slate-500">{avatars.length} of {data.avatars.length}</span>}
      </div>

      {open && <CreateAvatarPanel voices={voices} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); refetch(); }} />}

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/5]" />
          ))}
        </div>
      ) : avatars.length === 0 ? (
        <EmptyState icon={<Users className="h-8 w-8" />} title="No avatars here" body="Create a photo avatar from a portrait to get started." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" data-testid="avatar-library">
          {avatars.map((a) => (
            <div key={a.id} className="relative">
              <AvatarTile avatar={a} />
              <FavoriteStar name={a.name} on={favorites.avatarIds.has(a.id)} onToggle={() => favorites.toggle("avatar", a.id)} className="absolute left-2 top-2" />
              {a.source === "custom" && (
                <span className="absolute right-2 top-2 flex gap-1">
                  <button
                    onClick={() => rename(a)}
                    aria-label={`Rename ${a.name}`}
                    title="Rename this avatar; videos already rendered keep the old name"
                    className="rounded-full bg-white/90 p-1.5 text-slate-600 shadow hover:text-brand-700"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => remove(a)}
                    aria-label="Delete avatar"
                    className="rounded-full bg-white/90 p-1.5 text-slate-600 shadow hover:text-rose-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
              {a.source === "custom" && voices.length > 0 && (
                <select
                  aria-label={`Default voice for ${a.name}`}
                  title="The editor switches to this voice when the avatar is picked"
                  className={`${inputClass} mt-1.5 py-1 text-xs`}
                  value={a.defaultVoiceId && voices.some((v) => v.id === a.defaultVoiceId) ? a.defaultVoiceId : ""}
                  onChange={(e) => setDefaultVoice(a, e.target.value)}
                >
                  <option value="">No default voice</option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CreateAvatarPanel({ voices, onClose, onCreated }: { voices: Voice[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [gender, setGender] = useState<"" | "male" | "female" | "neutral">("");
  const [defaultVoiceId, setDefaultVoiceId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState(false);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera(false);
  }

  async function startCamera() {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1600 } }, audio: false });
      streamRef.current = stream;
      setCamera(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => undefined);
        }
      });
    } catch {
      setErr("Camera access was blocked. Upload a portrait instead.");
    }
  }

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    // Crop to a 4:5 portrait around the centre.
    const targetRatio = 4 / 5;
    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w / h > targetRatio) w = Math.round(h * targetRatio);
    else h = Math.round(w / targetRatio);
    const sx = Math.round((video.videoWidth - w) / 2);
    const sy = Math.round((video.videoHeight - h) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 1000;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1); // un-mirror the selfie preview
    ctx.drawImage(video, sx, sy, w, h, 0, 0, canvas.width, canvas.height);
    setImageUrl(canvas.toDataURL("image/jpeg", 0.92));
    stopCamera();
  }

  useEffect(() => stopCamera, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setErr("Please choose an image under 4 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setImageUrl(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function submit() {
    setSaving(true);
    setErr(null);
    try {
      await api("/api/avatars", { method: "POST", body: JSON.stringify({ name, imageUrl, gender: gender || undefined, defaultVoiceId: defaultVoiceId || undefined }) });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create avatar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-6 p-5">
      <div className="grid gap-5 md:grid-cols-[180px_1fr]">
        <div
          onClick={() => !camera && fileRef.current?.click()}
          className="relative flex aspect-[4/5] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 text-center text-xs text-slate-500 hover:border-brand-400"
        >
          {camera ? (
            <>
              <video ref={videoRef} muted playsInline className="h-full w-full object-cover" style={{ transform: "scaleX(-1)" }} />
              <div className="absolute inset-x-0 bottom-2 flex justify-center gap-2" onClick={(e) => e.stopPropagation()}>
                <button type="button" onClick={capture} className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-900 shadow">Capture</button>
                <button type="button" onClick={stopCamera} className="rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white">Cancel</button>
              </div>
            </>
          ) : imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt="Portrait preview" className="h-full w-full object-cover" />
          ) : (
            <>
              <Upload className="mb-2 h-6 w-6" />
              Upload a portrait
              <span className="mt-1 text-[11px]">Front-facing, good light, neutral expression</span>
            </>
          )}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          {!camera && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startCamera();
              }}
              className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow hover:text-brand-700"
            >
              <VideoIcon className="h-3 w-3" /> Use camera
            </button>
          )}
        </div>
        <div className="space-y-4">
          <Field label="Avatar name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dan – office" />
          </Field>
          <Field label="Or paste an image URL" hint="Must be publicly reachable if your rendering provider fetches it.">
            <input className={inputClass} value={imageUrl.startsWith("data:") ? "" : imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…/portrait.jpg" />
          </Field>
          <Field label="Voice preference (optional)">
            <select className={inputClass} value={gender} onChange={(e) => setGender(e.target.value as typeof gender)}>
              <option value="">Not specified</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="neutral">Neutral</option>
            </select>
          </Field>
          {voices.length > 0 && (
            <Field label="Default voice (optional)" hint="The editor switches to this voice when the avatar is picked.">
              <select className={inputClass} value={defaultVoiceId} onChange={(e) => setDefaultVoiceId(e.target.value)}>
                <option value="">None</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <ErrorBanner message={err} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} loading={saving} disabled={!name.trim() || !imageUrl}>Create avatar</Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
