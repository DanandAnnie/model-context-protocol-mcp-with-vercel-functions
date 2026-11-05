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
import { WEBHOOK_EVENTS, type NotifyEvent, type NotifySettings, type Prefs, type Video, type WebhookDelivery, type WebhookEvent } from "./types";
import { getEmailProvider } from "./providers/email";
import { config } from "./config";

export const notifySchema = z.object({
  url: z.string().trim().min(1).max(2000),
  /** The events to send; left out, the ones chosen before are kept (every event for a new webhook). */
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1, "Choose at least one event to send, or remove the webhook")
    // Repeats are dropped when saved; the cap only keeps a request small.
    .max(20)
    .optional(),
});

/** Whether the webhook is sent an event: every event when none were chosen, and a test whenever one is asked for. */
export function sendsEvent(settings: Pick<NotifySettings, "events">, event: NotifyEvent): boolean {
  return event === "test" || !settings.events || (settings.events as NotifyEvent[]).includes(event);
}
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

/**
 * Saves the endpoint. The signing secret is created once and kept across URL changes, and a rotation's overlap with it.
 * Written only over the settings as read (a conditional write, tried again when a rotation or a delivery wrote first), so
 * a save never brings back a secret just rotated or stopped, and never drops a delivery logged meanwhile.
 */
export async function saveNotifySettings(input: z.infer<typeof notifySchema>, ownerId: string = LOCAL_OWNER): Promise<NotifySettings> {
  const url = (await assertPublicHttpUrl(input.url, "Webhook URL")).toString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await getNotifySettings(ownerId);
    const events = chosenEvents(input.events, existing?.events);
    const now = nowIso();
    const next: NotifySettings = {
      id: notifyId(ownerId),
      ownerId,
      url,
      secret: existing?.secret ?? newSigningSecret(),
      // An overlap that has run out is not carried forward.
      ...(existing && activePreviousSecret(existing) ? { previousSecret: existing.previousSecret, previousSecretExpiresAt: existing.previousSecretExpiresAt } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      rev: newId("rev"),
      ...(events ? { events } : {}),
      lastDelivery: existing?.url === url ? existing?.lastDelivery : undefined,
      // The log is of deliveries to this URL; a new one starts it afresh.
      deliveries: existing?.url === url ? existing?.deliveries : undefined,
    };
    if (existing ? await writeOver(existing, next) : await getStore().insert("notify", next)) return next;
  }
  throw new Error("The webhook changed while it was being saved; try again");
}

/** Writes `next` only over `latest` as read: by its `rev`, or by `updatedAt` for settings saved before `rev` existed. */
function writeOver(latest: NotifySettings, next: NotifySettings): Promise<boolean> {
  return latest.rev ? getStore().putIf("notify", next, "rev", latest.rev) : getStore().putIf("notify", next, "updatedAt", latest.updatedAt);
}

/** The events to keep: those given (in Settings' order, each once), else those chosen before; every event is kept as none. */
function chosenEvents(given: NotifySettings["events"] | undefined, before: NotifySettings["events"] | undefined): NotifySettings["events"] {
  const events = given ? WEBHOOK_EVENTS.filter((e) => given.includes(e)) : before;
  return events && events.length < WEBHOOK_EVENTS.length ? events : undefined;
}

/** How long a rotated-out secret keeps signing `X-Studio-Signature-Previous`, unless retired sooner. */
export const SECRET_OVERLAP_HOURS = 24;

function newSigningSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/** The previous secret while its overlap lasts, else null. */
export function activePreviousSecret(settings: Pick<NotifySettings, "previousSecret" | "previousSecretExpiresAt">, now = Date.now()): string | null {
  return settings.previousSecret && settings.previousSecretExpiresAt && Date.parse(settings.previousSecretExpiresAt) > now ? settings.previousSecret : null;
}

/**
 * Changes the settings with `change`, written only over the settings as read (a conditional write on `rev`, tried again
 * when a delivery or a save wrote first), so a rotation never drops a logged delivery, never undoes a save, and never
 * brings back a webhook removed meanwhile.
 */
async function updateNotifySettings(ownerId: string, change: (latest: NotifySettings) => NotifySettings): Promise<NotifySettings> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = await getNotifySettings(ownerId);
    if (!latest) throw new NotFoundError("Save a webhook URL first");
    const next = { ...change(latest), rev: newId("rev"), updatedAt: nowIso() };
    if (await writeOver(latest, next)) return next;
  }
  throw new Error("The webhook changed while it was being updated; try again");
}

/**
 * Gives the webhook a new signing secret. With `keepPrevious` (the default) the old secret goes on signing
 * `X-Studio-Signature-Previous` for SECRET_OVERLAP_HOURS, so a receiver can be moved over without dropping a delivery;
 * without it the old secret stops at once. A rotation during an overlap replaces the secret it overlapped.
 */
export async function rotateNotifySecret(ownerId: string = LOCAL_OWNER, keepPrevious = true, now = Date.now()): Promise<NotifySettings> {
  return updateNotifySettings(ownerId, (latest) => {
    const { previousSecret: _p, previousSecretExpiresAt: _e, ...rest } = latest;
    void _p;
    void _e;
    return {
      ...rest,
      secret: newSigningSecret(),
      ...(keepPrevious ? { previousSecret: latest.secret, previousSecretExpiresAt: new Date(now + SECRET_OVERLAP_HOURS * 3_600_000).toISOString() } : {}),
    };
  });
}

/** Stops signing with the previous secret before its overlap ends (once every receiver uses the new one). */
export async function retirePreviousSecret(ownerId: string = LOCAL_OWNER): Promise<NotifySettings> {
  return updateNotifySettings(ownerId, (latest) => {
    const { previousSecret: _p, previousSecretExpiresAt: _e, ...rest } = latest;
    void _p;
    void _e;
    return rest;
  });
}

/** The webhook as the API shows it: no previous secret, and when its overlap ends only while it lasts. */
export function publicNotifySettings(settings: NotifySettings, now = Date.now()): Omit<NotifySettings, "previousSecret" | "deliveries"> & { deliveries: ReturnType<typeof publicDelivery>[] } {
  const { previousSecret: _p, previousSecretExpiresAt, deliveries, ...rest } = settings;
  void _p;
  return {
    ...rest,
    ...(activePreviousSecret(settings, now) ? { previousSecretExpiresAt } : {}),
    deliveries: (deliveries ?? []).map(publicDelivery),
  };
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

/**
 * Delivers one event and records the outcome on the settings, or does nothing (null) for an event the webhook was not
 * chosen to be sent. Never throws.
 */
export async function dispatchNotification(settings: NotifySettings, event: NotifyEvent, data: unknown): Promise<NonNullable<NotifySettings["lastDelivery"]> | null> {
  if (!sendsEvent(settings, event)) return null;
  // `id` names the event, inside the signed body, so it stays the same when the delivery is sent again: a receiver can
  // use it to ignore a repeat. (`X-Studio-Delivery` names each attempt.)
  return deliver(settings, event, JSON.stringify({ id: newId("whe"), event, timestamp: nowIso(), data }));
}

/**
 * Sends a body to the settings' URL, signed afresh, and records the attempt as the last delivery and at the head of the
 * log. The record is written only over the settings as they are now (a conditional write on `rev`, or on `updatedAt` for
 * settings saved before `rev` existed, tried again when
 * something else wrote first), so concurrent deliveries keep each other's entries, and not at all when the webhook was
 * removed, saved anew, or pointed elsewhere meanwhile. Never throws.
 */
async function deliver(settings: NotifySettings, event: NotifyEvent, body: string, redeliveryOf?: string, sample = false): Promise<NonNullable<NotifySettings["lastDelivery"]>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = newId("whd");
  const previous = activePreviousSecret(settings);
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
        ...(previous ? { "X-Studio-Signature-Previous": `sha256=${signPayload(previous, timestamp, body)}` } : {}),
        "X-Studio-Delivery": id,
        ...(redeliveryOf ? { "X-Studio-Redelivery-Of": redeliveryOf } : {}),
        // A sample says so outside the body too, so a receiver can drop it before parsing.
        ...(sample ? { "X-Studio-Test": "true" } : {}),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    }, "Webhook URL", fetchOverride, { discardBody: true });
    result = { id, at: nowIso(), event, ok: res.ok, status: res.status, error: res.ok ? undefined : `Endpoint returned ${res.status}` };
  } catch (err) {
    result = { id, at: nowIso(), event, ok: false, error: err instanceof Error ? err.message : "Delivery failed" };
  }
  if (sample) result.test = true;
  const entry: WebhookDelivery = { ...result, id, ...(body.length <= MAX_KEPT_BODY ? { body } : {}), ...(redeliveryOf ? { redeliveryOf } : {}) };
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const latest = await getNotifySettings(settings.ownerId);
      // Removed, or removed and made again, or pointed elsewhere: the attempt belongs to a webhook no longer there.
      if (!latest || latest.url !== settings.url || latest.createdAt !== settings.createdAt) break;
      const next: NotifySettings = { ...latest, rev: newId("rev"), lastDelivery: result, deliveries: [entry, ...(latest.deliveries ?? [])].slice(0, WEBHOOK_LOG_SIZE) };
      if (await writeOver(latest, next)) break;
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
  return deliver(settings, original.event, original.body, original.redeliveryOf ?? original.id, !!original.test);
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

/** What Settings can send to try the receiver: a plain ping, or a sample of one of the real events. */
export const TEST_EVENTS = ["test", ...WEBHOOK_EVENTS] as const;
export type TestEvent = (typeof TEST_EVENTS)[number];

/**
 * Made-up data shaped like each event's real `data`, so a receiver's handling can be tried before one happens: every id
 * starts `sample_`, addresses are on example.com, and links point at example.com. As in a real event, a field with no
 * value is left out (a video in no folder has no `folder`), and a lead is the share-page kind (`source: "share"`); a
 * presenter's lead carries `agentId`, `agentName`, `conversationId`, and `lastMessage` in place of the video's fields.
 */
export function sampleEventData(event: WebhookEvent, now = nowIso()): Record<string, unknown> {
  if (event === "lead.captured") {
    return { source: "share", videoId: "sample_video", videoTitle: "Sample video", email: "viewer@example.com", name: "Sample Viewer", capturedAt: now };
  }
  const base = { id: "sample_video", title: "Sample video", createdAt: now, updatedAt: now };
  return event === "video.completed"
    ? { ...base, status: "completed", videoUrl: "https://example.com/sample.mp4", thumbnailUrl: "https://example.com/sample.jpg", durationSec: 42 }
    : { ...base, status: "failed", error: "Sample failure: the renderer could not finish this video" };
}

/**
 * Sends a test to the saved endpoint whatever events are chosen: a `test` ping, or a sample of a real event (its own name
 * in `X-Studio-Event` and the body, sample data, `test: true` in the body, and `X-Studio-Test: true`). Null with no webhook.
 */
export async function sendTestNotification(ownerId: string = LOCAL_OWNER, event: TestEvent = "test") {
  const settings = await getNotifySettings(ownerId);
  if (!settings) return null;
  if (event === "test") return deliver(settings, "test", JSON.stringify({ id: newId("whe"), event: "test", timestamp: nowIso(), data: { message: "Avatar Studio webhook test" } }));
  return deliver(settings, event, JSON.stringify({ id: newId("whe"), event, timestamp: nowIso(), test: true, data: sampleEventData(event) }), undefined, true);
}
