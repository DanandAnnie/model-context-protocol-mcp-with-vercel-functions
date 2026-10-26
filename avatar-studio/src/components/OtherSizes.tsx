"use client";
import { useId, useState } from "react";
import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/client";
import { sceneTextFits, type AspectRatio, type Video } from "@/lib/types";

const ASPECTS: AspectRatio[] = ["16:9", "9:16", "1:1"];
const ASPECT_NAMES: Record<AspectRatio, string> = { "16:9": "16:9 landscape", "9:16": "9:16 portrait", "1:1": "1:1 square" };

/**
 * "Make other sizes": renders the video again in the other frame shapes (a portrait cut for stories and reels, a
 * square for feeds), each as a new video with the same scenes and settings. Says which on-screen text would not fit
 * one line in a shape, before anything is rendered. A size made from another video links back to it.
 */
export function OtherSizes({ video, canEdit }: { video: Video; canEdit: boolean }) {
  const id = useId();
  const others = ASPECTS.filter((a) => a !== video.aspect);
  const [chosen, setChosen] = useState<AspectRatio[]>(others);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<Video[]>([]);
  // The original, when there is one: a link to a video since deleted for good would lead nowhere.
  const { data: original, error: originalError } = useApi<{ video: Video }>(video.resizedFrom ? `/api/videos/${video.resizedFrom}` : null);
  const madeAspects = new Set(made.filter((v) => v.status !== "failed").map((v) => v.aspect));
  const tight = (aspect: AspectRatio) => (video.scenes ?? []).map((sc, i) => (sc.overlay && !sceneTextFits(sc.overlay, aspect) ? i + 1 : 0)).filter(Boolean);
  const canMake = canEdit && !video.deletedAt;
  if (!canMake && !video.resizedFrom) return null;

  async function make() {
    setBusy(true);
    setErr(null);
    try {
      const { videos, failed } = await api<{ videos: Video[]; failed: Array<{ aspect: string; error: string }> }>(`/api/videos/${video.id}/resize`, { method: "POST", body: JSON.stringify({ aspects: chosen }) });
      setMade((prev) => [...prev, ...videos]);
      // A size that started is not offered again, so a second click cannot make it twice.
      const started = new Set(videos.filter((v) => v.status !== "failed").map((v) => v.aspect));
      setChosen((prev) => prev.filter((a) => !started.has(a)));
      if (failed.length) setErr(failed.map((f) => `${f.aspect}: ${f.error}`).join("; "));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The other sizes could not be started");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-slate-900">Other sizes</h3>
      {video.resizedFrom && (
        <p className="mt-1 text-xs text-slate-500">
          {original ? (
            <>
              Made from <Link href={`/videos/${video.resizedFrom}`} className="text-brand-700 underline">{original.video.title}</Link>.
            </>
          ) : originalError ? (
            "Made from a video that has since been deleted."
          ) : (
            "Made from another size of this video."
          )}
        </p>
      )}
      {canMake && (
        <>
          <p className="mt-1 text-xs text-slate-500">Render this video again in another shape, with the same scenes and settings. Each size is a new video and uses one render.</p>
          <fieldset className="mt-2 space-y-2">
            <legend className="sr-only">Sizes to make</legend>
            {others.map((a) => {
              const scenes = tight(a);
              const done = madeAspects.has(a);
              return (
                <div key={a}>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="accent-brand-600"
                      checked={chosen.includes(a)}
                      disabled={done}
                      aria-describedby={scenes.length ? `${id}-${a}` : undefined}
                      onChange={(e) => setChosen((prev) => (e.target.checked ? [...prev, a] : prev.filter((x) => x !== a)))}
                    />
                    {ASPECT_NAMES[a]}
                    {done && <span className="text-xs text-emerald-700">started</span>}
                  </label>
                  {scenes.length > 0 && (
                    <p id={`${id}-${a}`} className="ml-6 text-xs text-amber-700">
                      On-screen text in scene {scenes.join(", ")} may not fit one line at {a}.
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
          <Button variant="secondary" className="mt-3 px-3 py-1.5" onClick={make} loading={busy} disabled={!chosen.length}>
            Make {chosen.length === 1 ? "1 size" : `${chosen.length} sizes`}
          </Button>
        </>
      )}
      {err && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {err}
        </p>
      )}
      {made.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm" data-testid="other-sizes">
          {made.map((v) => (
            <li key={v.id}>
              <Link href={`/videos/${v.id}`} className="text-brand-700 underline">
                {v.title}
              </Link>
              <span className="text-xs text-slate-500"> · {v.status === "failed" ? `failed to start${v.error ? `: ${v.error}` : ""}` : "rendering"}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
