// Outbound webhooks: tell the owner's system when a render finishes.
// One endpoint per owner, signed with HMAC-SHA256 so the receiver can verify the sender.
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { NotFoundError, ValidationError } from "./errors";
import { newId, nowIso } from "./ids";
import { LOCAL_OWNER } from "./owner-id";
import { safeFetch, type FetchLike } from "./safe-fetch";
import { assertPublicHttpUrl } from "./safe-url";
import { getStore } from "./store";
import type { NotifyEvent, NotifySettings, Prefs, Video, WebhookDelivery } from "./types";
import { getEmailProvider } from "./providers/email";
import { config } from "./config";

export const notifySchema = z.object({ url: z.string().trim().min(1).max(2000) });
export const notifyId = (ownerId: string) => `notify_${ownerId}`;
const DELIVERY_TIMEOUT_MS = 10_000;
/** How many recent deliveries the log keeps. */
export const WEBHOOK_LOG_SIZE = 20;
/** A body larger than this is not kept, so that delivery cannot be sent again (the log stays small). */
const MAX_KEPT_BODY = 16_000;

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
    rev: newId("rev"),
    lastDelivery: existing?.url === url ? existing?.lastDelivery : undefined,
    // The log is of deliveries to this URL; a new one starts it afresh.
    deliveries: existing?.url === url ? existing?.deliveries : undefined,
  };
  return getStore().put("notify", next);
}

export async function deleteNotifySettings(ownerId: string = LOCAL_OWNER): Promise<void> {
  await getStore().remove("notify", notifyId(ownerId));
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

let fetchOverride: FetchLike | undefined;
/** Test hook: replace the HTTP client used for deliveries (the host check still runs; pinning does not). */
export function setNotificationFetch(impl: FetchLike | null) {
  fetchOverride = impl ?? undefined;
}

/** Delivers one event and records the outcome on the settings. Never throws. */
export async function dispatchNotification(settings: NotifySettings, event: NotifyEvent, data: unknown): Promise<NonNullable<NotifySettings["lastDelivery"]>> {
  // `id` names the event, inside the signed body, so it stays the same when the delivery is sent again: a receiver can
  // use it to ignore a repeat. (`X-Studio-Delivery` names each attempt.)
  return deliver(settings, event, JSON.stringify({ id: newId("whe"), event, timestamp: nowIso(), data }));
}

/**
 * Sends a body to the settings' URL, signed afresh, and records the attempt as the last delivery and at the head of the
 * log. The record is written only over the settings as they are now (a conditional write on `rev`, tried again when
 * something else wrote first), so concurrent deliveries keep each other's entries, and not at all when the webhook was
 * removed, saved anew, or pointed elsewhere meanwhile. Never throws.
 */
async function deliver(settings: NotifySettings, event: NotifyEvent, body: string, redeliveryOf?: string): Promise<NonNullable<NotifySettings["lastDelivery"]>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = newId("whd");
  let result: NonNullable<NotifySettings["lastDelivery"]>;
  try {
    // Re-checked at send time and pinned to the vetted address: DNS can change between saving the URL and using it.
    const res = await safeFetch(settings.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AvatarStudio-Webhooks/1.0",
        "X-Studio-Event": event,
        "X-Studio-Timestamp": timestamp,
        "X-Studio-Signature": `sha256=${signPayload(settings.secret, timestamp, body)}`,
        "X-Studio-Delivery": id,
        ...(redeliveryOf ? { "X-Studio-Redelivery-Of": redeliveryOf } : {}),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    }, "Webhook URL", fetchOverride, { discardBody: true });
    result = { id, at: nowIso(), event, ok: res.ok, status: res.status, error: res.ok ? undefined : `Endpoint returned ${res.status}` };
  } catch (err) {
    result = { id, at: nowIso(), event, ok: false, error: err instanceof Error ? err.message : "Delivery failed" };
  }
  const entry: WebhookDelivery = { ...result, id, ...(body.length <= MAX_KEPT_BODY ? { body } : {}), ...(redeliveryOf ? { redeliveryOf } : {}) };
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const latest = await getNotifySettings(settings.ownerId);
      // Removed, or removed and made again, or pointed elsewhere: the attempt belongs to a webhook no longer there.
      if (!latest || latest.url !== settings.url || latest.createdAt !== settings.createdAt) break;
      const next: NotifySettings = { ...latest, rev: newId("rev"), lastDelivery: result, deliveries: [entry, ...(latest.deliveries ?? [])].slice(0, WEBHOOK_LOG_SIZE) };
      // Settings saved before `rev` existed are written once as before, and carry one from then on.
      if (!latest.rev) {
        await getStore().put("notify", next);
        break;
      }
      if (await getStore().putIf("notify", next, "rev", latest.rev)) break;
    }
  } catch {
    // Recording is best effort; the delivery itself has happened.
  }
  return result;
}

/** A delivery as the API shows it: the body it sent stays on the server; `resendable` says whether it was kept. */
export function publicDelivery({ body, ...rest }: WebhookDelivery): Omit<WebhookDelivery, "body"> & { resendable: boolean } {
  return { ...rest, resendable: body !== undefined };
}

/**
 * Sends a logged delivery's body again, signed with a fresh timestamp, under a new delivery id with
 * `X-Studio-Redelivery-Of` naming the original; the attempt is logged like any other.
 */
export async function redeliverNotification(deliveryId: string, ownerId: string = LOCAL_OWNER): Promise<NonNullable<NotifySettings["lastDelivery"]>> {
  const settings = await getNotifySettings(ownerId);
  const original = settings?.deliveries?.find((d) => d.id === deliveryId);
  if (!settings || !original) throw new NotFoundError("That delivery is no longer in the log");
  if (original.body === undefined) throw new ValidationError("That delivery was too large to keep, so it cannot be sent again");
  return deliver(settings, original.event, original.body, original.redeliveryOf ?? original.id);
}

/** Called after a video's status is persisted; fires once when it reaches a final state. */
// ---------- Preferences (email on completion) ----------

export const prefsId = (ownerId: string) => `prefs_${ownerId}`;
export const prefsSchema = z.object({ emailOnComplete: z.string().trim().email().max(200).optional() });

export async function getPrefs(ownerId: string = LOCAL_OWNER): Promise<Prefs | null> {
  const p = await getStore().get<Prefs>("prefs", prefsId(ownerId));
  return p && p.ownerId === ownerId ? p : null;
}

export async function savePrefs(input: z.infer<typeof prefsSchema>, ownerId: string = LOCAL_OWNER): Promise<Prefs> {
  const existing = await getPrefs(ownerId);
  // Favourites live on the same record and survive an email change.
  const next: Prefs = { ...(existing ?? { id: prefsId(ownerId), ownerId }), emailOnComplete: input.emailOnComplete, updatedAt: nowIso() };
  if (!next.emailOnComplete) delete next.emailOnComplete;
  return getStore().put("prefs", next);
}

export const MAX_FAVORITES = 50;
export const favoriteSchema = z.object({ kind: z.enum(["avatar", "voice"]), id: z.string().trim().min(1).max(120), on: z.boolean() });

/** Star or unstar an avatar or voice. The newest 50 per kind are kept; starring is idempotent. */
export async function toggleFavorite(input: z.infer<typeof favoriteSchema>, ownerId: string = LOCAL_OWNER): Promise<Prefs> {
  const existing = await getPrefs(ownerId);
  const field = input.kind === "avatar" ? "favoriteAvatarIds" : "favoriteVoiceIds";
  const current = (existing?.[field] ?? []).filter((id) => id !== input.id);
  const ids = input.on ? [...current, input.id].slice(-MAX_FAVORITES) : current;
  const next: Prefs = { ...(existing ?? { id: prefsId(ownerId), ownerId }), [field]: ids, updatedAt: nowIso() };
  if (ids.length === 0) delete next[field];
  return getStore().put("prefs", next);
}

/** Emails the owner that a render finished. Never throws. */
export async function emailVideoResult(video: Video): Promise<boolean> {
  const prefs = await getPrefs(video.ownerId ?? LOCAL_OWNER).catch(() => null);
  if (!prefs?.emailOnComplete) return false;
  const link = `${config.appUrl.replace(/\/$/, "")}/videos/${video.id}`;
  const ok = video.status === "completed";
  const subject = ok ? `Your video "${video.title}" is ready` : `Your video "${video.title}" could not be rendered`;
  const text = ok
    ? `"${video.title}" finished rendering${video.durationSec ? ` (${video.durationSec}s)` : ""}.\n\nOpen it: ${link}${video.videoUrl ? `\nDownload: ${video.videoUrl}` : ""}`
    : `"${video.title}" failed to render.${video.error ? `\n\nReason: ${video.error}` : ""}\n\nOpen it: ${link}`;
  const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  const html = ok
    ? `<p><strong>${esc(video.title)}</strong> finished rendering${video.durationSec ? ` (${video.durationSec}s)` : ""}.</p><p><a href="${esc(link)}">Open the video</a>${video.videoUrl ? ` · <a href="${esc(video.videoUrl)}">Download</a>` : ""}</p>`
    : `<p><strong>${esc(video.title)}</strong> failed to render.${video.error ? ` Reason: ${esc(video.error)}` : ""}</p><p><a href="${esc(link)}">Open the video</a></p>`;
  try {
    await getEmailProvider().send({ to: prefs.emailOnComplete, subject, text, html });
    return true;
  } catch (err) {
    console.error("result email failed:", err);
    return false;
  }
}

export async function notifyVideoTransition(prev: Video, next: Video): Promise<void> {
  if (next.status === prev.status) return;
  if (next.status !== "completed" && next.status !== "failed") return;
  await emailVideoResult(next);
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
