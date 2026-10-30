"use client";
import Link from "next/link";
import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { LayoutTemplate, Pencil, Trash2 } from "lucide-react";
import { Card, ErrorBanner, SectionTitle, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { ApiError, api } from "@/lib/client";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
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

  const canEdit = useCanEdit();
  const { data: mine, error, refetch, setData } = useApi<{ templates: VideoTemplate[] }>("/api/templates");
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The same words again (a second save under one name) would not change the region, so it is emptied first.
  const announce = (message: string) => {
    setNote(null);
    requestAnimationFrame(() => setNote(message));
  };
  // A deleted template's card (and the button pressed) is gone; the focus moves to the list's heading.
  const mineHeading = useRef<HTMLHeadingElement>(null);
  async function remove(t: VideoTemplate) {
    if (!window.confirm(`Delete the template "${t.title}"?`)) return;
    setRemoveErr(null);
    setNote(null);
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
      {canEdit === false && <ViewOnlyNotice what="change or delete your saved templates" />}
      <ErrorBanner message={error ?? removeErr} />
      {/* Always in the tree, so its first message is announced; the visible copy sits beside it. */}
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      {note && (
        <p aria-hidden className="mb-3 text-sm text-slate-600" data-testid="templates-note">
          {note}
        </p>
      )}
      <section className="mb-8" data-testid="my-templates">
        <h2 ref={mineHeading} tabIndex={-1} className="mb-1 text-sm font-semibold text-slate-900 focus:outline-none">My templates</h2>
        <p className="mb-4 text-xs text-slate-500">Save any video as a template from its page: scenes, presenter, voice, and settings come along.</p>
        {mine && mine.templates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">No saved templates yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(mine?.templates ?? []).map((t) => (
              <MyTemplateCard
                key={t.id}
                template={t}
                canEdit={canEdit === true}
                fallbackFocus={mineHeading}
                onSaved={(saved) => {
                  setRemoveErr(null);
                  setData((prev) => (prev ? { templates: prev.templates.map((x) => (x.id === saved.id ? saved : x)) } : prev));
                  announce(`Saved the template “${saved.title}”.`);
                  // A list read before the save could still land and show the old name; read it again after it.
                  void refetch();
                }}
                onGone={() => {
                  announce(`The template “${t.title}” is no longer available.`);
                  void refetch().then(() => refocusIfLost(mineHeading.current));
                }}
                onDelete={() => remove(t)}
              />
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

/** One saved template: use it, or (for editors) change its name and description in place, or delete it. */
function MyTemplateCard(props: {
  template: VideoTemplate;
  canEdit: boolean;
  fallbackFocus: React.RefObject<HTMLElement | null>;
  onSaved: (t: VideoTemplate) => void;
  onGone: () => void;
  onDelete: () => void;
}) {
  const t = props.template;
  const [editing, setEditing] = useState(false);
  // What the form opened with: only the fields changed from these are sent, so a rename someone else saved meanwhile
  // is not undone by a description edit here.
  const opened = useRef({ title: t.title, description: t.description ?? "" });
  const [title, setTitle] = useState(t.title);
  const [description, setDescription] = useState(t.description ?? "");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  const ids = useId();
  // Opening the form puts the focus in the name; closing it, saved or not, puts it back on the Edit button (or the
  // list's heading, when the button is gone).
  useEffect(() => {
    if (editing) {
      wasEditing.current = true;
      titleInput.current?.focus();
    } else if (wasEditing.current) {
      wasEditing.current = false;
      if (editButton.current) editButton.current.focus();
      else refocusIfLost(props.fallbackFocus.current);
    }
  }, [editing, props.fallbackFocus]);
  // A save from elsewhere while the form is open: fields not touched here follow it.
  useEffect(() => {
    if (!editing) return;
    const was = opened.current;
    const next = { title: t.title, description: t.description ?? "" };
    if (was.title === next.title && was.description === next.description) return;
    opened.current = next;
    setTitle((cur) => (cur === was.title ? next.title : cur));
    setDescription((cur) => (cur === was.description ? next.description : cur));
  }, [editing, t.title, t.description]);
  const open = () => {
    const now = { title: t.title, description: t.description ?? "" };
    opened.current = now;
    setTitle(now.title);
    setDescription(now.description);
    setFormErr(null);
    setEditing(true);
  };
  const close = () => {
    if (saving) return;
    setFormErr(null);
    setEditing(false);
  };
  const fail = (message: string) => {
    setFormErr(message);
    titleInput.current?.focus();
  };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const name = title.trim();
    if (!name) return fail("Name the template");
    const change: { title?: string; description?: string | null } = {};
    if (name !== opened.current.title) change.title = name;
    if (description.trim() !== opened.current.description.trim()) change.description = description.trim() || null;
    if (!Object.keys(change).length) return close();
    setSaving(true);
    setFormErr(null);
    try {
      const { template } = await api<{ template: VideoTemplate }>(`/api/templates/${t.id}`, { method: "PATCH", body: JSON.stringify(change) });
      props.onSaved(template);
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) props.onGone();
      else fail(err instanceof Error ? err.message : "The template could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col p-5" data-testid="my-template">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
          <LayoutTemplate className="h-4 w-4" />
        </span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
          {t.aspect} · {t.scenes.length} {t.scenes.length === 1 ? "scene" : "scenes"}
        </span>
      </div>
      <h3 className="mt-3 text-sm font-semibold text-slate-900">{t.title}</h3>
      {editing ? (
        <form
          onSubmit={save}
          onKeyDown={(e) => {
            // Not mid-save, not while an input method composes, and not from the description box, where Escape
            // would throw away what was typed.
            if (e.key !== "Escape" || saving || e.nativeEvent.isComposing || (e.target as HTMLElement).tagName === "TEXTAREA") return;
            e.preventDefault();
            close();
          }}
          aria-label={`Edit template ${t.title}`}
          className="mt-2 flex flex-1 flex-col gap-2"
        >
          <label htmlFor={`${ids}-title`} className="text-xs font-medium text-slate-700">
            Template name
          </label>
          <input
            ref={titleInput}
            id={`${ids}-title`}
            className={inputClass}
            value={title}
            maxLength={120}
            required
            aria-invalid={formErr ? true : undefined}
            aria-describedby={formErr ? `${ids}-error` : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
          {formErr && (
            <p id={`${ids}-error`} role="alert" className="text-xs text-rose-700">
              {formErr}
            </p>
          )}
          <label htmlFor={`${ids}-description`} className="text-xs font-medium text-slate-700">
            Description <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <textarea id={`${ids}-description`} className={inputClass} rows={2} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
          <div className="mt-2 flex items-center gap-2">
            {/* Not disabled while saving, so the focus stays on it; a second press is ignored. */}
            <button type="submit" aria-disabled={saving || undefined} className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 aria-disabled:opacity-60">
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={close} aria-disabled={saving || undefined} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 aria-disabled:opacity-60">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {t.description && <p className="mt-1 text-xs text-slate-500">{t.description}</p>}
          <p className="mt-3 line-clamp-4 flex-1 text-xs leading-relaxed text-slate-600">{stripPauses(t.scenes.find((sc) => stripPauses(sc.script).trim())?.script ?? "").trim()}</p>
          <div className="mt-4 flex items-center gap-2">
            <Link href={`/create?template=${t.id}`} className="inline-flex flex-1 items-center justify-center rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Use template
            </Link>
            {props.canEdit && (
              <>
                <button ref={editButton} type="button" onClick={open} aria-label={`Edit template ${t.title}`} title="Edit name and description" className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-brand-700">
                  <Pencil className="h-4 w-4" aria-hidden />
                </button>
                <button type="button" onClick={props.onDelete} aria-label={`Delete template ${t.title}`} title="Delete" className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700">
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </Card>
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
