"use client";
import { useEffect, useRef, useState } from "react";
import { Palette, Trash2, Upload } from "lucide-react";
import { Button, Card, ErrorBanner, Field, SectionTitle, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { api, isDarkHex } from "@/lib/client";
import { MAX_PRONUNCIATIONS, formatPronunciations, parsePronunciations } from "@/lib/pronounce";
import { MAX_GLOSSARY_TERMS, MAX_GLOSSARY_TERM_LENGTH, MIN_GLOSSARY_TERM_LENGTH, parseGlossary } from "@/lib/glossary";
import type { AspectRatio, Avatar, BrandKit, Resolution, Voice } from "@/lib/types";

const DEFAULT_PRIMARY = "#4f46e5";
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Brand kit: logo, colors, and defaults applied to every new video and the public share page. */
export default function BrandPage() {
  const canEdit = useCanEdit();
  const { data: brandData, loading } = useApi<{ brand: BrandKit | null }>("/api/brand");
  const { data: avatarData } = useApi<{ avatars: Avatar[] }>("/api/avatars");
  const { data: voiceData } = useApi<{ voices: Voice[] }>("/api/voices");

  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [primary, setPrimary] = useState(DEFAULT_PRIMARY);
  const [accent, setAccent] = useState("");
  const [bgType, setBgType] = useState<"" | "image" | "video">("");
  const [bgUrl, setBgUrl] = useState("");
  const [pronunciations, setPronunciations] = useState("");
  const [glossary, setGlossary] = useState("");
  const [avatarId, setAvatarId] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [aspect, setAspect] = useState<AspectRatio | "">("");
  const [resolution, setResolution] = useState<Resolution | "">("");
  const [captions, setCaptions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hydrated = useRef(false);

  // Load the saved kit into the form once.
  useEffect(() => {
    if (hydrated.current || !brandData) return;
    hydrated.current = true;
    const b = brandData.brand;
    if (!b) return;
    setName(b.name);
    setLogoUrl(b.logoUrl ?? "");
    setPrimary(b.primaryColor);
    setAccent(b.accentColor ?? "");
    setBgType(b.defaultBackground && b.defaultBackground.type !== "color" ? b.defaultBackground.type : "");
    setBgUrl(b.defaultBackground && b.defaultBackground.type !== "color" ? b.defaultBackground.value : "");
    setPronunciations(formatPronunciations(b.pronunciations ?? []));
    setGlossary((b.glossary ?? []).join("\n"));
    setAvatarId(b.defaultAvatarId ?? "");
    setVoiceId(b.defaultVoiceId ?? "");
    setAspect(b.defaultAspect ?? "");
    setResolution(b.defaultResolution ?? "");
    setCaptions(!!b.captionsByDefault);
    setSavedAt(b.updatedAt);
  }, [brandData]);

  function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setErr("Please choose a logo under 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoUrl(String(reader.result));
    reader.readAsDataURL(file);
  }

  const primaryValid = HEX.test(primary);
  const accentValid = accent === "" || HEX.test(accent);

  async function save() {
    const rules = parsePronunciations(pronunciations);
    if (rules.length > MAX_PRONUNCIATIONS) {
      setErr(`Up to ${MAX_PRONUNCIATIONS} pronunciations (you have ${rules.length}).`);
      return;
    }
    const badRule = rules.find((r) => r.word.length > 40 || r.sayAs.length > 80);
    if (badRule) {
      setErr(`Pronunciation "${badRule.word.slice(0, 20)}": the word is at most 40 characters and the spelling at most 80.`);
      return;
    }
    const terms = parseGlossary(glossary);
    if (terms.length > MAX_GLOSSARY_TERMS) {
      setErr(`Up to ${MAX_GLOSSARY_TERMS} terms to keep untranslated (you have ${terms.length}).`);
      return;
    }
    const longTerm = terms.find((t) => t.length > MAX_GLOSSARY_TERM_LENGTH);
    if (longTerm) {
      setErr(`"${longTerm.slice(0, 20)}…": a term to keep untranslated is at most ${MAX_GLOSSARY_TERM_LENGTH} characters.`);
      return;
    }
    // A one-letter term would hold back every "a" or "I" in a script.
    const shortTerm = terms.find((t) => t.length < MIN_GLOSSARY_TERM_LENGTH);
    if (shortTerm) {
      setErr(`"${shortTerm}": a term to keep untranslated is at least ${MIN_GLOSSARY_TERM_LENGTH} characters.`);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const { brand } = await api<{ brand: BrandKit }>("/api/brand", {
        method: "PUT",
        body: JSON.stringify({
          name,
          logoUrl,
          primaryColor: primary,
          accentColor: accent || undefined,
          defaultBackground: bgType && bgUrl.trim() ? { type: bgType, value: bgUrl.trim() } : undefined,
          pronunciations: rules,
          glossary: terms,
          defaultAvatarId: avatarId || undefined,
          defaultVoiceId: voiceId || undefined,
          defaultAspect: aspect || undefined,
          defaultResolution: resolution || undefined,
          captionsByDefault: captions,
        }),
      });
      setSavedAt(brand.updatedAt);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the brand kit");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm("Remove the brand kit? New videos go back to the standard defaults.")) return;
    setSaving(true);
    setErr(null);
    try {
      await api("/api/brand", { method: "DELETE" });
      setName("");
      setLogoUrl("");
      setPrimary(DEFAULT_PRIMARY);
      setAccent("");
      setAvatarId("");
      setVoiceId("");
      setAspect("");
      setResolution("");
      setBgType("");
      setBgUrl("");
      setPronunciations("");
      setGlossary("");
      setCaptions(false);
      setSavedAt(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove the brand kit");
    } finally {
      setSaving(false);
    }
  }

  const avatarName = avatarData?.avatars.find((a) => a.id === avatarId)?.name;
  const voiceName = voiceData?.voices.find((v) => v.id === voiceId)?.name;

  return (
    <>
      <SectionTitle
        title="Brand kit"
        subtitle="Your logo, colors, and default presenter are applied to every new video and shown on shared pages."
        action={
          savedAt ? (
            <Button variant="secondary" onClick={remove} disabled={saving || canEdit === false}>
              <Trash2 className="h-4 w-4" /> Remove brand kit
            </Button>
          ) : undefined
        }
      />
      {canEdit === false && <ViewOnlyNotice what="change the brand kit" />}
      <ErrorBanner message={err} />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card className="space-y-5 p-5">
          <Field label="Brand name" hint="Shown in the header of shared videos.">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Realty" maxLength={80} className={inputClass} disabled={loading} />
          </Field>
          <Field label="Logo" hint="PNG or SVG with a transparent background looks best. Upload a file or paste an image URL.">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoUrl} alt="Logo preview" className="h-full w-full object-contain p-1" onError={() => setErr("That logo URL could not be loaded.")} />
                ) : (
                  <Palette className="h-5 w-5 text-slate-300" />
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Upload logo
              </Button>
              <input
                value={logoUrl.startsWith("data:") ? "" : logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder={logoUrl.startsWith("data:") ? "Uploaded file" : "https://example.com/logo.png"}
                className={`${inputClass} min-w-[200px] flex-1`}
              />
              {logoUrl && (
                <button type="button" onClick={() => setLogoUrl("")} className="text-xs text-slate-500 hover:text-slate-900">
                  Clear
                </button>
              )}
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Primary color" hint="Default scene background and share page accent.">
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Primary color picker" value={primaryValid ? primary : DEFAULT_PRIMARY} onChange={(e) => setPrimary(e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-slate-200 bg-white p-0.5" />
                <input aria-label="Primary color" value={primary} onChange={(e) => setPrimary(e.target.value.trim())} className={`${inputClass} font-mono ${primaryValid ? "" : "border-rose-300"}`} />
              </div>
            </Field>
            <Field label="Accent color" hint="Optional. Used for highlights on the share page.">
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Accent color picker" value={accentValid && accent ? accent : "#0ea5e9"} onChange={(e) => setAccent(e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-slate-200 bg-white p-0.5" />
                <input aria-label="Accent color" value={accent} onChange={(e) => setAccent(e.target.value.trim())} placeholder="none" className={`${inputClass} font-mono ${accentValid ? "" : "border-rose-300"}`} />
              </div>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default avatar">
              <select value={avatarId} onChange={(e) => setAvatarId(e.target.value)} className={inputClass}>
                <option value="">First in the library</option>
                {avatarData?.avatars.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.source === "custom" ? " (photo avatar)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Default voice">
              <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} className={inputClass}>
                <option value="">First in the library</option>
                {voiceData?.voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.language ? ` · ${v.language}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default background" hint="What sits behind the presenter in every new video. A video loops on HeyGen; other renderers use their default.">
              <select aria-label="Default background" value={bgType} onChange={(e) => setBgType(e.target.value as typeof bgType)} className={inputClass}>
                <option value="">Primary colour</option>
                <option value="image">Image URL</option>
                <option value="video">Video URL</option>
              </select>
            </Field>
            {bgType && (
              <Field label={bgType === "video" ? "Background video URL" : "Background image URL"} hint="A public URL; the kit cannot be saved while this is empty.">
                <input aria-label="Default background URL" value={bgUrl} onChange={(e) => setBgUrl(e.target.value)} placeholder={bgType === "video" ? "https://…/loop.mp4" : "https://…/background.jpg"} className={inputClass} maxLength={2000} />
              </Field>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default aspect ratio">
              <select value={aspect} onChange={(e) => setAspect(e.target.value as AspectRatio | "")} className={inputClass}>
                <option value="">16:9 (standard)</option>
                <option value="16:9">16:9 landscape</option>
                <option value="9:16">9:16 vertical</option>
                <option value="1:1">1:1 square</option>
              </select>
            </Field>
            <Field label="Default output quality">
              <select value={resolution} onChange={(e) => setResolution(e.target.value as Resolution | "")} className={inputClass}>
                <option value="">1080p (app default)</option>
                <option value="720p">720p · HD, faster and smaller</option>
                <option value="1080p">1080p · Full HD</option>
              </select>
            </Field>
            <label className="flex items-center gap-3 self-end rounded-lg border border-slate-200 px-3 py-2">
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} className="h-5 w-5 accent-brand-600" />
              <span className="text-sm text-slate-700">Captions on by default</span>
            </label>
          </div>
          <Field label="Pronunciation" hint="One per line, word = how to say it (for example Nair = Nye-er). Renders say it that way; scripts and captions keep the spelling. Up to 50.">
            <textarea aria-label="Pronunciation" value={pronunciations} onChange={(e) => setPronunciations(e.target.value)} rows={3} placeholder={"Nair = Nye-er\nSaaS = sass"} className={`${inputClass} font-mono text-xs`} />
          </Field>
          <Field label="Never translate" hint="One term per line: product names, slogans, handles. Translating a script or adding a subtitle language keeps each one exactly as written (matched whole, ignoring case). Dubbing jobs go to the provider as they are. Up to 50.">
            <textarea aria-label="Never translate" value={glossary} onChange={(e) => setGlossary(e.target.value)} rows={3} placeholder={"Acme Cloud\nNimbus"} className={`${inputClass} font-mono text-xs`} />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <span className="text-xs text-slate-500">{savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : "Not saved yet"}</span>
            <Button onClick={save} loading={saving} disabled={!primaryValid || !accentValid || (!!bgType && !bgUrl.trim()) || loading || canEdit === false}>
              Save brand kit
            </Button>
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="h-1.5" style={{ background: primaryValid ? primary : DEFAULT_PRIMARY }} />
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-md bg-slate-100">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoUrl} alt="" className="h-full w-full object-contain p-0.5" />
                ) : (
                  <Palette className="h-4 w-4 text-slate-400" />
                )}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900">{name || "Your brand"}</div>
                <div className="text-xs text-slate-500">share page header</div>
              </div>
            </div>
            <div
              className={`mx-4 mb-4 flex aspect-video items-end rounded-lg p-3 text-xs ${isDarkHex(primaryValid ? primary : DEFAULT_PRIMARY) ? "text-white/90" : "text-slate-800"}`}
              style={{ background: primaryValid ? primary : DEFAULT_PRIMARY }}
            >
              <span className="rounded bg-black/40 px-2 py-1 text-white">{captions ? "Captions on" : "Scene background"}</span>
            </div>
          </Card>
          <Card className="p-4 text-sm text-slate-600">
            <h3 className="mb-2 font-semibold text-slate-900">Applied to new videos</h3>
            <ul className="space-y-1 text-xs">
              <li>Avatar: {avatarName ?? "first in the library"}</li>
              <li>Voice: {voiceName ?? "first in the library"}</li>
              <li>Aspect: {aspect || "16:9"}</li>
              <li>Quality: {resolution || "1080p"}</li>
              <li>Captions: {captions ? "on" : "off"}</li>
              <li>Background: {primaryValid ? primary : DEFAULT_PRIMARY}</li>
            </ul>
            <p className="mt-3 text-xs text-slate-500">Templates keep their own aspect ratio; copies keep every setting of the original.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
