// Viewer emails collected by a share page's email gate. Used by API routes only.
import { createHash } from "node:crypto";
import { z } from "zod";
import { nowIso } from "../ids";
import { getStore } from "../store";
import type { Video, VideoLead } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { dispatchNotification, getNotifySettings } from "../notifications";
import { NotFoundError } from "../errors";
import { toCsv } from "../csv";
import { afterResponse, owned } from "./shared";

export const videoLeadSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(80).optional(),
});

/** One row per viewer per video: the id comes from both, so a second visit updates the row instead of adding one. */
export const videoLeadId = (videoId: string, email: string) =>
  `vlead_${createHash("sha256").update(`${videoId}|${email.toLowerCase()}`).digest("hex").slice(0, 24)}`;

/**
 * Records a viewer's email for a gated video. The first time an address is given for a video the
 * owner's webhook hears `lead.captured`; a repeat visit only moves `lastSeenAt` (and fills in a name
 * the viewer had left out). A video that does not ask, or that the public cannot open, is not found.
 */
export async function captureVideoLead(video: Video, input: z.infer<typeof videoLeadSchema>): Promise<{ lead: VideoLead; first: boolean }> {
  if (!video.shareGate) throw new NotFoundError("This video does not ask for an email");
  const id = videoLeadId(video.id, input.email);
  const now = nowIso();
  const existing = await getStore().get<VideoLead>("videolead", id);
  const lead: VideoLead = existing
    ? { ...existing, ...(input.name && !existing.name ? { name: input.name } : {}), lastSeenAt: now, visits: (existing.visits ?? 1) + 1 }
    : { id, ownerId: video.ownerId ?? LOCAL_OWNER, videoId: video.id, email: input.email, ...(input.name ? { name: input.name } : {}), createdAt: now, lastSeenAt: now, visits: 1 };
  await getStore().put("videolead", lead);
  if (!existing) {
    const settings = await getNotifySettings(lead.ownerId).catch(() => null);
    if (settings) {
      await afterResponse(() =>
        dispatchNotification(settings, "lead.captured", { source: "share", videoId: video.id, videoTitle: video.title, email: lead.email, name: lead.name, capturedAt: now }),
      );
    }
  }
  return { lead, first: !existing };
}

/** The emails a video's gate collected, newest first; the owner's video only. */
export async function listVideoLeads(videoId: string, ownerId: string = LOCAL_OWNER): Promise<VideoLead[]> {
  owned(await getStore().get<Video>("video", videoId), ownerId, `Video ${videoId}`);
  const all = await getStore().list<VideoLead>("videolead", ownerId);
  return all.filter((l) => l.videoId === videoId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Removes every lead a video collected; part of deleting the video for good. */
export async function clearVideoLeads(videoId: string, ownerId: string): Promise<void> {
  const all = await getStore().list<VideoLead>("videolead", ownerId);
  await Promise.all(all.filter((l) => l.videoId === videoId).map((l) => getStore().remove("videolead", l.id)));
}

/** The leads as CSV: email, name, first seen, last seen, visits (cells that read as formulas are defused). */
export function videoLeadsCsv(leads: VideoLead[]): string {
  return toCsv(
    ["email", "name", "first_seen", "last_seen", "visits"],
    leads.map((l) => ({ email: l.email, name: l.name, first_seen: l.createdAt, last_seen: l.lastSeenAt, visits: l.visits })),
  );
}
