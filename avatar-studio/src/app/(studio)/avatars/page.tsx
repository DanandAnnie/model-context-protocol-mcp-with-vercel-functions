"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Camera, Trash2, Upload, Users } from "lucide-react";
import { AvatarTile } from "@/components/AvatarPicker";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/client";
import type { Avatar } from "@/lib/types";

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
  const [open, setOpen] = useState(params.get("new") === "1");
  const [filter, setFilter] = useState<"all" | "custom" | "library">("all");
  const avatars = (data?.avatars ?? []).filter((a) => (filter === "all" ? true : filter === "custom" ? a.source === "custom" : a.source !== "custom"));

  async function remove(a: Avatar) {
    if (!confirm(`Delete avatar "${a.name}"?`)) return;
    await api(`/api/avatars/${a.id}`, { method: "DELETE" });
    refetch();
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
      <ErrorBanner message={error} />

      <div className="mb-5 flex gap-2">
        {(["all", "library", "custom"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${filter === f ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"}`}
          >
            {f === "all" ? "All" : f === "library" ? "Library" : "My avatars"}
          </button>
        ))}
      </div>

      {open && <CreateAvatarPanel onClose={() => setOpen(false)} onCreated={() => { setOpen(false); refetch(); }} />}

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/5]" />
          ))}
        </div>
      ) : avatars.length === 0 ? (
        <EmptyState icon={<Users className="h-8 w-8" />} title="No avatars here" body="Create a photo avatar from a portrait to get started." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {avatars.map((a) => (
            <div key={a.id} className="relative">
              <AvatarTile avatar={a} />
              {a.source === "custom" && (
                <button
                  onClick={() => remove(a)}
                  aria-label="Delete avatar"
                  className="absolute right-2 top-2 rounded-full bg-white/90 p-1.5 text-slate-600 shadow hover:text-rose-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CreateAvatarPanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [gender, setGender] = useState<"" | "male" | "female" | "neutral">("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
      await api("/api/avatars", { method: "POST", body: JSON.stringify({ name, imageUrl, gender: gender || undefined }) });
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
          onClick={() => fileRef.current?.click()}
          className="flex aspect-[4/5] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 text-center text-xs text-slate-500 hover:border-brand-400"
        >
          {imageUrl ? (
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
