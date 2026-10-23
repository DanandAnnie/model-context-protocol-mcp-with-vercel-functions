# Avatar Studio API

Every screen in the app is backed by JSON routes under `/api`, and scripts can call the same routes.

## Authentication

Create a key in **Settings → Developer API** (the secret is shown once) and send it as a bearer token:

```
Authorization: Bearer as_live_…
```

- A key acts as the account, or the workspace, that was active when it was minted.
- Keys work in every access mode (open, shared password, Supabase accounts).
- Creating or revoking keys needs a signed-in browser session, never another key (`403` otherwise).
- Keys minted inside a workspace are revoked when that member leaves or is removed, and when the workspace is deleted.
- Unknown or revoked keys get `401`.

Public routes need no key: `/api/videos/:id/captions`, `/api/videos/:id/view`, `/api/webhooks/:provider`, `/api/auth/*`, `/share/:id`.

## Conventions

- Request and response bodies are JSON. Timestamps are ISO 8601 in UTC.
- Validation errors return `400` with `{ "error": "...", "issues": [...] }`. Missing or foreign items return `404`. Exceeding the monthly render allowance returns `429` with the usage and reset date. Provider failures on submission return `502` with the provider's message.
- Ids are prefixed: `vid_`, `av_`, `tr_`, `key_`, `ws_`.

## Videos

### `POST /api/videos` — render a video

```json
{
  "title": "Open house walkthrough",
  "script": "Hi, I'm Dana. Welcome to 12 Maple Street…",
  "avatarId": "stock_1",
  "voiceId": "stock_voice_1",
  "aspect": "16:9",
  "background": { "type": "color", "value": "#f1f5f9" },
  "captions": true,
  "speed": 1
}
```

Instead of `script`, send `scenes` (1 to 20), each with its own `script` and `background`; the combined script must stay under 5000 characters:

```json
{ "title": "Two scenes", "avatarId": "stock_1", "voiceId": "stock_voice_1",
  "scenes": [
    { "script": "First scene.", "background": { "type": "color", "value": "#0f172a" } },
    { "script": "Second scene.", "background": { "type": "image", "value": "https://example.com/bg.jpg" } }
  ] }
```

| Field | Type | Notes |
|---|---|---|
| `title` | string, 1–120 | |
| `script` | string, ≤5000 | required unless `scenes` is given |
| `scenes` | array | each `{ script, background }` |
| `avatarId` | string | from `GET /api/avatars` |
| `voiceId` | string | from `GET /api/voices` |
| `aspect` | `16:9` \| `9:16` \| `1:1` | default `16:9` |
| `background` | `{ type: "color" \| "image", value }` | default light grey |
| `captions` | boolean | default `false` |
| `speed` | 0.5–1.5 | default `1` |

Returns `201` with `{ "video": Video }`. The video starts as `queued` or `processing`; poll `GET /api/videos/:id` or use a webhook.

```json
{
  "video": {
    "id": "vid_7b3…", "status": "processing", "title": "Open house walkthrough",
    "avatarName": "Ava Chen", "voiceName": "Emma", "aspect": "16:9", "captions": true,
    "provider": "mock", "providerJobId": "job_…", "createdAt": "2026-10-23T06:00:00.000Z",
    "updatedAt": "2026-10-23T06:00:00.000Z"
  }
}
```

When completed the video also carries `videoUrl`, `thumbnailUrl`, and `durationSec`; when failed, `error`.

### `GET /api/videos` — list (newest first)
### `GET /api/videos/:id` — fetch; refreshes the status from the provider while rendering
### `PATCH /api/videos/:id` — `{ "title"?: string, "folder"?: string }` (empty `folder` means unfiled)
### `DELETE /api/videos/:id`
### `POST /api/videos/bulk` — `{ "action": "move", "ids": [...], "folder": "Q4" }` or `{ "action": "delete", "ids": [...] }` → `{ "done", "missing" }`
### `GET /api/videos/:id/captions` — SRT; add `?format=vtt` for WebVTT (public)
### `POST /api/videos/:id/view` — share-page view beacon (public; one per viewer per 10 minutes)

### Personalized batch

`PUT /api/videos/batch` previews, `POST /api/videos/batch` renders one video per CSV row.

```json
{
  "title": "Welcome, {first_name}",
  "scriptTemplate": "Hi {first_name}, thanks for visiting {property}.",
  "csv": "first_name,property\nDana,12 Maple St\nSam,4 Oak Ave",
  "avatarId": "stock_1", "voiceId": "stock_voice_1", "aspect": "9:16"
}
```

`POST` returns `{ "batchId", "videos", "skipped", "failed" }`. Rows beyond the monthly allowance are skipped; rows the provider rejected are reported in `failed`. Up to 100 rows per batch.

## Scripts

`POST /api/script` writes a script from a topic or revises one.

```json
{ "topic": "Why staged homes sell faster", "tone": "professional", "lengthSec": 45, "language": "English", "audience": "home sellers" }
```

```json
{ "action": "shorten", "script": "…" }
{ "action": "tone", "script": "…", "tone": "energetic" }
{ "action": "translate", "script": "…", "language": "Spanish" }
```

Actions: `shorten`, `expand`, `tone`, `translate`, `polish`. Returns `{ "script": "…" }`.

## Avatars and voices

- `GET /api/avatars` → `{ "avatars": [...] }` (custom photo avatars first, then the library)
- `POST /api/avatars` → `{ "name", "imageUrl", "gender"? }` where `imageUrl` is an https URL or a `data:image/…` upload (≤ 6 MB). Private and local hosts are rejected.
- `DELETE /api/avatars/:id`
- `GET /api/voices` → `{ "voices": [...] }`
- `POST /api/voices/preview` → `{ "voiceId", "text", "speed" }`; returns audio, or `204` with `x-tts-fallback: browser` in demo mode

## Translation

- `POST /api/translate` → `{ "title", "sourceVideoUrl", "targetLanguage" }` → `201 { "translation" }`
- `GET /api/translate`, `GET /api/translate/:id`

## Brand kit

- `GET /api/brand` → `{ "brand": BrandKit | null }`
- `PUT /api/brand` → `{ "name", "logoUrl", "primaryColor": "#0f766e", "accentColor"?, "defaultAvatarId"?, "defaultVoiceId"?, "defaultAspect"?, "captionsByDefault"? }`
- `DELETE /api/brand`

## Workspaces

- `GET /api/workspaces` → `{ "personalId", "activeId", "workspaces": [...] }`
- `POST /api/workspaces` → `{ "name" }` → `201`
- `GET | PATCH | DELETE /api/workspaces/:id` (`PATCH` renames; owners only)
- `POST /api/workspaces/:id/invites` → `{ "email"?, "role": "editor" | "owner" }` → `201 { "invite", "url" }`; `DELETE /api/workspaces/:id/invites/:token` revokes
- `PATCH /api/workspaces/:id/members/:userId` → `{ "role" }`; `DELETE` removes (owners) or leaves (self)
- `POST /api/workspaces/switch` → `{ "id": "ws_…" }` or your personal id; sets the `studio_workspace` cookie (browser sessions only; keys are bound at minting)
- `GET | POST /api/invites/:token` describes and accepts an invite

## Keys and notifications

- `GET /api/keys`, `POST /api/keys` → `{ "name" }` → `201 { "key", "secret" }`, `DELETE /api/keys/:id`
- `GET | PUT | DELETE /api/notifications` (`PUT` → `{ "url" }`), `POST /api/notifications/test`

## Billing

- `POST /api/billing/checkout` → `{ "url" }` to start a Pro upgrade (Stripe Checkout, or an instant upgrade with the mock); browser sessions only (`403` with a key)
- `POST /api/billing/portal` → `{ "url" }` for the Stripe Billing Portal (the mock downgrades to Free)
- `POST /api/webhooks/stripe` receives Stripe events (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`), verified with `STRIPE_WEBHOOK_SECRET`
- `GET /api/status` reports `renderLimitPerMonth` for the active owner and `usage.plan`

## Outbound webhooks

Save an endpoint in **Settings → Webhook notifications**. Each delivery is a `POST` with:

```
Content-Type: application/json
X-Studio-Event: video.completed | video.failed | test
X-Studio-Timestamp: 1761199200          (unix seconds)
X-Studio-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with your signing secret>
```

```json
{ "event": "video.completed", "timestamp": "2026-10-23T06:00:12.000Z",
  "data": { "id": "vid_…", "title": "…", "status": "completed", "videoUrl": "…", "thumbnailUrl": "…", "durationSec": 42, "folder": null, "batchId": null, "rowLabel": null, "createdAt": "…", "updatedAt": "…" } }
```

Verify before trusting a delivery (Node):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyStudioWebhook(req, rawBody, secret, maxAgeSec = 300) {
  const ts = req.headers["x-studio-timestamp"];
  const sig = String(req.headers["x-studio-signature"] ?? "").replace(/^sha256=/, "");
  if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > maxAgeSec) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
```

Deliveries are attempted once, after the response that completed the render, with a 10-second timeout and no redirects. The last outcome is shown in Settings. Endpoints on private or local addresses are rejected.

## Provider webhooks (inbound)

`POST /api/webhooks/:provider` (`heygen`, `did`) receives render callbacks. Set `WEBHOOK_SECRET` and configure the provider to call `https://<your-app>/api/webhooks/<provider>?secret=<WEBHOOK_SECRET>` (or send it as `x-webhook-secret`). Without the secret configured the route answers `503`; a wrong secret answers `403`.

## Example: render and wait

```bash
KEY=as_live_…
BASE=https://your-app.example.com
ID=$(curl -s "$BASE/api/videos" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"title":"Hello","script":"Hi there.","avatarId":"stock_1","voiceId":"stock_voice_1"}' | jq -r .video.id)
until [ "$(curl -s "$BASE/api/videos/$ID" -H "Authorization: Bearer $KEY" | jq -r .video.status)" = completed ]; do sleep 5; done
curl -s "$BASE/api/videos/$ID" -H "Authorization: Bearer $KEY" | jq -r .video.videoUrl
```
