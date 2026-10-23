// Outbound webhooks: tell the owner's system when a render finishes.
// One endpoint per owner, signed with HMAC-SHA256 so the receiver can verify the sender.
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { nowIso } from "./ids";
import { LOCAL_OWNER } from "./owner-id";
import { assertPublicHttpUrl } from "./safe-url";
import { getStore } from "./store";
import type { NotifyEvent, NotifySettings, Video } from "./types";

export const notifySchema = z.object({ url: z.string().trim().min(1).max(2000) });
export const notifyId = (ownerId: string) => `notify_${ownerId}`;
const DELIVERY_TIMEOUT_MS = 10_000;

export async function getNotifySettings(ownerId: string = LOCAL_OWNER): Promise<NotifySettings | null> {
  const s = await getStore().get<NotifySettings>("notify", notifyId(ownerId));
  return s && s.ownerId === ownerId ? s : null;
}

/** Saves the endpoint. The signing secret is created once and kept across URL changes. */
export async function saveNotifySettings(input: z.infer<typeof notifySchema>, ownerId: string = LOCAL_OWNER): Promise<NotifySettings> {
  const url = (await assertPublicHttpUrl(input.url, "Webhook URL")).toString();
  const existing = await getNotifySettings(ownerId);
  const now = nowIso();
  const next: NotifySettings = {
    id: notifyId(ownerId),
    ownerId,
    url,
    secret: existing?.secret ?? `whsec_${randomBytes(24).toString("base64url")}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastDelivery: existing?.url === url ? existing?.lastDelivery : undefined,
  };
  return getStore().put("notify", next);
}

export async function deleteNotifySettings(ownerId: string = LOCAL_OWNER): Promise<void> {
  await getStore().remove("notify", notifyId(ownerId));
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);
/** Test hook: replace the HTTP client used for deliveries. */
export function setNotificationFetch(impl: FetchLike | null) {
  fetchImpl = impl ?? ((...args) => fetch(...args));
}

/** Delivers one event and records the outcome on the settings. Never throws. */
export async function dispatchNotification(settings: NotifySettings, event: NotifyEvent, data: unknown): Promise<NonNullable<NotifySettings["lastDelivery"]>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ event, timestamp: nowIso(), data });
  let result: NonNullable<NotifySettings["lastDelivery"]>;
  try {
    // Re-check at send time: DNS can change between saving the URL and using it.
    await assertPublicHttpUrl(settings.url, "Webhook URL");
    const res = await fetchImpl(settings.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AvatarStudio-Webhooks/1.0",
        "X-Studio-Event": event,
        "X-Studio-Timestamp": timestamp,
        "X-Studio-Signature": `sha256=${signPayload(settings.secret, timestamp, body)}`,
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    result = { at: nowIso(), event, ok: res.ok, status: res.status, error: res.ok ? undefined : `Endpoint returned ${res.status}` };
  } catch (err) {
    result = { at: nowIso(), event, ok: false, error: err instanceof Error ? err.message : "Delivery failed" };
  }
  await getStore().put("notify", { ...settings, lastDelivery: result }).catch(() => {});
  return result;
}

/** Called after a video's status is persisted; fires once when it reaches a final state. */
export async function notifyVideoTransition(prev: Video, next: Video): Promise<void> {
  if (next.status === prev.status) return;
  if (next.status !== "completed" && next.status !== "failed") return;
  const settings = await getNotifySettings(next.ownerId ?? LOCAL_OWNER).catch(() => null);
  if (!settings) return;
  const { id, title, status, videoUrl, thumbnailUrl, durationSec, error, folder, batchId, rowLabel, createdAt, updatedAt } = next;
  await dispatchNotification(settings, status === "completed" ? "video.completed" : "video.failed", {
    id,
    title,
    status,
    videoUrl,
    thumbnailUrl,
    durationSec,
    error,
    folder,
    batchId,
    rowLabel,
    createdAt,
    updatedAt,
  });
}

export async function sendTestNotification(ownerId: string = LOCAL_OWNER) {
  const settings = await getNotifySettings(ownerId);
  if (!settings) return null;
  return dispatchNotification(settings, "test", { message: "Avatar Studio webhook test" });
}
