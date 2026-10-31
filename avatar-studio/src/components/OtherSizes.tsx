"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { api } from "@/lib/client";
import { sceneTextFits, type AspectRatio, type Video } from "@/lib/types";

const ASPECTS: AspectRatio[] = ["16:9", "9:16", "1:1"];
const ASPECT_NAMES: Record<AspectRatio, string> = { "16:9": "16:9 landscape", "9:16": "9:16 portrait", "1:1": "1:1 square" };
type Size = Pick<Video, "id" | "title" | "aspect" | "status">;

/**
 * "Make other sizes": renders the video again in the frame shapes it does not have yet (a portrait cut for stories and
 * reels, a square for feeds), each as a new video with the same scenes and settings, and links the sizes it has. Says
 * which on-screen text would not fit one line in a shape, before anything is rendered.
 */
export function OtherSizes({ video, canEdit }: { video: Video; canEdit: boolean }) {
  const id = useId();
  const { data, error: sizesError, setData, refetch } = useApi<{ sizes: Size[] }>(`/api/videos/${video.id}/sizes`);
  // While a size is still rendering the list is asked again, so it reads "rendering" only while it is.
  const rendering = (data?.sizes ?? []).some((s) => s.id !== video.id && (s.status === "queued" || s.status === "processing"));
  useEffect(() => {
    if (!rendering) return;
    // Not while the tab is hidden: nobody is reading it, and each check asks the renderer.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 5000);
    return () => clearInterval(timer);
  }, [rendering, refetch]);
  // The original, when there is one: a link to a video since deleted for good would lead nowhere.
  const { data: original, error: originalError } = useApi<{ video: Video }>(video.resizedFrom ? `/api/videos/${video.resizedFrom}` : null);
  const sizes = data?.sizes ?? [];
  // A size whose render could not be started holds nothing, so its shape is offered again (as the server allows); the
  // original's shape counts even while it is in the trash, as it can be restored.
  const have = new Set<AspectRatio>([video.aspect, ...(original ? [original.video.aspect] : []), ...sizes.filter((s) => s.status !== "failed").map((s) => s.aspect)]);
  const missing = ASPECTS.filter((a) => !have.has(a));
  const [unchosen, setUnchosen] = useState<AspectRatio[]>([]);
  const chosen = missing.filter((a) => !unchosen.includes(a));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const tight = (aspect: AspectRatio) => (video.scenes ?? []).map((sc, i) => (sc.overlay && !sceneTextFits(sc.overlay, aspect) ? i + 1 : 0)).filter(Boolean);
  const canMake = canEdit && !video.deletedAt;
  const others = sizes.filter((s) => s.id !== video.id);
  if (!canMake && !video.resizedFrom) return null;

  async function make() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const { videos, failed } = await api<{ videos: Video[]; failed: Array<{ aspect: string; error: string }> }>(`/api/videos/${video.id}/resize`, { method: "POST", body: JSON.stringify({ aspects: chosen }) });
      // Listed as a reload would list them, a size that could not start included (marked failed, its shape offered again).
      setData((prev) => ({ sizes: [...(prev?.sizes ?? []), ...videos.map(({ id: vid, title, aspect, status }) => ({ id: vid, title, aspect, status }))] }));
      // A check that left before these sizes were made would answer without them; asking again retires it.
      void refetch();
      const started = videos.filter((v) => v.status !== "failed");
      if (started.length) setNote(`Started ${started.map((v) => v.aspect).join(" and ")}.`);
      // The shapes still missing are offered afresh.
      setUnchosen([]);
      const problems = [...videos.filter((v) => v.status === "failed").map((v) => `${v.aspect}: ${v.error ?? "the render could not be started"}`), ...failed.map((f) => `${f.aspect}: ${f.error}`)];
      if (problems.length) setErr(problems.join("; "));
      // Focus goes to the size just made, rather than being lost with the button that may have gone away.
      if (started.length) focusAfterRender(() => listRef.current?.querySelector<HTMLAnchorElement>(`a[href="/videos/${started[0].id}"]`));
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
              Made from <Link href={`/videos/${video.resizedFrom}`} className="text-brand-700 underline">{original.video.title}</Link>
              {original.video.deletedAt ? " (in the trash)" : ""}.
            </>
          ) : originalError ? (
            "Made from a video that has since been deleted."
          ) : (
            "Made from another size of this video."
          )}
        </p>
      )}
      {others.length > 0 && (
        <ul ref={listRef} className="mt-2 space-y-1 text-sm" data-testid="other-sizes">
          {others.map((v) => (
            <li key={v.id}>
              <Link href={`/videos/${v.id}`} className="text-brand-700 underline">
                {v.title}
              </Link>
              <span className="text-xs text-slate-500">
                {" "}
                · {v.aspect}
                {v.status === "completed" ? "" : v.status === "failed" ? ", failed" : ", rendering"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      {sizesError && <p className="mt-2 text-xs text-rose-600">The other sizes could not be loaded: {sizesError}</p>}
      {canMake && data && (!video.resizedFrom || original || originalError) && (
        missing.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">This video has every size.</p>
        ) : (
          <>
            <p className="mt-2 text-xs text-slate-500">Render this video again in another shape, with the same scenes and settings. Each size is a new video and uses one render.</p>
            <fieldset className="mt-2 space-y-2">
              <legend className="sr-only">Sizes to make</legend>
              {missing.map((a) => {
                const scenes = tight(a);
                return (
                  <div key={a}>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        className="accent-brand-600"
                        checked={chosen.includes(a)}
                        aria-describedby={scenes.length ? `${id}-${a}` : undefined}
                        onChange={(e) => setUnchosen((prev) => (e.target.checked ? prev.filter((x) => x !== a) : [...prev, a]))}
                      />
                      {ASPECT_NAMES[a]}
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
              {chosen.length === 0 ? "Choose a size" : chosen.length === 1 ? "Make 1 size" : `Make ${chosen.length} sizes`}
            </Button>
          </>
        )
      )}
      {err && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {err}
        </p>
      )}
    </Card>
  );
}
