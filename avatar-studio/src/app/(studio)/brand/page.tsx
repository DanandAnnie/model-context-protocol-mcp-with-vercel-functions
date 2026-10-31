"use client";
import { useEffect, useRef, useState } from "react";
import { Globe, Palette, Trash2, Upload } from "lucide-react";
import { Button, Card, ErrorBanner, Field, SectionTitle, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { BackdropPicker } from "@/components/BackdropPicker";
import { CaptionStyleFields } from "@/components/CaptionStyleFields";
import { CAPTION_FONT_STACKS, restoredCaptionStyle } from "@/lib/caption-style";
import { api, isDarkHex } from "@/lib/client";
import { MAX_PRONUNCIATIONS, formatPronunciations, parsePronunciations } from "@/lib/pronounce";
import { MAX_FORCED_TRANSLATIONS, MAX_FORCED_TRANSLATION_LENGTH, MAX_GLOSSARY_TERMS, MAX_GLOSSARY_TERM_LENGTH, MIN_GLOSSARY_TERM_LENGTH, formatForcedTranslations, parseForcedTranslations, parseGlossary } from "@/lib/glossary";
import { LOGO_TYPES, logoDataUrlValid, logoFileType } from "@/lib/logo-types";
import type { BrandSuggestion } from "@/lib/brand-import";
import { DEFAULT_CAPTION_STYLE, MAX_CLOSING_SCRIPT, MAX_SCENE_TEXT, backdropIdOf, isDefaultCaptionStyle, type CaptionStyle, footageIdOf, footageLength, footagePath, type FootageJob, type AspectRatio, type Avatar, type Backdrop, type BrandKit, type Resolution, type Voice, type WatermarkCorner } from "@/lib/types";

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
  // "clip" is a video background that is one of the account's generated clips (the B-roll page), picked from a list.
  const [bgType, setBgType] = useState<"" | "image" | "video" | "clip">("");
  const [bgUrl, setBgUrl] = useState("");
  const [bgWhole, setBgWhole] = useState(false);
  // Uploaded images, so the kit's default background can be one of them like any scene's.
  const { data: backdropData, error: backdropError, setData: setBackdropData } = useApi<{ backdrops: Backdrop[] }>("/api/backdrops");
  const { data: footageData } = useApi<{ footage: Array<Pick<FootageJob, "id" | "title" | "status" | "durationSec" | "autoLength" | "aspect">>; available: boolean }>("/api/footage");
  const readyFootage = (footageData?.footage ?? []).filter((f) => f.status === "completed");
  // An uploaded image that is gone (deleted here, or elsewhere and so taken off the saved kit) is not offered for saving.
  useEffect(() => {
    if (!backdropData) return;
    const id = backdropIdOf({ type: "image", value: bgUrl });
    if (id && !backdropData.backdrops.some((b) => b.id === id)) {
      setBgUrl("");
      setBgType("");
    }
  }, [backdropData, bgUrl]);
  // Likewise a generated clip deleted since (here or in another tab) is let go of, rather than failing the save.
  useEffect(() => {
    if (!footageData) return;
    const id = footageIdOf({ type: "video", value: bgUrl });
    if (id && !footageData.footage.some((f) => f.id === id)) {
      setBgUrl("");
      setBgType("");
    }
  }, [footageData, bgUrl]);
  const [pronunciations, setPronunciations] = useState("");
  const [glossary, setGlossary] = useState("");
  const [forced, setForced] = useState("");
  const [logoNotice, setLogoNotice] = useState<string | null>(null);
  const [avatarId, setAvatarId] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [aspect, setAspect] = useState<AspectRatio | "">("");
  const [resolution, setResolution] = useState<Resolution | "">("");
  const [captions, setCaptions] = useState(false);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(DEFAULT_CAPTION_STYLE);
  const [watermark, setWatermark] = useState<WatermarkCorner | "">("");
  const [closingScript, setClosingScript] = useState("");
  const [closingText, setClosingText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Shown next to the Save button, where the person is when a save is refused (the banner at the top is out of view).
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Filling the form from a company's website, as HeyGen imports a brand kit from one; nothing is saved until Save.
  const [site, setSite] = useState("");
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const hydrated = useRef(false);

  // Load the saved kit into the form once.
  useEffect(() => {
    if (hydrated.current || !brandData) return;
    hydrated.current = true;
    const b = brandData.brand;
    if (!b) return;
    setName(b.name);
    // A logo saved before only displayable types were accepted is left out (and said so), so the rest of the kit can still be saved.
    if (b.logoUrl?.startsWith("data:") && !logoDataUrlValid(b.logoUrl)) {
      setLogoNotice("The saved logo is in a format or encoding the share page cannot show, so saving will remove it. Upload a PNG, JPEG, WebP, GIF, SVG, AVIF, BMP, or ICO logo to replace it.");
    } else {
      setLogoUrl(b.logoUrl ?? "");
    }
    setPrimary(b.primaryColor);
    setAccent(b.accentColor ?? "");
    setBgType(b.defaultBackground && b.defaultBackground.type !== "color" ? (footageIdOf(b.defaultBackground) ? "clip" : b.defaultBackground.type) : "");
    setBgUrl(b.defaultBackground && b.defaultBackground.type !== "color" ? b.defaultBackground.value : "");
    setBgWhole(b.defaultBackground?.fit === "contain");
    setPronunciations(formatPronunciations(b.pronunciations ?? []));
    setGlossary((b.glossary ?? []).join("\n"));
    setForced(formatForcedTranslations(b.forcedTranslations));
    setAvatarId(b.defaultAvatarId ?? "");
    setVoiceId(b.defaultVoiceId ?? "");
    setAspect(b.defaultAspect ?? "");
    setResolution(b.defaultResolution ?? "");
    setCaptions(!!b.captionsByDefault);
    setCaptionStyle(restoredCaptionStyle(b.captionStyle));
    setWatermark(b.watermark ?? "");
    setClosingScript(b.closingScene?.script ?? "");
    setClosingText(b.closingScene?.text ?? "");
    setSavedAt(b.updatedAt);
  }, [brandData]);

  function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setErr("Please choose a logo under 2 MB.");
      return;
    }
    const type = logoFileType(file);
    if (!type) {
      setErr("Please choose a PNG, JPEG, WebP, GIF, SVG, AVIF, BMP, or ICO logo.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // A browser that reports no type reads the file as application/octet-stream; label it with the type read from its name.
      setLogoUrl(String(reader.result).replace(/^data:[^;,]*/, `data:${type}`));
      setLogoNotice(null);
    };
    reader.readAsDataURL(file);
  }

  // The form as it stands now, read when the website's answer arrives (the person may have typed meanwhile).
  const formNow = useRef({ name, logoUrl, primary, accent });
  formNow.current = { name, logoUrl, primary, accent };

  async function importSite() {
    if (!site.trim() || importing) return;
    setImporting(true);
    setImportErr(null);
    setImportNote(null);
    setErr(null);
    try {
      const { suggestion: s } = await api<{ suggestion: BrandSuggestion }>("/api/brand/import", { method: "POST", body: JSON.stringify({ url: site.trim() }) });
      const host = new URL(s.sourceUrl).host;
      const { name, logoUrl, primary, accent } = formNow.current;
      // What is already filled in (typed, uploaded, or saved) is replaced only when the person agrees.
      const colours = !!s.primaryColor && (primary.toLowerCase() !== DEFAULT_PRIMARY || !!accent) && (primary.toLowerCase() !== s.primaryColor || (accent || undefined) !== s.accentColor);
      const clashes = [s.name && name.trim() && name.trim() !== s.name ? "name" : "", s.logoUrl && logoUrl && logoUrl !== s.logoUrl ? "logo" : "", colours ? "colours" : ""].filter(Boolean);
      const replace = !clashes.length || window.confirm(`Replace your ${clashes.join(" and ").replace(/ and (?=.* and )/, ", ")} with the ones from ${host}? Cancel keeps yours and fills in only what is empty.`);
      const found: string[] = [];
      if (s.name && (replace || !name.trim())) (setName(s.name), found.push("the name"));
      if (s.logoUrl && (replace || !logoUrl)) (setLogoUrl(s.logoUrl), setLogoNotice(null), found.push("a logo"));
      if (s.primaryColor && (replace || !colours)) {
        setPrimary(s.primaryColor);
        setAccent(s.accentColor ?? "");
        found.push(s.accentColor ? "two colours" : "a colour");
      }
      setImportNote(found.length ? `Filled in ${found.join(", ").replace(/, ([^,]*)$/, " and $1")} from ${host}. Check them, then save the brand kit.` : `Kept what you had; ${host} offered nothing for the empty fields.`);
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : "The website could not be read");
    } finally {
      setImporting(false);
    }
  }

  const primaryValid = HEX.test(primary);
  const accentValid = accent === "" || HEX.test(accent);

  async function save() {
    const { rules, bad, badLanguage } = parsePronunciations(pronunciations);
    if (bad.length) {
      setSaveErr(`Pronunciation, line ${bad[0]}: write it as word = how to say it, with [Language] at the end for one language only.`);
      return;
    }
    if (badLanguage.length) {
      setSaveErr(`Pronunciation, line ${badLanguage[0].line}: "${badLanguage[0].language.slice(0, 30)}" is not a language name (for example [French] or [Spanish]).`);
      return;
    }
    if (rules.length > MAX_PRONUNCIATIONS) {
      setSaveErr(`Up to ${MAX_PRONUNCIATIONS} pronunciations (you have ${rules.length}).`);
      return;
    }
    const badRule = rules.find((r) => r.word.length > 40 || r.sayAs.length > 80 || (r.language?.length ?? 0) > 40);
    if (badRule) {
      setSaveErr(`Pronunciation "${badRule.word.slice(0, 20)}": the word is at most 40 characters, the spelling at most 80, and the language at most 40.`);
      return;
    }
    const terms = parseGlossary(glossary);
    if (terms.length > MAX_GLOSSARY_TERMS) {
      setSaveErr(`Up to ${MAX_GLOSSARY_TERMS} terms to keep untranslated (you have ${terms.length}).`);
      return;
    }
    const longTerm = terms.find((t) => t.length > MAX_GLOSSARY_TERM_LENGTH);
    if (longTerm) {
      setSaveErr(`"${longTerm.slice(0, 20)}…": a term to keep untranslated is at most ${MAX_GLOSSARY_TERM_LENGTH} characters.`);
      return;
    }
    // A one-letter term would hold back every "a" or "I" in a script.
    const shortTerm = terms.find((t) => t.length < MIN_GLOSSARY_TERM_LENGTH);
    if (shortTerm) {
      setSaveErr(`"${shortTerm}": a term to keep untranslated is at least ${MIN_GLOSSARY_TERM_LENGTH} characters.`);
      return;
    }
    const parsed = parseForcedTranslations(forced);
    if (parsed.bad.length) {
      setSaveErr(`Always translate, line ${parsed.bad[0]}: write it as term = translation, with [Language] at the end for one language only.`);
      return;
    }
    if (parsed.badLanguage.length) {
      setSaveErr(`Always translate, line ${parsed.badLanguage[0].line}: "${parsed.badLanguage[0].language.slice(0, 30)}" is not a language name (for example [German] or [Spanish (Mexico)]).`);
      return;
    }
    if (parsed.rules.length > MAX_FORCED_TRANSLATIONS) {
      setSaveErr(`Up to ${MAX_FORCED_TRANSLATIONS} translation rules (you have ${parsed.rules.length}).`);
      return;
    }
    const badForced = parsed.rules.find((r) => r.term.length < MIN_GLOSSARY_TERM_LENGTH || r.term.length > MAX_GLOSSARY_TERM_LENGTH || r.translation.length > MAX_FORCED_TRANSLATION_LENGTH || (r.language !== undefined && (r.language.length < 2 || r.language.length > 40)));
    if (badForced) {
      setSaveErr(`Always translate "${badForced.term.slice(0, 20)}": the term is ${MIN_GLOSSARY_TERM_LENGTH} to ${MAX_GLOSSARY_TERM_LENGTH} characters, the translation at most ${MAX_FORCED_TRANSLATION_LENGTH}, and a language 2 to 40.`);
      return;
    }
    setSaving(true);
    setSaveErr(null);
    try {
      const { brand } = await api<{ brand: BrandKit }>("/api/brand", {
        method: "PUT",
        body: JSON.stringify({
          name,
          logoUrl,
          primaryColor: primary,
          accentColor: accent || undefined,
          defaultBackground: bgType && bgUrl.trim() ? { type: bgType === "clip" ? "video" : bgType, value: bgUrl.trim(), ...(bgWhole ? { fit: "contain" } : {}) } : undefined,
          pronunciations: rules,
          glossary: terms,
          forcedTranslations: parsed.rules,
          defaultAvatarId: avatarId || undefined,
          defaultVoiceId: voiceId || undefined,
          defaultAspect: aspect || undefined,
          defaultResolution: resolution || undefined,
          captionsByDefault: captions,
          captionStyle: isDefaultCaptionStyle(captionStyle) ? undefined : captionStyle,
          watermark: (logoUrl && watermark) || undefined,
          closingScene: closingScript.trim() || closingText.trim() ? { script: closingScript, text: closingText } : undefined,
        }),
      });
      setSavedAt(brand.updatedAt);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not save the brand kit");
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
      setBgWhole(false);
      setPronunciations("");
      setGlossary("");
      setForced("");
      setCaptions(false);
      setCaptionStyle(DEFAULT_CAPTION_STYLE);
      setWatermark("");
      setClosingScript("");
      setClosingText("");
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
          <section aria-labelledby="brand-import-title">
            <h3 id="brand-import-title" className="mb-1.5 block text-sm font-medium text-slate-700">Fill from a website</h3>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                importSite();
              }}
            >
              <input aria-label="Website address" value={site} onChange={(e) => setSite(e.target.value)} placeholder="acme.com" maxLength={2000} className={inputClass} disabled={loading || canEdit === false} />
              <Button type="submit" variant="secondary" loading={importing} disabled={!site.trim() || loading || canEdit === false}>
                <Globe className="h-4 w-4" /> Fill in
              </Button>
            </form>
            <span role="status" className="mt-2 block text-xs empty:hidden" data-testid="brand-import-status">
              {importErr ? <span className="text-rose-700">{importErr}</span> : importNote ? <span className="text-emerald-700">{importNote}</span> : null}
            </span>
            <p className="mt-1 text-xs text-slate-500">Reads the brand name, logo, and colours your website declares, for you to check before saving.</p>
          </section>
          <Field label="Brand name" hint="Shown in the header of shared videos.">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Realty" maxLength={80} className={inputClass} disabled={loading} />
          </Field>
          <Field label="Logo" hint="PNG or SVG with a transparent background looks best. Upload a file or paste an image URL.">
            {logoNotice && (
              <span role="status" className="mb-2 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="logo-notice">
                {logoNotice}
              </span>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoUrl} alt="Logo preview" className="h-full w-full object-contain p-1" onError={() => setLogoNotice("That logo could not be loaded; paste another image URL or upload the file.")} />
                ) : (
                  <Palette className="h-5 w-5 text-slate-300" />
                )}
              </div>
              <input ref={fileRef} type="file" accept={[...LOGO_TYPES].join(",")} className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Upload logo
              </Button>
              <input
                aria-label="Logo URL"
                value={logoUrl.startsWith("data:") ? "" : logoUrl}
                onChange={(e) => {
                  setLogoUrl(e.target.value);
                  // The stored logo is only replaced once there is a new one; an emptied field still removes it.
                  if (e.target.value.trim()) setLogoNotice(null);
                  // An emptied logo takes the player corner with it, as the Clear button does.
                  if (!e.target.value.trim()) setWatermark("");
                }}
                placeholder={logoUrl.startsWith("data:") ? "Uploaded file" : "https://example.com/logo.png"}
                className={`${inputClass} min-w-[200px] flex-1`}
              />
              {logoUrl && (
                <button
                  type="button"
                  onClick={() => {
                    // With no logo there is nothing to lay over the player; a corner kept here would quietly come back with the next logo.
                    setLogoUrl("");
                    setWatermark("");
                  }}
                  className="text-xs text-slate-500 hover:text-slate-900"
                >
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
              <select
                aria-label="Default background"
                value={bgType}
                onChange={(e) => {
                  const next = e.target.value as typeof bgType;
                  // An uploaded image's or a clip's path means nothing as a URL of another kind: start that field empty.
                  if (next !== "image" && backdropIdOf({ type: "image", value: bgUrl })) setBgUrl("");
                  if (next !== "clip" && footageIdOf({ type: "video", value: bgUrl })) setBgUrl("");
                  if (next === "clip" && !footageIdOf({ type: "video", value: bgUrl })) setBgUrl("");
                  setBgType(next);
                }}
                className={inputClass}
              >
                <option value="">Primary colour</option>
                <option value="image">Image (uploaded or by URL)</option>
                <option value="video">Video URL</option>
                {(readyFootage.length > 0 || bgType === "clip") && <option value="clip">Generated clip</option>}
              </select>
            </Field>
            {bgType === "clip" && (
              <div>
                <label htmlFor="brand-clip" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Generated clip
                </label>
                <select id="brand-clip" aria-describedby="brand-clip-hint" value={footageIdOf({ type: "video", value: bgUrl }) ?? ""} onChange={(e) => setBgUrl(e.target.value ? footagePath(e.target.value) : "")} className={inputClass}>
                  <option value="">Choose a clip</option>
                  {readyFootage.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.title} ({footageLength(f)}{f.aspect ? `, ${f.aspect}` : ""})
                    </option>
                  ))}
                  {footageIdOf({ type: "video", value: bgUrl }) && !readyFootage.some((f) => f.id === footageIdOf({ type: "video", value: bgUrl })) && <option value={footageIdOf({ type: "video", value: bgUrl })!}>A clip that is gone or not ready</option>}
                </select>
                <p id="brand-clip-hint" className="mt-1 text-xs text-slate-500">
                  A clip made on the B-roll page, looped behind the presenter in every new video; the kit cannot be saved without one.
                </p>
              </div>
            )}
            {bgType && bgType !== "clip" && !(bgType === "image" && backdropIdOf({ type: "image", value: bgUrl })) && (
              <Field label={bgType === "video" ? "Background video URL" : "Background image URL"} hint={bgType === "image" ? "A public URL, or pick one of your images below; the kit cannot be saved without one." : "A public URL; the kit cannot be saved while this is empty."}>
                <input aria-label="Default background URL" value={bgUrl} onChange={(e) => setBgUrl(e.target.value)} placeholder={bgType === "video" ? "https://…/loop.mp4" : "https://…/background.jpg"} className={inputClass} maxLength={2000} />
              </Field>
            )}
          </div>
          {bgType && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={bgWhole} onChange={(e) => setBgWhole(e.target.checked)} className="accent-brand-600" />
              Show all of it instead of cropping it to fill the frame (in the editor preview; HeyGen renders fill the frame)
            </label>
          )}
          {bgType === "image" && (
            <BackdropPicker
              value={{ type: "image", value: bgUrl }}
              onChange={(bg) => setBgUrl(bg.value)}
              backdrops={backdropData?.backdrops ?? []}
              setBackdrops={(update) => setBackdropData((d) => ({ backdrops: update(d?.backdrops ?? []) }))}
              loadError={backdropError}
              canEdit={canEdit !== false}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default aspect ratio">
              <select value={aspect} onChange={(e) => setAspect(e.target.value as AspectRatio | "")} className={inputClass}>
                <option value="">No default (16:9)</option>
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
            <Field label="Logo on the player" hint={logoUrl ? "Laid over the share page and embed player of every video (not in fullscreen); the video file itself is not changed." : "Add a logo above to show it on the player."}>
              <select value={logoUrl ? watermark : ""} disabled={!logoUrl} onChange={(e) => setWatermark(e.target.value as WatermarkCorner | "")} className={inputClass}>
                <option value="">Off</option>
                <option value="top-left">Top left</option>
                <option value="top-right">Top right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="bottom-right">Bottom right</option>
              </select>
            </Field>
          </div>
          <div className="rounded-lg border border-slate-200 px-3 py-3" data-testid="brand-caption-style">
            <div className="text-sm font-medium text-slate-800">Caption style</div>
            <div className="mt-0.5 text-xs text-slate-500">
              Where subtitles sit in new videos, how big they read, and how they look in the share player; each video can change it in the editor. A style other than the default is shown in the share player only: HeyGen then leaves captions out of the video file.
            </div>
            <CaptionStyleFields value={captionStyle} onChange={setCaptionStyle} />
          </div>
          <Field label="Pronunciation" hint="One per line, word = how to say it (for example Nair = Nye-er), with [Language] at the end for one language only (Nair = Naïr [French]); it then applies where the voice speaks that language and beats a rule for every language. Renders say it that way; scripts and captions keep the spelling. Up to 50.">
            <textarea aria-label="Pronunciation" value={pronunciations} onChange={(e) => setPronunciations(e.target.value)} rows={3} placeholder={"Nair = Nye-er\nNair = Naïr [French]\nSaaS = sass"} className={`${inputClass} font-mono text-xs`} />
          </Field>
          <Field label="Never translate" hint="One term per line: product names, slogans, handles. Translating a script, adding a subtitle language, or a dub that keeps the glossary leaves each one exactly as written (matched whole, ignoring case). Up to 50.">
            <textarea aria-label="Never translate" value={glossary} onChange={(e) => setGlossary(e.target.value)} rows={3} placeholder={"Acme Cloud\nNimbus"} className={`${inputClass} font-mono text-xs`} />
          </Field>
          <Field label="Always translate as" hint="One rule per line, term = translation; add [Language] at the end for a rule in that language only. Translations, subtitle languages, and dubs that keep the glossary use the translation word for word, so pick a form that reads right without inflection. Up to 50.">
            <textarea aria-label="Always translate as" value={forced} onChange={(e) => setForced(e.target.value)} rows={3} placeholder={"CEO = Geschäftsführer [German]\nfree trial = essai gratuit [French]"} className={`${inputClass} font-mono text-xs`} />
          </Field>
          <fieldset aria-describedby="closing-scene-about" className="space-y-3 rounded-lg border border-slate-200 p-4">
            <legend className="px-1 text-sm font-medium text-slate-800">Closing scene</legend>
            <p id="closing-scene-about" className="text-xs text-slate-500">The editor&apos;s Closing scene button puts this at the end of a video, on the brand background: a call to action, how to get in touch. Leave both blank for none.</p>
            <Field label="What the presenter says" hintId="closing-script-hint" hint={`Up to ${MAX_CLOSING_SCRIPT} characters; [pause 1s] markers work as in a scene.`}>
              <textarea aria-label="What the presenter says" aria-describedby="closing-script-hint" value={closingScript} onChange={(e) => setClosingScript(e.target.value)} rows={2} maxLength={MAX_CLOSING_SCRIPT} placeholder="Thanks for watching. Call us today to book your private showing." className={inputClass} />
            </Field>
            <Field label="On-screen text" hintId="closing-text-hint" hint={`Shown at the bottom of the closing scene, up to ${MAX_SCENE_TEXT} characters; about 20 fit across a portrait or square frame (the editor uses a smaller size when needed). No renderer draws on-screen text yet; the editor and the share page's chapters show it.`}>
              <input aria-label="On-screen text" aria-describedby="closing-text-hint" value={closingText} onChange={(e) => setClosingText(e.target.value)} placeholder="acme.com · 555-0100" className={inputClass} />
            </Field>
          </fieldset>
          <ErrorBanner message={saveErr} />
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
              className={`mx-4 mb-4 flex aspect-video justify-center rounded-lg p-3 text-xs ${captions && captionStyle.position === "top" ? "items-start" : "items-end"} ${isDarkHex(primaryValid ? primary : DEFAULT_PRIMARY) ? "text-white/90" : "text-slate-800"}`}
              style={{ background: primaryValid ? primary : DEFAULT_PRIMARY }}
            >
              <span className="rounded bg-black/40 px-2 py-1 text-white" style={captions ? { fontFamily: CAPTION_FONT_STACKS[captionStyle.font ?? "sans"] } : undefined}>
                {captions ? "Captions on" : "Scene background"}
              </span>
            </div>
          </Card>
          <Card className="p-4 text-sm text-slate-600">
            <h3 className="mb-2 font-semibold text-slate-900">Applied to new videos</h3>
            <ul className="space-y-1 text-xs">
              <li>Avatar: {avatarName ?? "first in the library"}</li>
              <li>Voice: {voiceName ?? "first in the library"}</li>
              <li>Aspect: {aspect || "16:9"}</li>
              <li>Quality: {resolution || "1080p"}</li>
              <li>Captions: {captions ? "on" : "off"}, {captionStyle.position}, {captionStyle.size}, {captionStyle.look ?? "classic"}, {captionStyle.font ?? "sans"}</li>
              <li>Background: {bgType === "clip" && bgUrl.trim() ? "generated clip" : bgType === "video" && bgUrl.trim() ? "looping video" : bgType === "image" && bgUrl.trim() ? (backdropIdOf({ type: "image", value: bgUrl.trim() }) ? "uploaded image" : "image") : primaryValid ? primary : DEFAULT_PRIMARY}</li>
            </ul>
            <p className="mt-3 text-xs text-slate-500">Templates keep their own aspect ratio; copies keep every setting of the original.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
