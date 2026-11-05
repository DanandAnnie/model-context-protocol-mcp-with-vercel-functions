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
import { EMAIL_KINDS, WEBHOOK_EVENTS, type EmailKind, type NotifyEvent, type NotifySettings, type Prefs, type Translation, type TwinJob, type Video, type WebhookDelivery, type WebhookEvent } from "./types";
import { escapeHtml, getEmailProvider } from "./providers/email";
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
      // A pause outlives a save, so changing the URL does not start sending again.
      ...(existing?.pausedAt ? { pausedAt: existing.pausedAt } : {}),
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

/**
 * Pauses the webhook (no event is sent or logged until it is resumed; the URL, secret, chosen events, and log are kept,
 * and a test or a redelivery still goes) or resumes it. Pausing a paused webhook keeps when it was first paused.
 */
export async function setNotificationsPaused(ownerId: string = LOCAL_OWNER, paused: boolean): Promise<NotifySettings> {
  return updateNotifySettings(ownerId, (latest) => {
    const { pausedAt, ...rest } = latest;
    return paused ? { ...rest, pausedAt: pausedAt ?? nowIso() } : rest;
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
  // A paused webhook is sent nothing (a test or a redelivery is sent through deliver, whatever the pause). Checked on the
  // settings as they are now, not the copy the caller read, which a lead's deferred dispatch may have read before a pause.
  if (settings.pausedAt || (await getNotifySettings(settings.ownerId).catch(() => null))?.pausedAt) return null;
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
export const prefsSchema = z.object({
  emailOnComplete: z.string().trim().email().max(200).optional(),
  // Which results are emailed: at least one; repeats are dropped. Left out, the choice made before is kept.
  emailKinds: z
    .array(z.enum(EMAIL_KINDS, `Each kind is one of ${EMAIL_KINDS.join(", ")}`))
    .min(1, "Choose at least one kind of result to email")
    .max(EMAIL_KINDS.length * 4)
    .transform((kinds) => EMAIL_KINDS.filter((k) => kinds.includes(k)))
    .optional(),
}).refine((p) => !p.emailKinds || p.emailOnComplete, { message: "Give the address to email results to with the kinds: a save without it turns result emails off", path: ["emailOnComplete"] });

export async function getPrefs(ownerId: string = LOCAL_OWNER): Promise<Prefs | null> {
  const p = await getStore().get<Prefs>("prefs", prefsId(ownerId));
  return p && p.ownerId === ownerId ? p : null;
}

export async function savePrefs(input: z.infer<typeof prefsSchema>, ownerId: string = LOCAL_OWNER): Promise<Prefs> {
  const existing = await getPrefs(ownerId);
  // Favourites live on the same record and survive an email change.
  const next: Prefs = { ...(existing ?? { id: prefsId(ownerId), ownerId }), emailOnComplete: input.emailOnComplete, updatedAt: nowIso() };
  if (!next.emailOnComplete) delete next.emailOnComplete;
  // Choosing every kind is the same as choosing none: new kinds added later are emailed too.
  if (input.emailKinds) next.emailKinds = input.emailKinds.length === EMAIL_KINDS.length ? undefined : input.emailKinds;
  if (!next.emailKinds) delete next.emailKinds;
  return getStore().put("prefs", next);
}

/** The address results of this kind are emailed to, or null when none is set or the kind is not chosen. */
async function resultEmailAddress(ownerId: string, kind: EmailKind): Promise<string | null> {
  const prefs = await getPrefs(ownerId).catch(() => null);
  if (!prefs?.emailOnComplete) return null;
  return !prefs.emailKinds || prefs.emailKinds.includes(kind) ? prefs.emailOnComplete : null;
}

/** Sends a result email built from plain text and already-escaped html. Never throws. */
async function sendResultEmail(to: string, subject: string, text: string, html: string): Promise<boolean> {
  try {
    await getEmailProvider().send({ to, subject, text, html });
    return true;
  } catch (err) {
    console.error("result email failed:", err);
    return false;
  }
}

const appLink = (path: string) => `${config.appUrl.replace(/\/$/, "")}${path}`;

/**
 * Emails the owner that a dub is ready or failed, with its language and the Video translate page (not the provider's
 * download link, which expires long before an email may be read). Never throws.
 */
export async function emailTranslationResult(dub: Translation): Promise<boolean> {
  const to = await resultEmailAddress(dub.ownerId ?? LOCAL_OWNER, "dubs");
  if (!to) return false;
  const link = appLink("/translate");
  const ok = dub.status === "completed";
  const what = `"${dub.title}" in ${dub.targetLanguage}`;
  const subject = ok ? `Your dub ${what} is ready` : `Your dub ${what} could not be made`;
  const text = ok
    ? `The ${dub.targetLanguage} dub of "${dub.title}" is ready to watch and download.\n\nOpen Video translate: ${link}`
    : `The ${dub.targetLanguage} dub of "${dub.title}" failed.${dub.error ? `\n\nReason: ${dub.error}` : ""}\n\nOpen Video translate: ${link}`;
  const html = ok
    ? `<p>The ${escapeHtml(dub.targetLanguage)} dub of <strong>${escapeHtml(dub.title)}</strong> is ready to watch and download.</p><p><a href="${escapeHtml(link)}">Open Video translate</a></p>`
    : `<p>The ${escapeHtml(dub.targetLanguage)} dub of <strong>${escapeHtml(dub.title)}</strong> failed.${dub.error ? ` Reason: ${escapeHtml(dub.error)}` : ""}</p><p><a href="${escapeHtml(link)}">Open Video translate</a></p>`;
  return sendResultEmail(to, subject, text, html);
}

/** Emails the owner that a digital twin is ready to use or failed, with a link to the Avatars page. Never throws. */
export async function emailTwinResult(twin: TwinJob): Promise<boolean> {
  const to = await resultEmailAddress(twin.ownerId ?? LOCAL_OWNER, "twins");
  if (!to) return false;
  const ok = twin.status === "completed";
  const link = appLink("/avatars");
  const subject = ok ? `Your digital twin "${twin.name}" is ready` : `Your digital twin "${twin.name}" could not be made`;
  const text = ok
    ? `The digital twin "${twin.name}" is trained and can present videos now: it is listed with your avatars.\n\nOpen Avatars: ${link}`
    : `The digital twin "${twin.name}" could not be made.${twin.error ? `\n\nReason: ${twin.error}` : ""}\n\nOpen Avatars: ${link}`;
  const html = ok
    ? `<p>The digital twin <strong>${escapeHtml(twin.name)}</strong> is trained and can present videos now: it is listed with your avatars.</p><p><a href="${escapeHtml(link)}">Open Avatars</a></p>`
    : `<p>The digital twin <strong>${escapeHtml(twin.name)}</strong> could not be made.${twin.error ? ` Reason: ${escapeHtml(twin.error)}` : ""}</p><p><a href="${escapeHtml(link)}">Open Avatars</a></p>`;
  return sendResultEmail(to, subject, text, html);
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
  const to = await resultEmailAddress(video.ownerId ?? LOCAL_OWNER, "videos");
  if (!to) return false;
  const link = `${config.appUrl.replace(/\/$/, "")}/videos/${video.id}`;
  const ok = video.status === "completed";
  const subject = ok ? `Your video "${video.title}" is ready` : `Your video "${video.title}" could not be rendered`;
  const text = ok
    ? `"${video.title}" finished rendering${video.durationSec ? ` (${video.durationSec}s)` : ""}.\n\nOpen it: ${link}${video.videoUrl ? `\nDownload: ${video.videoUrl}` : ""}`
    : `"${video.title}" failed to render.${video.error ? `\n\nReason: ${video.error}` : ""}\n\nOpen it: ${link}`;
  const esc = escapeHtml;
  const html = ok
    ? `<p><strong>${esc(video.title)}</strong> finished rendering${video.durationSec ? ` (${video.durationSec}s)` : ""}.</p><p><a href="${esc(link)}">Open the video</a>${video.videoUrl ? ` · <a href="${esc(video.videoUrl)}">Download</a>` : ""}</p>`
    : `<p><strong>${esc(video.title)}</strong> failed to render.${video.error ? ` Reason: ${esc(video.error)}` : ""}</p><p><a href="${esc(link)}">Open the video</a></p>`;
  return sendResultEmail(to, subject, text, html);
}

export async function notifyVideoTransition(prev: Video, next: Video): Promise<void> {
  if (next.status === prev.status) return;
  if (next.status !== "completed" && next.status !== "failed") return;
  // The email and the webhook go out side by side, so a slow mail provider does not hold the webhook back.
  await Promise.all([
    emailVideoResult(next),
    (async () => {
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
    })(),
  ]);
}

/**
 * Sends translation.completed or translation.failed when a dub reaches either, from the write that moved it there (each
 * transition is written once, conditionally, so it is sent once). A dub can reach an end more than once: a proofread dub
 * tried again keeps its id, and a late callback can finish one that had failed. A dub refused as it was asked for (by
 * the request or a retry) is not sent: the caller has the refusal in the answer.
 */
export async function notifyTranslationTransition(prev: Translation, next: Translation): Promise<void> {
  if (next.status === prev.status) return;
  if (next.status !== "completed" && next.status !== "failed") return;
  // The email and the webhook go out side by side, so a slow mail provider does not hold the webhook back.
  await Promise.all([
    emailTranslationResult(next),
    (async () => {
      const settings = await getNotifySettings(next.ownerId ?? LOCAL_OWNER).catch(() => null);
      if (!settings) return;
      const { id, title, status, targetLanguage, sourceVideoUrl, videoUrl, captionUrls, error, createdAt, updatedAt } = next;
      await dispatchNotification(settings, status === "completed" ? "translation.completed" : "translation.failed", {
        id,
        title,
        status,
        targetLanguage,
        sourceVideoUrl,
        videoUrl,
        captionUrls,
        error,
        createdAt,
        updatedAt,
      });
    })(),
  ]);
}

/**
 * Sends translation.proofread_ready once a dub asked to be proofread first has its translated lines ready to correct,
 * from the write that stored them, with how many lines there are and the page to correct them on. Nothing more is sent
 * until the dub is approved and made (translation.completed) or fails (translation.failed).
 */
export async function notifyProofreadReady(prev: Translation, next: Translation): Promise<void> {
  if (prev.proofreadStage === "ready" || next.proofreadStage !== "ready" || next.status !== "processing") return;
  const settings = await getNotifySettings(next.ownerId ?? LOCAL_OWNER).catch(() => null);
  if (!settings) return;
  const { id, title, status, targetLanguage, sourceVideoUrl, proofreadStage, createdAt, updatedAt } = next;
  await dispatchNotification(settings, "translation.proofread_ready", {
    id,
    title,
    status,
    targetLanguage,
    sourceVideoUrl,
    proofreadStage,
    lineCount: next.proofreadCues?.length ?? 0,
    proofreadUrl: `${config.appUrl.replace(/\/$/, "")}/translate`,
    createdAt,
    updatedAt,
  });
}

/**
 * Sends twin.completed once a digital twin is trained, consented to, and kept as a photo avatar, or twin.failed when
 * training or its picture fails, or the renderer refuses, never confirms, or loses the twin, from the write that moved
 * it there. The renderer's ids,
 * the consent link, and the picture are not sent; `avatarId` is the presenter to make videos with.
 */
export async function notifyTwinTransition(prev: TwinJob, next: TwinJob): Promise<void> {
  if (next.status === prev.status) return;
  if (next.status !== "completed" && next.status !== "failed") return;
  // The email and the webhook go out side by side, so a slow mail provider does not hold the webhook back.
  await Promise.all([
    emailTwinResult(next),
    (async () => {
      const settings = await getNotifySettings(next.ownerId ?? LOCAL_OWNER).catch(() => null);
      if (!settings) return;
      const { id, name, status, consent, avatarId, error, createdAt, updatedAt } = next;
      await dispatchNotification(settings, status === "completed" ? "twin.completed" : "twin.failed", { id, name, status, consent, avatarId, error, createdAt, updatedAt });
    })(),
  ]);
}

/**
 * The studio's other renderer jobs a webhook reports on, by the kind each is stored as: the `type` it is sent as, and the
 * studio page it is listed on (sent as `pageUrl`).
 */
export const JOB_EVENT_TYPES = {
  footage: { type: "broll", page: "/footage" },
  shoot: { type: "photo_shoot", page: "/photos" },
  cleanup: { type: "cleanup", page: "/cleanup" },
  lipsync: { type: "lipsync", page: "/lipsync" },
  music: { type: "music", page: "/music" },
  voicechange: { type: "voice_change", page: "/voice-changer" },
  instantvoice: { type: "instant_voice", page: "/voice-changer" },
} as const;
export type JobEventKind = keyof typeof JOB_EVENT_TYPES;

/** What job.completed and job.failed read from any of those jobs (an instant voice has a `name` where the rest have a `title`). */
export interface ReportedJob {
  id: string;
  ownerId?: string;
  status: string;
  title?: string;
  name?: string;
  error?: string;
  createdAt?: string;
  updatedAt: string;
}

/**
 * Sends job.completed or job.failed when a B-roll clip, photo shoot, clean-up, lip sync, music mix, voice recording, or
 * instant voice that was being made is ready or fails, from the write that moved it there (each written once,
 * conditionally, so sent once). Only a job leaving "processing" is sent: a finished one whose link later expires is not.
 * The renderer's ids and its signed links (which expire) are not sent; `pageUrl` is where the job is listed, and the
 * job's listing gives its current link.
 */
export async function notifyJobTransition(kind: JobEventKind, prev: ReportedJob, next: ReportedJob): Promise<void> {
  if (prev.status !== "processing" || (next.status !== "completed" && next.status !== "failed")) return;
  const settings = await getNotifySettings(next.ownerId ?? LOCAL_OWNER).catch(() => null);
  if (!settings) return;
  const { type, page } = JOB_EVENT_TYPES[kind];
  const { id, status, error, createdAt, updatedAt } = next;
  await dispatchNotification(settings, status === "completed" ? "job.completed" : "job.failed", {
    type,
    id,
    title: next.title ?? next.name,
    status,
    error: status === "failed" ? error : undefined,
    pageUrl: `${config.appUrl.replace(/\/$/, "")}${page}`,
    createdAt,
    updatedAt,
  });
}

/** What Settings can send to try the receiver: a plain ping, or a sample of one of the real events. */
export const TEST_EVENTS = ["test", ...WEBHOOK_EVENTS] as const;
export type TestEvent = (typeof TEST_EVENTS)[number];
/** Where a lead came from: a share page's email gate, or a visitor talking to a shared presenter. */
export const LEAD_SOURCES = ["share", "presenter"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * Made-up data shaped like each event's real `data`, so a receiver's handling can be tried before one happens: every id
 * starts `sample_`, addresses are on example.com, and links point at example.com. As in a real event, a field with no
 * value is left out (a video in no folder has no `folder`). A lead is the share-page kind (`source: "share"`) unless
 * `source` asks for a presenter's, which carries `agentId`, `agentName`, `conversationId`, and `lastMessage` in place of the
 * video's fields.
 */
export function sampleEventData(event: WebhookEvent, now = nowIso(), source: LeadSource = "share"): Record<string, unknown> {
  if (event === "lead.captured") {
    return source === "presenter"
      ? { source: "presenter", agentId: "sample_presenter", agentName: "Sample presenter", conversationId: "sample_conversation", email: "visitor@example.com", name: "Sample Visitor", lastMessage: "Can someone call me about pricing?", capturedAt: now }
      : { source: "share", videoId: "sample_video", videoTitle: "Sample video", email: "viewer@example.com", name: "Sample Viewer", capturedAt: now };
  }
  if (event === "translation.completed" || event === "translation.failed") {
    const dub = { id: "sample_translation", title: "Sample video (Spanish)", targetLanguage: "Spanish", sourceVideoUrl: "https://example.com/source.mp4", createdAt: now, updatedAt: now };
    return event === "translation.completed"
      ? { ...dub, status: "completed", videoUrl: "https://example.com/sample-es.mp4", captionUrls: { srt: "https://example.com/sample-es.srt", vtt: "https://example.com/sample-es.vtt" } }
      : { ...dub, status: "failed", error: "Sample failure: the dub could not be made" };
  }
  if (event === "translation.proofread_ready") {
    return { id: "sample_translation", title: "Sample video (Spanish)", status: "processing", targetLanguage: "Spanish", sourceVideoUrl: "https://example.com/source.mp4", proofreadStage: "ready", lineCount: 12, proofreadUrl: "https://example.com/translate", createdAt: now, updatedAt: now };
  }
  if (event === "twin.completed" || event === "twin.failed") {
    const twin = { id: "sample_twin", name: "Sample twin", createdAt: now, updatedAt: now };
    return event === "twin.completed"
      ? { ...twin, status: "completed", consent: "accepted", avatarId: "sample_avatar" }
      : { ...twin, status: "failed", consent: "not_requested", error: "Sample failure: the renderer could not train a twin from that footage" };
  }
  if (event === "job.completed" || event === "job.failed") {
    const job = { type: "broll", id: "sample_clip", title: "Sample clip", pageUrl: "https://example.com/footage", createdAt: now, updatedAt: now };
    return event === "job.completed" ? { ...job, status: "completed" } : { ...job, status: "failed", error: "Sample failure: the renderer could not make this clip" };
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
export async function sendTestNotification(ownerId: string = LOCAL_OWNER, event: TestEvent = "test", source: LeadSource = "share") {
  const settings = await getNotifySettings(ownerId);
  if (!settings) return null;
  if (event === "test") return deliver(settings, "test", JSON.stringify({ id: newId("whe"), event: "test", timestamp: nowIso(), data: { message: "Avatar Studio webhook test" } }));
  return deliver(settings, event, JSON.stringify({ id: newId("whe"), event, timestamp: nowIso(), test: true, data: sampleEventData(event, nowIso(), source) }), undefined, true);
}
