"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { Check, Languages } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, StatusBadge, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { ApiError, api, formatDate } from "@/lib/client";
import { MAX_TRANSLATION_SPEAKERS, type BrandKit, type Translation, type TranslationQuality } from "@/lib/types";

/** A job worth polling for: lines being translated or a dub running, but not lines waiting on someone to read them. */
const moving = (t: Translation) => (t.status === "processing" || t.status === "queued") && t.proofreadStage !== "ready";

/** A line's start as m:ss. */
const at = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** Matches the server's limit per request. */
const MAX_LANGUAGES = 5;

export default function TranslatePage() {
  return (
    <Suspense>
      <TranslateInner />
    </Suspense>
  );
}

function TranslateInner() {
  const canEdit = useCanEdit();
  const params = useSearchParams();
  const { data, error, refetch } = useApi<{ translations: Translation[]; languages: string[] }>("/api/translate", {
    pollMs: 6000,
    pollWhile: (d) => d.translations.some(moving),
  });
  const [title, setTitle] = useState(params.get("title") ?? "");
  const [sourceVideoUrl, setSource] = useState(params.get("source") ?? "");
  // Up to five languages per request, one dubbing job each.
  const [languages, setLanguages] = useState<string[]>(["Spanish"]);
  const toggle = (l: string) => setLanguages((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : prev.length >= MAX_LANGUAGES ? prev : [...prev, l]));
  const [lipSync, setLipSync] = useState(true);
  const [speakers, setSpeakers] = useState(0);
  const [quality, setQuality] = useState<TranslationQuality>("speed");
  const [removeMusic, setRemoveMusic] = useState(false);
  const [enhanceSpeech, setEnhanceSpeech] = useState(false);
  const [proofread, setProofread] = useState(false);
  const { data: brandData } = useApi<{ brand: BrandKit | null }>("/api/brand");
  const glossary = brandData?.brand?.glossary ?? [];
  const forcedRules = brandData?.brand?.forcedTranslations ?? [];
  // Rules for several languages can share a term; the page counts terms.
  const forcedTerms = new Set(forcedRules.map((r) => r.term.trim().toLowerCase())).size;
  // On by default: the server keeps the kit's terms when it has some (even if the kit has not loaded here yet).
  const [keepGlossary, setKeepGlossary] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Once a dub starts the form is cleared and its button disabled; the focus moves to the URL field for the next one.
  const sourceInput = useRef<HTMLInputElement>(null);
  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const fallback = languages.length === 1 ? `Translation to ${languages[0]}` : "Translation";
      await api("/api/translate", { method: "POST", body: JSON.stringify({ title: title || fallback, sourceVideoUrl, targetLanguages: languages, ...(lipSync ? {} : { audioOnly: true }), ...(speakers ? { speakers } : {}), ...(quality === "precision" ? { quality } : {}), ...(removeMusic ? { removeMusic } : {}), ...(enhanceSpeech ? { enhanceSpeech } : {}), ...(proofread ? { proofread } : {}), ...(keepGlossary ? { keepGlossary: true } : {}) }) });
      setSource("");
      setTitle("");
      // The next video may have a different cast; the lip-sync choice is a preference and stays.
      setSpeakers(0);
      refetch();
      sourceInput.current?.focus();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Translation failed");
      refetch();
    } finally {
      setSubmitting(false);
    }
  }

  const items = data?.translations ?? [];

  return (
    <>
      <SectionTitle title="Video translate" subtitle="Dub an existing video into other languages, lip-synced or voice only." />
      {canEdit === false && <ViewOnlyNotice what="start translations" />}
      <ErrorBanner message={error ?? err} />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card className="p-5">
          <div className="space-y-4">
            <Field label="Video URL" hint="A direct link to an MP4 the provider can download.">
              <input ref={sourceInput} className={inputClass} value={sourceVideoUrl} onChange={(e) => setSource(e.target.value)} placeholder="https://…/video.mp4" />
            </Field>
            <fieldset>
              <legend className="mb-1.5 block text-sm font-medium text-slate-700">
                Target languages <span className="font-normal text-slate-500">· {languages.length} of up to {MAX_LANGUAGES}, one dub each</span>
              </legend>
              <div className="flex flex-wrap gap-1.5" data-testid="target-languages">
                {(data?.languages ?? ["Spanish"]).map((l) => {
                  const on = languages.includes(l);
                  return (
                    <label key={l} className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500 ${on ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"} ${!on && languages.length >= MAX_LANGUAGES ? "cursor-not-allowed opacity-50" : ""}`}>
                      <input type="checkbox" className="sr-only" checked={on} disabled={!on && languages.length >= MAX_LANGUAGES} onChange={() => toggle(l)} />
                      {l}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" className="mt-0.5" checked={lipSync} disabled={canEdit === false} onChange={(e) => setLipSync(e.target.checked)} />
                <span>
                  Lip-sync the dub
                  <span className="block text-xs text-slate-500">Off dubs the voice only: faster, and fine when the speaker is often off screen.</span>
                </span>
              </label>
              <Field label="Speakers" hint="People talking in the video, so each keeps a voice of their own.">
                <select className={inputClass} value={speakers} disabled={canEdit === false} onChange={(e) => setSpeakers(Number(e.target.value))}>
                  <option value={0}>Detect automatically</option>
                  {Array.from({ length: MAX_TRANSLATION_SPEAKERS }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? "speaker" : "speakers"}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Quality" hint="Precision takes longer for a more natural translation and delivery; it matters most when the dub is lip-synced.">
                <select className={inputClass} value={quality} disabled={canEdit === false} onChange={(e) => setQuality(e.target.value as TranslationQuality)}>
                  <option value="speed">Speed</option>
                  <option value="precision">Precision</option>
                </select>
              </Field>
              <div className="space-y-2 pt-1">
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="mt-0.5" checked={removeMusic} disabled={canEdit === false} onChange={(e) => setRemoveMusic(e.target.checked)} />
                  <span>Remove background music</span>
                </label>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="mt-0.5" checked={enhanceSpeech} disabled={canEdit === false} onChange={(e) => setEnhanceSpeech(e.target.checked)} />
                  <span>Enhance speech</span>
                </label>
              </div>
            </div>
            {(glossary.length > 0 || forcedRules.length > 0) && (
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" className="mt-0.5" checked={keepGlossary} disabled={canEdit === false} onChange={(e) => setKeepGlossary(e.target.checked)} />
                <span>
                  Follow the brand glossary
                  <span className="block text-xs text-slate-500">
                    {glossary.length > 0 && (
                      <>
                        {glossary.slice(0, 4).join(", ")}
                        {glossary.length > 4 ? `, and ${glossary.length - 4} more` : ""} stay untranslated.{" "}
                      </>
                    )}
                    {forcedTerms > 0 && `${forcedTerms} ${forcedTerms === 1 ? "term is" : "terms are"} always translated one way (where a rule covers the language). `}
                    Edit them in the brand kit.
                  </span>
                </span>
              </label>
            )}
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5" checked={proofread} disabled={canEdit === false} onChange={(e) => setProofread(e.target.checked)} />
              <span>
                Proofread the lines first
                <span className="block text-xs text-slate-500">The translated lines wait for you to correct names, terms, and tone; the dub is made once you approve them.</span>
              </span>
            </label>
            <Field label="Title (optional)">
              <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={languages.length > 1 ? "Product walkthrough (each dub adds its language)" : "Product walkthrough – Spanish"} />
            </Field>
            <Button onClick={submit} loading={submitting} disabled={!/^https?:\/\//.test(sourceVideoUrl) || canEdit === false || languages.length === 0} className="w-full">
              <Languages className="h-4 w-4" /> {languages.length > 1 ? `Translate into ${languages.length} languages` : "Translate video"}
            </Button>
          </div>
        </Card>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Translations</h2>
          {items.length === 0 ? (
            <EmptyState icon={<Languages className="h-8 w-8" />} title="No translations yet" body="Submit a video on the left to get started." />
          ) : (
            <div className="space-y-3">
              {items.map((t) => (
                <Card key={t.id} className="p-4" data-testid="translation">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900">{t.title}</div>
                      <div className="mt-0.5 text-xs text-slate-500" data-testid="translation-meta">
                        → {t.targetLanguage}
                        {t.audioOnly ? " · voice only" : ""}
                        {t.speakers ? ` · ${t.speakers} ${t.speakers === 1 ? "speaker" : "speakers"}` : ""}
                        {t.quality === "precision" ? " · precision" : ""}
                        {t.removeMusic ? " · no music" : ""}
                        {t.enhanceSpeech ? " · enhanced speech" : ""}
                        {t.proofread ? " · proofread" : ""}
                        {t.glossary?.length ? ` · keeps ${t.glossary.length} brand ${t.glossary.length === 1 ? "term" : "terms"}` : ""}
                        {t.forcedTranslations?.length ? ` · ${t.forcedTranslations.length} fixed ${t.forcedTranslations.length === 1 ? "translation" : "translations"}` : ""} · {formatDate(t.createdAt)}
                      </div>
                      {t.proofreadStage === "preparing" && <div className="mt-1 text-xs text-slate-500">Translating the lines for you to proofread…</div>}
                      {t.proofreadStage === "dubbing" && <div className="mt-1 text-xs text-slate-500">Starting the dub…</div>}
                      {t.error && <div className="mt-1 text-xs text-rose-600">{t.error}</div>}
                    </div>
                    {t.proofreadStage === "ready" ? (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">Ready to proofread</span>
                    ) : (
                      <StatusBadge status={t.status} />
                    )}
                  </div>
                  {t.proofreadStage === "ready" && t.proofreadCues && <Proofread key={t.id} translation={t} canEdit={canEdit !== false} onChange={refetch} />}
                  {t.status === "completed" && t.videoUrl && <video src={t.videoUrl} controls className="mt-3 w-full rounded-lg bg-black" />}
                  {t.status === "completed" && (t.captionUrls?.srt || t.captionUrls?.vtt) && (
                    <div className="mt-2 flex flex-wrap gap-3 text-xs" data-testid="translation-captions">
                      <span className="text-slate-500">Subtitles in {t.targetLanguage}:</span>
                      {t.captionUrls.srt && (
                        <a href={t.captionUrls.srt} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                          SRT
                        </a>
                      )}
                      {t.captionUrls.vtt && (
                        <a href={t.captionUrls.vtt} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                          VTT
                        </a>
                      )}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** The translated lines of a proofread dub, to correct and then dub. Each line keeps its timing; only the words change. */
function Proofread({ translation, canEdit, onChange }: { translation: Translation; canEdit: boolean; onChange: () => void }) {
  const cues = translation.proofreadCues ?? [];
  const [lines, setLines] = useState(() => cues.map((c) => c.text));
  const [busy, setBusy] = useState<"save" | "dub" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The version these lines were opened at; a save or a refused dub moves it on, someone else's change does not.
  const [basedOn, setBasedOn] = useState(translation.updatedAt);
  const changed = lines.some((l, i) => l !== cues[i]?.text);
  const blank = lines.some((l) => !l.trim());

  async function send(kind: "save" | "dub") {
    setBusy(kind);
    setErr(null);
    setSaved(false);
    try {
      const body = JSON.stringify({ lines: lines.map((l) => l.trim()), basedOn });
      if (kind === "save") {
        const res = await api<{ translation: Translation }>(`/api/translate/${translation.id}`, { method: "PATCH", body });
        setBasedOn(res.translation.updatedAt);
        setSaved(true);
      } else {
        await api(`/api/translate/${translation.id}/dub`, { method: "POST", body });
      }
      onChange();
    } catch (e) {
      // A refused dub kept these lines; the next try builds on that version.
      const kept = e instanceof ApiError ? (e.body as { translation?: Translation } | undefined)?.translation : undefined;
      if (kept?.updatedAt) setBasedOn(kept.updatedAt);
      setErr(e instanceof Error ? e.message : "Something went wrong");
      onChange();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-slate-100 pt-3" data-testid="proofread">
      <p className="text-xs text-slate-500">
        Read the {cues.length} translated {cues.length === 1 ? "line" : "lines"} and fix anything the dub should say differently. Nothing is dubbed until you approve them.
      </p>
      <ol className="max-h-96 space-y-2 overflow-y-auto pr-1">
        {cues.map((c, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="w-10 shrink-0 pt-2 text-right text-xs tabular-nums text-slate-400">{at(c.startMs)}</span>
            <textarea
              aria-label={`Line ${i + 1}`}
              className={`${inputClass} min-h-[2.5rem] flex-1 resize-y`}
              rows={1}
              value={lines[i]}
              maxLength={300}
              disabled={!canEdit || !!busy}
              onChange={(e) => setLines((prev) => prev.map((l, j) => (j === i ? e.target.value : l)))}
            />
          </li>
        ))}
      </ol>
      {err && <div className="text-xs text-rose-600">{err}</div>}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => send("dub")} loading={busy === "dub"} disabled={!!busy || blank}>
            <Check className="h-4 w-4" /> Approve and dub
          </Button>
          <Button variant="secondary" onClick={() => send("save")} loading={busy === "save"} disabled={!!busy || blank || !changed}>
            Save corrections
          </Button>
          {saved && !changed && <span className="text-xs text-slate-500">Saved</span>}
          {blank && <span className="text-xs text-rose-600">Every line needs some text.</span>}
        </div>
      )}
    </div>
  );
}
