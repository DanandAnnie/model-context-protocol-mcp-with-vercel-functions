// Which of the account's presenters a video shows: the library's presenter filter and its counts, and the video page's
// link to it, read the same rule. Safe for the browser (types only).
import type { Video } from "./types";

/**
 * The presenters a video shows, each once, in order of appearance: those of a cinematic shot, else the video's own and
 * its scenes' (a scene without its own presenter shows the video's; one that hides the presenter shows none). A HeyGen
 * template video shows none of the account's: the template decides who appears, and the video's labels are the
 * template's. A directed video HeyGen cast itself has no presenter id, so none either. The names are as the video was made.
 */
export function videoPresenters(v: Video): { id: string; name: string }[] {
  if (v.studioTemplate) return [];
  const seen = new Map<string, string>();
  const add = (id: string | undefined, name: string | undefined) => {
    if (id && !seen.has(id)) seen.set(id, name?.trim() || "");
  };
  if (v.cinematic?.avatarIds.length) v.cinematic.avatarIds.forEach((id, i) => add(id, v.cinematic!.avatarNames[i]));
  else if (v.scenes?.length) {
    for (const sc of v.scenes) {
      if (sc.hidePresenter) continue;
      if (sc.avatarId && sc.avatarId !== v.avatarId) add(sc.avatarId, sc.avatarName);
      else add(v.avatarId, v.avatarName);
    }
  } else add(v.avatarId, v.avatarName);
  return Array.from(seen, ([id, name]) => ({ id, name }));
}
