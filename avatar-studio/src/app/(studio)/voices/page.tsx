"use client";
import { useMemo, useState } from "react";
import { Mic2 } from "lucide-react";
import { VoiceRow } from "@/components/VoicePicker";
import { EmptyState, ErrorBanner, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import type { Voice } from "@/lib/types";

const SAMPLE = "Hi, this is a quick preview of my voice. I can read your script in any tone you need.";

export default function VoicesPage() {
  const { data, loading, error } = useApi<{ voices: Voice[] }>("/api/voices");
  const { play, playingId, busyId } = useVoicePreview();
  const [q, setQ] = useState("");
  const [sample, setSample] = useState(SAMPLE);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const voices = useMemo(() => {
    const all = data?.voices ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((v) => [v.name, v.language, v.gender, ...(v.tags ?? [])].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }, [data, q]);

  return (
    <>
      <SectionTitle title="Voices" subtitle="Preview any voice with your own sample text." />
      <ErrorBanner message={error ?? previewErr} />
      <div className="mb-5 grid gap-3 md:grid-cols-[1fr_2fr]">
        <input className={inputClass} placeholder="Search by name, language, or style" value={q} onChange={(e) => setQ(e.target.value)} />
        <input className={inputClass} value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Sample text to speak" />
      </div>
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
            <VoiceRow
              key={v.id}
              voice={v}
              playing={playingId === v.id}
              busy={busyId === v.id}
              onPreview={() => play(v, sample || SAMPLE).catch((e) => setPreviewErr(e.message))}
            />
          ))}
        </div>
      )}
    </>
  );
}
