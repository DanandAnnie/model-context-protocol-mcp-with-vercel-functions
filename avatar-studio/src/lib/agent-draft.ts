// Hands a Video Agent plan from the agent page to the editor, once, through session storage.
import { RESOLUTIONS, type AspectRatio, type Background, type Resolution, type SceneLayout } from "./types";

export const AGENT_DRAFT_KEY = "avatar-studio:agent-draft";

/** The plan as `POST /api/video-agent` with `mode: "plan"` returns it. */
export interface AgentDraft {
  title: string;
  scenes: { script: string; background: Background; layout?: SceneLayout }[];
  avatarId: string;
  voiceId: string;
  aspect: AspectRatio;
  resolution: Resolution;
  captions: boolean;
}

/** The waiting plan, removed as it is read so a refresh of the editor goes back to its own draft. */
export function takeAgentDraft(): AgentDraft | null {
  try {
    const raw = window.sessionStorage.getItem(AGENT_DRAFT_KEY);
    window.sessionStorage.removeItem(AGENT_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as AgentDraft;
    const background = (b: Background | undefined) => !!b && ["color", "image", "video"].includes(b.type) && typeof b.value === "string";
    if (typeof d?.title !== "string" || !Array.isArray(d.scenes) || !d.scenes.length || !d.scenes.every((sc) => typeof sc?.script === "string" && background(sc.background))) return null;
    // Settings this build does not offer fall back to the editor's defaults.
    return {
      ...d,
      aspect: (["16:9", "9:16", "1:1"] as const).includes(d.aspect) ? d.aspect : "16:9",
      resolution: RESOLUTIONS.includes(d.resolution) ? d.resolution : "1080p",
      captions: d.captions === true,
    };
  } catch {
    return null;
  }
}
