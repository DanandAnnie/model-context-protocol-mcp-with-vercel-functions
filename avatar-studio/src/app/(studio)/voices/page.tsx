"use client";
import { useMemo, useRef, useState } from "react";
import { Mic2, Pencil, Trash2 } from "lucide-react";
import { VoiceCloner } from "@/components/VoiceCloner";
import { VoiceDesigner } from "@/components/VoiceDesigner";
import { api, passesUse, shownPresenterSort, sortPresenters, type PresenterSort, type UseFilter } from "@/lib/client";
import { VoiceRow } from "@/components/VoicePicker";
import { EmptyState, ErrorBanner, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { usePresenterSort } from "@/hooks/usePresenterSort";
import { favoritesFirst, useFavorites } from "@/hooks/useFavorites";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import { languageLabel } from "@/lib/language";
import type { ProviderStatus, Voice } from "@/lib/types";
import type { VideoPage } from "@/lib/services/videos";
import type { OtherUses } from "@/lib/services/usage";
import { describeOtherUses, usesOf } from "@/lib/presenters";
import { OtherUsesLine } from "@/components/OtherUsesLine";
import Link from "next/link";

/** How many videos need an id, read as the id's own entry only (an id like "constructor" is not the object's prototype). */
const neededBy = (counts: Record<string, number> | undefined, id: string) => (counts && Object.hasOwn(counts, id) && typeof counts[id] === "number" ? counts[id] : 0);

const GENDERS: Array<NonNullable<Voice["gender"]>> = ["female", "male", "neutral"];

const SAMPLE = "Hi, this is a quick preview of my voice. I can read your script in any tone you need.";

export default function VoicesPage() {
  const canEdit = useCanEdit();
  const { data, loading, error, refetch } = useApi<{ voices: Voice[]; own?: { count: number; limit: number } }>("/api/voices");
  const { data: status } = useApi<ProviderStatus>("/api/status");
  // How many of the library's videos speak in each voice (the library's own counts; the trash is not counted), for the
  // "In N videos" link under each voice and the warning before one is deleted.
  const { data: library, error: libraryError, refetch: refetchLibrary } = useApi<VideoPage>("/api/videos?limit=1");
  // What besides videos names each one (interactive presenters, templates, the brand kit), for a "Used by" line
  // under each and the same warning.
  const { data: otherUses, error: otherUsesError } = useApi<OtherUses>("/api/usage");
  const inVideos = useMemo(() => new Map((library?.voices ?? []).map((p) => [p.id, p.count])), [library]);
  const videosText = (n: number) => (n === 1 ? "1 video" : `${n} videos`);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  async function renameVoice(v: Voice) {
    const answer = window.prompt("Voice name", v.name);
    if (answer === null) return;
    const name = answer.trim();
    if (!name || name === v.name) return;
    setActionErr(null);
    try {
      await api(`/api/voices/${v.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await refetch();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Could not rename the voice");
    }
  }
  async function removeVoice(v: Voice) {
    // Every video a retry or copy of which would ask for it, the trash included, not only those that speak in it.
    const used = neededBy(library?.needs.voices, v.id);
    const after = "videos already rendered keep their audio, but retrying or copying one needs another voice.";
    // Before the counts arrive (or when they could not be read), the prompt cannot say it is unused.
    const warning = !library
      ? ` It may be used by videos in your library${libraryError ? "" : " (still counting)"}: ${after}`
      : used
        ? ` ${videosText(used)} in your library or trash use it: ${after}`
        : " Videos already rendered keep their audio.";
    // Besides videos: interactive presenters, templates, the brand kit, a photo avatar's default voice.
    const others = describeOtherUses(usesOf(otherUses?.voices, v.id));
    // "Also" only after a count of videos; and unread, the prompt says it could not check rather than nothing.
    const also = others
      ? ` It is ${used || !library ? "also " : ""}used by ${others}, which would need another voice.`
      : otherUses
        ? ""
        : ` (Interactive presenters, templates, and the brand kit could not be checked${otherUsesError ? "" : " yet"}.)`;
    if (!window.confirm(`Delete "${v.name}"?${warning}${also}`)) return;
    setActionErr(null);
    try {
      await api(`/api/voices/${v.id}`, { method: "DELETE" });
      await refetch();
      void refetchLibrary();
      // The row and its buttons are gone; the focus goes to the search above the list.
      searchRef.current?.focus();
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
  // Voices by whether any video, in the library or the trash, still needs them. Only videos are counted: an interactive
  // presenter, a saved template, the brand kit, or a presenter's default voice may still name one no video needs.
  const [use, setUse] = useState<UseFilter>("all");
  // As listed with favourites first, most used in the library's videos (the "In N videos" counts), or by name;
  // remembered in this browser.
  const [sort, setSort] = usePresenterSort("avatar-studio:voices-sort");
  // Languages offered by the current voice provider, named for people ("en-GB" → "British English").
  const languages = useMemo(() => {
    const seen = new Map<string, string>();
    for (const v of data?.voices ?? []) if (v.language && !seen.has(v.language)) seen.set(v.language, languageLabel(v.language));
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);
  const genders = useMemo(() => GENDERS.filter((g) => (data?.voices ?? []).some((v) => v.gender === g)), [data]);

  const favorites = useFavorites();
  const shownSort = shownPresenterSort(sort, !!library);
  const voices = useMemo(() => {
    const all = data?.voices ?? [];
    const needle = q.trim().toLowerCase();
    const matching = all.filter((v) => {
      if (language !== "all" && v.language !== language) return false;
      if (gender !== "all" && v.gender !== gender) return false;
      if (!passesUse(library?.needs.voices, v.id, use)) return false;
      return !needle || [v.name, v.language, v.gender, ...(v.tags ?? [])].filter(Boolean).join(" ").toLowerCase().includes(needle);
    });
    return shownSort === "default" ? favoritesFirst(matching, favorites.voiceIds) : sortPresenters(matching, shownSort, inVideos);
  }, [data, q, language, gender, use, shownSort, library, inVideos, favorites.voiceIds]);

  return (
    <>
      <SectionTitle title="Voices" subtitle="Preview any voice with your own sample text, clone your own, or design one from a description." />
      {canEdit === false && <ViewOnlyNotice what="clone, design, or change voices" />}
      <ErrorBanner message={error ?? previewErr ?? actionErr} />
      {/* Shown once the role is known: a viewer never sees them while the workspace is still loading. */}
      {/* And once the provider is known, as it decides how samples are sent. */}
      {canEdit === true && status && (
        <div className={`mb-6 grid gap-4 ${status.voiceDesign ? "lg:grid-cols-2" : ""}`}>
          <VoiceCloner available={status?.tts !== "mock"} oneRecording={!!status?.voiceCloneOneRecording} onCloned={() => refetch()} />
          {status?.voiceDesign && <VoiceDesigner available={status.tts !== "mock"} ownCount={data?.own?.count ?? 0} limit={data?.own?.limit ?? 5} onSaved={() => refetch()} />}
        </div>
      )}
      <div className="mb-5 grid gap-3 md:grid-cols-[1fr_2fr]">
        <input ref={searchRef} aria-label="Search voices" className={inputClass} placeholder="Search by name, language, or style" value={q} onChange={(e) => setQ(e.target.value)} />
        <input aria-label="Sample text to speak" className={inputClass} value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Sample text to speak" />
      </div>
      {(languages.length > 1 || genders.length > 1 || !!library || !!libraryError) && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <select aria-label="Use in videos" value={use} onChange={(e) => setUse(e.target.value as UseFilter)} disabled={!library} title={library ? "Counts the videos, in the library and the trash, a retry or copy of which would ask for each voice; interactive presenters, templates, and the brand kit are not counted" : libraryError ? "Could not count the videos that use each voice; reload to try again" : "Counting the videos that use each voice"} className={`${inputClass} w-auto`}>
            <option value="all">Any use</option>
            <option value="used">Used by videos</option>
            <option value="unused">Not used by any video</option>
          </select>
          <select aria-label="Sort voices" value={shownSort} onChange={(e) => setSort(e.target.value as PresenterSort)} title={library ? "Most used counts the library's videos each voice is in, the numbers under each; the trash is not counted" : libraryError ? "Could not count the videos that use each voice, so Most used is not offered; reload to try again" : "Counting the videos that use each voice"} className={`${inputClass} w-auto`}>
            <option value="default">Favourites first</option>
            <option value="used" disabled={!library}>Most used in the library</option>
            <option value="name">Name A–Z</option>
          </select>
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
        // Columns that can shrink below their content, so a long voice name truncates rather than pushing the page sideways.
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2" data-testid="voice-list">
          {voices.map((v) => (
            <div key={v.id} className="min-w-0" data-voice-id={v.id}>
              <VoiceRow
                voice={v}
                playing={playingId === v.id}
                busy={busyId === v.id}
                onPreview={() => play(v, sample || SAMPLE).catch((e) => setPreviewErr(e.message))}
                favorite={favorites.voiceIds.has(v.id)}
                onToggleFavorite={favorites.canToggle ? () => favorites.toggle("voice", v.id) : undefined}
                // Shown once the role is known, and never to a viewer (the server would refuse them).
                actions={
                  v.source === "custom" && canEdit === true ? (
                    <>
                      <button
                        type="button"
                        onClick={() => renameVoice(v)}
                        aria-label={`Rename ${v.name}`}
                        title="Rename this voice of your own; videos already rendered keep the old name"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-700"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeVoice(v)}
                        aria-label={`Delete ${v.name}`}
                        title="Delete this voice of your own"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  ) : undefined
                }
              />
              {(inVideos.get(v.id) ?? 0) > 0 && (
                <Link
                  href={`/videos?voice=${encodeURIComponent(v.id)}`}
                  aria-label={`In ${videosText(inVideos.get(v.id)!)}: show the videos in ${v.name} in the library`}
                  className="ml-1 mt-1 inline-block text-xs font-medium text-brand-700 hover:underline"
                  data-voice-videos={v.id}
                >
                  In {videosText(inVideos.get(v.id)!)}
                </Link>
              )}
              <OtherUsesLine uses={usesOf(otherUses?.voices, v.id)} marker={{ "data-voice-others": v.id }} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
