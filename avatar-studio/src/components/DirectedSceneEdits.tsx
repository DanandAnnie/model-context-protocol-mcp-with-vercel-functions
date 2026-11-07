"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { ApiError, api } from "@/lib/client";
import { MAX_SCENE_EDIT_CHARS, type DirectedScene, type Video } from "@/lib/types";

/**
 * "Edit scenes" for a finished video HeyGen's Video Agent directed: its scenes are read on request (a heavy read at
 * HeyGen), each with a box for what to change in it; only the scenes described change, and the edited cut is a new video
 * the page then opens. A conflict (the scenes moved on since they were read) offers to read them again.
 */
export function DirectedSceneEdits({ video }: { video: Video }) {
  const id = useId();
  const router = useRouter();
  const focusAfterRender = useFocusAfterRender();
  const [read, setRead] = useState<{ editVersion: string; scenes: DirectedScene[] } | null>(null);
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const described = Object.entries(changes).filter(([, text]) => text.trim().length >= 3);

  async function open() {
    setLoading(true);
    setErr(null);
    try {
      const scenes = await api<{ editVersion: string; scenes: DirectedScene[] }>(`/api/videos/${video.id}/scenes`);
      setRead(scenes);
      // Only now: the button that asked to read them again keeps the focus if this read fails too.
      setStale(false);
      // What was typed for a scene still there is kept when the scenes are read again.
      setChanges((all) => Object.fromEntries(Object.entries(all).filter(([sceneId]) => scenes.scenes.some((s) => s.id === sceneId))));
      focusAfterRender(() => document.getElementById(`${id}-scene-1`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The scenes could not be read");
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    if (!read || !described.length) return;
    setSending(true);
    setErr(null);
    setStale(false);
    try {
      const { video: cut } = await api<{ video: Video }>(`/api/videos/${video.id}/scenes`, {
        method: "POST",
        body: JSON.stringify({ editVersion: read.editVersion, edits: described.map(([sceneId, text]) => ({ sceneId, text: text.trim() })) }),
      });
      router.push(`/videos/${cut.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The changes could not be sent");
      const stored = e instanceof ApiError ? (e.body?.video as Video | undefined) : undefined;
      if (stored?.id) router.push(`/videos/${stored.id}`);
      if (e instanceof ApiError && e.status === 409) setStale(true);
      setSending(false);
    }
  }

  return (
    <Card className="p-5" data-testid="scene-edits">
      <h3 className="text-sm font-semibold text-slate-900">Edit scenes</h3>
      <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
        Describe what to change in the scenes you want different; HeyGen&apos;s Video Agent remakes only those and keeps the rest as they are. The edited cut is a new video, counted like any render; this one stays as it is.
      </p>
      <ErrorBanner message={err} />
      {stale && (
        <Button variant="secondary" className="mt-2" onClick={open} loading={loading}>
          Read the scenes again
        </Button>
      )}
      {!read ? (
        <Button variant="secondary" className="mt-3" onClick={open} loading={loading} aria-describedby={`${id}-hint`}>
          Open the scenes
        </Button>
      ) : (
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <ol className="space-y-4">
            {read.scenes.map((s, i) => (
              <li key={s.id} className="min-w-0 rounded-lg border border-slate-200 p-3">
                <label htmlFor={`${id}-scene-${i + 1}`} className="block text-sm font-medium text-slate-800">
                  What to change in scene {i + 1}
                </label>
                <p id={`${id}-script-${i + 1}`} className="mt-1 text-xs text-slate-600 [overflow-wrap:anywhere]">
                  {s.script ? `It says: “${s.script}”` : "It has no narration."}
                </p>
                <textarea
                  id={`${id}-scene-${i + 1}`}
                  className={`${inputClass} mt-2 min-h-16`}
                  aria-describedby={`${id}-script-${i + 1}`}
                  maxLength={MAX_SCENE_EDIT_CHARS}
                  disabled={sending}
                  placeholder="Leave empty to keep this scene as it is"
                  value={changes[s.id] ?? ""}
                  onChange={(e) => setChanges((all) => ({ ...all, [s.id]: e.target.value }))}
                />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={sending} disabled={!described.length}>
              Make the edited cut
            </Button>
            <span className="text-xs text-slate-500" aria-live="polite">
              {described.length ? `${described.length} of ${read.scenes.length} ${read.scenes.length === 1 ? "scene" : "scenes"} to change` : "Describe a change to at least one scene."}
            </span>
          </div>
        </form>
      )}
    </Card>
  );
}
