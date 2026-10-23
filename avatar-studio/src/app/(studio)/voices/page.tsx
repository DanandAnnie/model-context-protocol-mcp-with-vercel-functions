"use client";
import { useMemo, useState } from "react";
import { Mic2, Trash2 } from "lucide-react";
import { VoiceCloner } from "@/components/VoiceCloner";
import { api } from "@/lib/client";
import { VoiceRow } from "@/components/VoicePicker";
import { EmptyState, ErrorBanner, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import { languageLabel } from "@/lib/language";
import type { ProviderStatus, Voice } from "@/lib/types";

const GENDERS: Array<NonNullable<Voice["gender"]>> = ["female", "male", "neutral"];

const SAMPLE = "Hi, this is a quick preview of my voice. I can read your script in any tone you need.";

export default function VoicesPage() {
  const { data, loading, error, refetch } = useApi<{ voices: Voice[] }>("/api/voices");
  const { data: status } = useApi<ProviderStatus>("/api/status");
  const [actionErr, setActionErr] = useState<string | null>(null);
  async function removeVoice(v: Voice) {
    if (!window.confirm(`Delete "${v.name}"? Videos already rendered keep their audio.`)) return;
    setActionErr(null);
    try {
      await api(`/api/voices/${v.id}`, { method: "DELETE" });
      await refetch();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Could not delete the voice");
    }
  }
  const { play, playingId, busyId } = useVoicePreview();
  const [q, setQ] = useState("");
  const [sample, setSample] = useState(SAMPLE);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const [language, setLanguage] = useState("all");
  const [gender, setGender] = useState<"all" | NonNullable<Voice["gender"]>>("all");
  // Languages offered by the current voice provider, named for people ("en-GB" → "British English").
  const languages = useMemo(() => {
    const seen = new Map<string, string>();
    for (const v of data?.voices ?? []) if (v.language && !seen.has(v.language)) seen.set(v.language, languageLabel(v.language));
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);
  const genders = useMemo(() => GENDERS.filter((g) => (data?.voices ?? []).some((v) => v.gender === g)), [data]);

  const voices = useMemo(() => {
    const all = data?.voices ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((v) => {
      if (language !== "all" && v.language !== language) return false;
      if (gender !== "all" && v.gender !== gender) return false;
      return !needle || [v.name, v.language, v.gender, ...(v.tags ?? [])].filter(Boolean).join(" ").toLowerCase().includes(needle);
    });
  }, [data, q, language, gender]);

  return (
    <>
      <SectionTitle title="Voices" subtitle="Preview any voice with your own sample text, or clone your own." />
      <ErrorBanner message={error ?? previewErr ?? actionErr} />
      <div className="mb-6">
        <VoiceCloner available={status?.tts !== "mock"} onCloned={() => refetch()} />
      </div>
      <div className="mb-5 grid gap-3 md:grid-cols-[1fr_2fr]">
        <input className={inputClass} placeholder="Search by name, language, or style" value={q} onChange={(e) => setQ(e.target.value)} />
        <input className={inputClass} value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Sample text to speak" />
      </div>
      {(languages.length > 1 || genders.length > 1) && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {languages.length > 1 && (
            <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)} className={`${inputClass} w-auto`}>
              <option value="all">All languages</option>
              {languages.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          )}
          {genders.length > 1 && (
            <select aria-label="Gender" value={gender} onChange={(e) => setGender(e.target.value as typeof gender)} className={`${inputClass} w-auto`}>
              <option value="all">Any gender</option>
              {genders.map((g) => (
                <option key={g} value={g}>{g[0].toUpperCase() + g.slice(1)}</option>
              ))}
            </select>
          )}
          <span className="text-xs text-slate-500">{voices.length} of {data?.voices.length ?? 0} voices</span>
        </div>
      )}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : voices.length === 0 ? (
        <EmptyState icon={<Mic2 className="h-8 w-8" />} title="No voices match" />
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {voices.map((v) => (
            <div key={v.id} className="relative">
              <VoiceRow voice={v} playing={playingId === v.id} busy={busyId === v.id} onPreview={() => play(v, sample || SAMPLE).catch((e) => setPreviewErr(e.message))} />
              {v.source === "custom" && (
                <button
                  type="button"
                  onClick={() => removeVoice(v)}
                  aria-label={`Delete ${v.name}`}
                  title="Delete this cloned voice"
                  className="absolute right-12 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
