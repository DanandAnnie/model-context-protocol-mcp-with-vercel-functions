// Hands a Video Agent plan from the agent page to the editor, once, through session storage.
import type { AspectRatio, Background, Resolution, SceneLayout } from "./types";

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
    return typeof d?.title === "string" && Array.isArray(d.scenes) && d.scenes.length && d.scenes.every((sc) => typeof sc?.script === "string" && sc.background) ? d : null;
  } catch {
    return null;
  }
}
