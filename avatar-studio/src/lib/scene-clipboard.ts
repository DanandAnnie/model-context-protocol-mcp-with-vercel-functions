// A scene copied in one video and pasted into another (or the same one). The copy lives in the browser's storage, so it
// reaches the editor in another tab, and it names the space it came from: its pictures, clips, and recordings belong
// to that space, so it is pasted there only. Pure, so the editor and the tests share it.
import type { Background, Scene } from "./types";
import { sceneName } from "./scene-text";
import { MAX_SCRIPT_CHARS } from "./script-import";

export const SCENE_CLIPBOARD_KEY = "avatar-studio:scene-clipboard";

export interface CopiedScene {
  /** The space (Personal or a workspace) the scene was copied in. */
  space: string;
  scene: Scene;
}

// The server's limits, so a copy that would be refused at Generate is not pasted.
const MAX_BACKGROUND_VALUE = 2000;
const MAX_ID = 64;

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
// An empty id is none (the editor's "Same as video" choice); anything else of the wrong kind is dropped.
const id = (v: unknown): string | undefined => (str(v, MAX_ID) && v ? v : undefined);
// A picture or clip is a web address or one of the account's own (an uploaded picture, a generated clip).
const mediaValue = (v: string) => /^https?:\/\//i.test(v) || v.startsWith("/api/backdrops/") || v.startsWith("/api/footage/");

function asBackground(v: unknown): Background | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if ((b.type !== "color" && b.type !== "image" && b.type !== "video") || !str(b.value, MAX_BACKGROUND_VALUE) || !b.value) return null;
  if (b.type === "color") return { type: "color", value: b.value };
  if (!mediaValue(b.value)) return null;
  return { type: b.type, value: b.value, ...(b.fit === "contain" ? { fit: "contain" as const } : {}) };
}

/** What a copy holds: the scene as the editor has it, without the names the server fills in when a video is made. */
export function copiedScene(space: string, scene: Scene): CopiedScene {
  const { avatarName: _a, voiceName: _v, audioName: _n, audioSeconds: _s, ...kept } = scene;
  return { space, scene: kept };
}

/**
 * Reads a copy back, or null when there is none or it is not one this build can paste. The layout and on-screen text
 * are passed through for the editor to check as it restores any scene; a field of the wrong kind is dropped.
 */
export function parseCopiedScene(raw: string | null): CopiedScene | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const { space, scene } = v as Record<string, unknown>;
  if (!str(space, 200) || !space || !scene || typeof scene !== "object") return null;
  const sc = scene as Record<string, unknown>;
  const background = asBackground(sc.background);
  if (!str(sc.script, MAX_SCRIPT_CHARS) || !background) return null;
  const out: Scene = { script: sc.script, background };
  const name = sceneName(sc.name);
  if (name) out.name = name;
  const avatarId = id(sc.avatarId);
  const voiceId = id(sc.voiceId);
  const audioId = id(sc.audioId);
  if (avatarId) out.avatarId = avatarId;
  if (voiceId) out.voiceId = voiceId;
  if (audioId) out.audioId = audioId;
  if (typeof sc.speed === "number" && sc.speed >= 0.5 && sc.speed <= 1.5) out.speed = sc.speed;
  if (sc.layout && typeof sc.layout === "object" && !Array.isArray(sc.layout)) out.layout = sc.layout as Scene["layout"];
  if (sc.overlay && typeof sc.overlay === "object" && !Array.isArray(sc.overlay)) out.overlay = sc.overlay as Scene["overlay"];
  // Only a picture or video can fill the frame in the presenter's place.
  if (sc.hidePresenter === true && background.type !== "color") out.hidePresenter = true;
  return { space, scene: out };
}
