"use client";
import Link from "next/link";
import { Suspense, useMemo, useRef, useState } from "react";
import { LayoutTemplate, Trash2 } from "lucide-react";
import { Card, ErrorBanner, SectionTitle } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/client";
import { refocusIfLost } from "@/lib/focus";
import { SCRIPT_TEMPLATES, type ScriptTemplate } from "@/lib/templates";
import type { VideoTemplate } from "@/lib/types";
import { stripPauses } from "@/lib/pauses";
import { StudioTemplates } from "@/components/StudioTemplates";

const CATEGORIES = ["All", ...Array.from(new Set(SCRIPT_TEMPLATES.map((t) => t.category)))];

export default function TemplatesPage() {
  const [category, setCategory] = useState("All");
  const items = useMemo(
    () => (category === "All" ? SCRIPT_TEMPLATES : SCRIPT_TEMPLATES.filter((t) => t.category === category)),
    [category],
  );

  const { data: mine, error, refetch } = useApi<{ templates: VideoTemplate[] }>("/api/templates");
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  // A deleted template's card (and the button pressed) is gone; the focus moves to the list's heading.
  const mineHeading = useRef<HTMLHeadingElement>(null);
  async function remove(t: VideoTemplate) {
    if (!window.confirm(`Delete the template "${t.title}"?`)) return;
    setRemoveErr(null);
    try {
      await api(`/api/templates/${t.id}`, { method: "DELETE" });
      await refetch();
      refocusIfLost(mineHeading.current);
    } catch (e) {
      setRemoveErr(e instanceof Error ? e.message : "Could not delete the template");
    }
  }

  return (
    <>
      <SectionTitle title="Templates" subtitle="Start from a proven script. Placeholders in {braces} are yours to fill in." />
      <ErrorBanner message={error ?? removeErr} />
      <section className="mb-8" data-testid="my-templates">
        <h2 ref={mineHeading} tabIndex={-1} className="mb-1 text-sm font-semibold text-slate-900 focus:outline-none">My templates</h2>
        <p className="mb-4 text-xs text-slate-500">Save any video as a template from its page: scenes, presenter, voice, and settings come along.</p>
        {mine && mine.templates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">No saved templates yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(mine?.templates ?? []).map((t) => (
              <Card key={t.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                    <LayoutTemplate className="h-4 w-4" />
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    {t.aspect} · {t.scenes.length} {t.scenes.length === 1 ? "scene" : "scenes"}
                  </span>
                </div>
                <h3 className="mt-3 text-sm font-semibold text-slate-900">{t.title}</h3>
                {t.description && <p className="mt-1 text-xs text-slate-500">{t.description}</p>}
                <p className="mt-3 line-clamp-4 flex-1 text-xs leading-relaxed text-slate-600">{stripPauses(t.scenes.find((sc) => stripPauses(sc.script).trim())?.script ?? "").trim()}</p>
                <div className="mt-4 flex items-center gap-2">
                  <Link href={`/create?template=${t.id}`} className="inline-flex flex-1 items-center justify-center rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">
                    Use template
                  </Link>
                  <button type="button" onClick={() => remove(t)} aria-label={`Delete template ${t.title}`} className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
      <Suspense>
        <StudioTemplates />
      </Suspense>
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Script templates</h2>
      <div className="mb-5 flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${category === c ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((t) => (
          <TemplateCard key={t.id} template={t} />
        ))}
      </div>
    </>
  );
}

function TemplateCard({ template }: { template: ScriptTemplate }) {
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <LayoutTemplate className="h-4 w-4" />
        </span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{template.aspect}</span>
      </div>
      <h3 className="mt-3 text-sm font-semibold text-slate-900">{template.title}</h3>
      <p className="mt-1 text-xs text-slate-500">{template.description}</p>
      <p className="mt-3 line-clamp-4 flex-1 text-xs leading-relaxed text-slate-600">{template.script}</p>
      <Link
        href={`/create?template=${template.id}`}
        className="mt-4 inline-flex items-center justify-center rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Use template
      </Link>
    </Card>
  );
}
