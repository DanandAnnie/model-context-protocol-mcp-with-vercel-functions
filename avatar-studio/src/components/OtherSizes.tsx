"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { api } from "@/lib/client";
import { sceneTextFits, type AspectRatio, type Video } from "@/lib/types";

const ASPECTS: AspectRatio[] = ["16:9", "9:16", "1:1"];
const ASPECT_NAMES: Record<AspectRatio, string> = { "16:9": "16:9 landscape", "9:16": "9:16 portrait", "1:1": "1:1 square" };

/**
 * "Make other sizes": renders the video again in the other frame shapes (a portrait cut for stories and reels, a
 * square for feeds), each as a new video with the same scenes and settings. Says which on-screen text would not fit
 * one line in a shape, before anything is rendered.
 */
export function OtherSizes({ video, canEdit }: { video: Video; canEdit: boolean }) {
  const others = ASPECTS.filter((a) => a !== video.aspect);
  const [chosen, setChosen] = useState<AspectRatio[]>(others);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<Video[]>([]);
  if (video.deletedAt) return null;
  const tight = (aspect: AspectRatio) => (video.scenes ?? []).map((sc, i) => (sc.overlay && !sceneTextFits(sc.overlay, aspect) ? i + 1 : 0)).filter(Boolean);

  async function make() {
    setBusy(true);
    setErr(null);
    try {
      const { videos } = await api<{ videos: Video[] }>(`/api/videos/${video.id}/resize`, { method: "POST", body: JSON.stringify({ aspects: chosen }) });
      setMade(videos);
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
          Made from <Link href={`/videos/${video.resizedFrom}`} className="text-brand-700 underline">another size of this video</Link>.
        </p>
      )}
      {canEdit && (
        <>
          <p className="mt-1 text-xs text-slate-500">Render this video again in another shape, with the same scenes and settings. Each size is a new video and uses one render.</p>
          <fieldset className="mt-2 space-y-1">
            <legend className="sr-only">Sizes to make</legend>
            {others.map((a) => (
              <label key={a} className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="mt-1 accent-brand-600"
                  checked={chosen.includes(a)}
                  onChange={(e) => setChosen((prev) => (e.target.checked ? [...prev, a] : prev.filter((x) => x !== a)))}
                />
                <span>
                  {ASPECT_NAMES[a]}
                  {tight(a).length > 0 && (
                    <span className="block text-xs text-amber-700">
                      On-screen text in scene {tight(a).join(", ")} may not fit one line at {a}.
                    </span>
                  )}
                </span>
              </label>
            ))}
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
