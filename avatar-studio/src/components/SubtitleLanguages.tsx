"use client";
import { useState } from "react";
import { Languages, Trash2 } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { api } from "@/lib/client";
import type { Video } from "@/lib/types";

/** Translated subtitle tracks: add a language (translated by the script provider), download, or remove one. */
export function SubtitleLanguages({ video, onUpdated }: { video: Video; onUpdated: (video: Video) => void }) {
  const [language, setLanguage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const languages = Object.keys(video.subtitles ?? {});

  async function add() {
    const name = language.trim();
    if (!name || busy) return;
    setBusy("add");
    setErr(null);
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}/subtitles`, { method: "POST", body: JSON.stringify({ language: name }) });
      onUpdated(next);
      setLanguage("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not translate the subtitles");
    } finally {
      setBusy(null);
    }
  }

  async function remove(name: string) {
    if (busy) return;
    setBusy(name);
    setErr(null);
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}/subtitles?language=${encodeURIComponent(name)}`, { method: "DELETE" });
      onUpdated(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove the subtitles");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-4" data-testid="subtitle-languages">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Languages className="h-4 w-4 text-slate-400" /> Subtitle languages
      </h3>
      <p className="mt-1 text-xs text-slate-500">The script translated by the AI writer, offered in the share page&apos;s subtitle menu; up to five languages.</p>
      {languages.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100" data-testid="subtitle-list">
          {languages.map((name) => (
            <li key={name} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="font-medium text-slate-800">{name}</span>
              <span className="flex items-center gap-2">
                <a href={`/api/videos/${video.id}/captions?lang=${encodeURIComponent(name)}`} download className="text-xs text-brand-700 hover:underline">
                  Download .srt
                </a>
                <button type="button" onClick={() => remove(name)} disabled={!!busy} aria-label={`Remove ${name} subtitles`} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700">
                  <Trash2 className="h-4 w-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input aria-label="Subtitle language" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Spanish" maxLength={40} className={`${inputClass} w-44`} />
        <Button type="submit" className="px-3 py-1.5 text-xs" loading={busy === "add"} disabled={!language.trim() || languages.length >= 5}>
          Add subtitles
        </Button>
        {err && <span className="text-xs text-rose-600">{err}</span>}
      </form>
    </Card>
  );
}
