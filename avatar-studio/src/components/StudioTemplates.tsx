"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutTemplate } from "lucide-react";
import { Button, Card, ErrorBanner, Field, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { api } from "@/lib/client";
import type { Avatar, StudioTemplate, StudioTemplateDetail, StudioVariable, Video, Voice } from "@/lib/types";

/** "agent_name" → "Agent name": a variable's name as a label. */
const labelOf = (name: string) => {
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
};
const MEDIA: Record<string, string> = { image: "image", video: "video", audio: "audio" };

/**
 * HeyGen Studio templates: layouts made in HeyGen Studio with named slots, listed from the renderer's account. Choosing
 * one opens its form, one field per slot (text, a link to an image, video, or audio, a voice, a presenter), each starting
 * from the template's own; rendering makes a library video of it.
 */
export function StudioTemplates() {
  const params = useSearchParams();
  const { data, error } = useApi<{ templates: StudioTemplate[]; available: boolean }>("/api/studio-templates");
  const [open, setOpen] = useState<string | null>(params.get("studio"));
  if (!data?.available && !error) return null;
  const templates = data?.templates ?? [];

  return (
    <section className="mb-8" data-testid="studio-templates">
      <h2 className="mb-1 text-sm font-semibold text-slate-900">HeyGen templates</h2>
      <p className="mb-4 text-xs text-slate-500">Layouts made in HeyGen Studio and marked for the API: fill in their text, pictures, presenter, and voice, and render them here.</p>
      <ErrorBanner message={error} />
      {data && templates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">No HeyGen templates yet. Make one in HeyGen Studio and mark it for the API.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id} className="flex min-w-0 flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                {t.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={t.thumbnailUrl} alt="" className="h-12 w-20 shrink-0 rounded-md bg-slate-100 object-cover" />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600">
                    <LayoutTemplate className="h-4 w-4" />
                  </span>
                )}
                {t.aspect && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{t.aspect}</span>}
              </div>
              <h3 className="mt-3 break-words text-sm font-semibold text-slate-900">{t.name}</h3>
              <Button variant={open === t.id ? "secondary" : "primary"} className="mt-4" onClick={() => setOpen(t.id)} aria-label={`Fill in ${t.name}`} aria-expanded={open === t.id}>
                Fill in
              </Button>
            </Card>
          ))}
        </div>
      )}
      {open && <StudioTemplateForm key={open} id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function StudioTemplateForm({ id, onClose }: { id: string; onClose: () => void }) {
  const formId = useId();
  const router = useRouter();
  const canEdit = useCanEdit();
  const { data, error } = useApi<{ template: StudioTemplateDetail }>(`/api/studio-templates/${encodeURIComponent(id)}`);
  const { data: avatarData } = useApi<{ avatars: Avatar[] }>("/api/avatars");
  const { data: voiceData } = useApi<{ voices: Voice[] }>("/api/voices");
  const template = data?.template;
  const [title, setTitle] = useState("");
  const [captions, setCaptions] = useState(false);
  // What has been typed or chosen, by variable name; a slot left alone keeps the template's own.
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Once the template has loaded, focus moves to its form (opened from a card, or from a video's "Use the template again").
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useFocusAfterRender();
  useEffect(() => {
    if (template) focusAfterRender(() => headingRef.current);
  }, [template, focusAfterRender]);
  useEffect(() => {
    if (!template) return;
    setTitle((t) => t || template.name);
    setValues((v) => {
      const next = { ...v };
      for (const [name, own] of Object.entries(template.variables)) if (own.type === "text" && next[name] === undefined) next[name] = own.content;
      return next;
    });
  }, [template]);

  if (error) return <ErrorBanner message={error} />;
  if (!template) return <p className="mt-4 text-sm text-slate-500">Loading the template…</p>;
  const entries = Object.entries(template.variables);
  const missing = entries.filter(([name, v]) => v.type === "text" && !(values[name] ?? "").trim()).map(([name]) => labelOf(name));

  async function render() {
    if (!template) return;
    setBusy(true);
    setErr(null);
    try {
      const variables: Record<string, StudioVariable> = {};
      for (const [name, own] of entries) {
        const typed = (values[name] ?? "").trim();
        if (own.type === "text") variables[name] = { type: "text", content: typed };
        else if (own.type in MEDIA && typed) variables[name] = { type: own.type as "image", asset: { type: "url", url: typed } };
        else if (own.type === "voice" && typed && typed !== own.voice_id) variables[name] = { type: "voice", voice_id: typed };
        else if (own.type === "character" && typed && typed !== own.avatar_id) variables[name] = { type: "character", avatar_id: typed };
      }
      const res = await api<{ video: Video }>(`/api/studio-templates/${encodeURIComponent(template.id)}/videos`, { method: "POST", body: JSON.stringify({ title: title.trim(), captions, variables }) });
      router.push(`/videos/${res.video.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The video could not be started");
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4 p-5" data-testid="studio-template-form">
      <div className="flex items-start justify-between gap-3">
        <h3 ref={headingRef} tabIndex={-1} className="min-w-0 break-words text-sm font-semibold text-slate-900 outline-none">
          {template.name}
          {template.aspect ? <span className="ml-2 font-normal text-slate-500">{template.aspect}</span> : null}
        </h3>
        <button type="button" className="shrink-0 text-xs text-slate-500 hover:underline" onClick={onClose}>
          Close
        </button>
      </div>
      {template.scenes.length > 0 && (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-slate-600" aria-label="The template's scenes">
          {template.scenes.map((sc) => (
            <li key={sc.id} className="break-words">
              {sc.script || "(no script)"}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Video title">
          <input className={inputClass} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} disabled={canEdit === false} />
        </Field>
        {entries.map(([name, own]) => {
          const label = labelOf(name);
          if (own.type === "text") {
            return (
              <Field key={name} label={label} hint={`Fills {{${name}}} in the template.`}>
                <textarea className={`${inputClass} min-h-[72px] resize-y`} value={values[name] ?? ""} maxLength={10000} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} disabled={canEdit === false} />
              </Field>
            );
          }
          if (own.type in MEDIA) {
            const current = "asset" in own && own.asset.type === "url" ? own.asset.url : "";
            return (
              <Field key={name} label={`${label} (${MEDIA[own.type]} link)`} hint="A public https link; leave empty to keep the template's.">
                <input className={inputClass} value={values[name] ?? ""} placeholder={current || `https://…`} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} disabled={canEdit === false} />
              </Field>
            );
          }
          if (own.type === "voice") {
            return (
              <Field key={name} label={`${label} (voice)`}>
                <select className={inputClass} value={values[name] ?? own.voice_id} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} disabled={canEdit === false}>
                  {!voiceData?.voices.some((x) => x.id === own.voice_id) && <option value={own.voice_id}>The template&apos;s voice</option>}
                  {(voiceData?.voices ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Field>
            );
          }
          if (own.type !== "character") return null;
          return (
            <Field key={name} label={`${label} (presenter)`}>
              <select className={inputClass} value={values[name] ?? own.avatar_id} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} disabled={canEdit === false}>
                {!avatarData?.avatars.some((x) => x.id === own.avatar_id) && <option value={own.avatar_id}>The template&apos;s presenter</option>}
                {(avatarData?.avatars ?? []).filter((x) => x.source !== "custom").map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
          );
        })}
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" className="accent-brand-600" checked={captions} onChange={(e) => setCaptions(e.target.checked)} disabled={canEdit === false} />
        Burn in captions
      </label>
      {missing.length > 0 && (
        <p id={`${formId}-missing`} className="mt-3 text-xs text-amber-700">
          Fill in {missing.join(", ")} to render.
        </p>
      )}
      <ErrorBanner message={err} />
      <Button className="mt-4" onClick={render} loading={busy} disabled={canEdit === false || missing.length > 0 || !title.trim()} aria-describedby={missing.length ? `${formId}-missing` : undefined}>
        Render video
      </Button>
    </Card>
  );
}
