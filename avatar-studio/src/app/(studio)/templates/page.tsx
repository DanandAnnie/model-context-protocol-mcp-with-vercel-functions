"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { LayoutTemplate } from "lucide-react";
import { Card, SectionTitle } from "@/components/ui";
import { SCRIPT_TEMPLATES, type ScriptTemplate } from "@/lib/templates";

const CATEGORIES = ["All", ...Array.from(new Set(SCRIPT_TEMPLATES.map((t) => t.category)))];

export default function TemplatesPage() {
  const [category, setCategory] = useState("All");
  const items = useMemo(
    () => (category === "All" ? SCRIPT_TEMPLATES : SCRIPT_TEMPLATES.filter((t) => t.category === category)),
    [category],
  );

  return (
    <>
      <SectionTitle title="Templates" subtitle="Start from a proven script. Placeholders in {braces} are yours to fill in." />
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
