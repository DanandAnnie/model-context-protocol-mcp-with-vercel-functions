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
- Unknown or revoked keys get `401`. Only tokens that start with `as_live_` are treated as keys; any other bearer value falls back to the normal session check.

Public routes need no key: `/api/videos/:id/captions`, `/api/videos/:id/cover`, `/api/videos/:id/view`, `/api/videos/:id/watch`, `/api/videos/:id/cta`, `/api/videos/:id/unlock`, `/api/talk/:id`, `/api/webhooks/:provider`, `/api/auth/*`, `/share/:id`.

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

Instead of `script`, send `scenes` (1 to 20), each with its own `script` and `background`, and optionally its own `avatarId` and `voiceId` (the video's are used when omitted); the combined script must stay under 5000 characters. HeyGen renders one presenter per scene; D-ID refuses a scene that names another presenter or voice, and the demo renderer ignores the choice:

```json
{ "title": "Two scenes", "avatarId": "stock_1", "voiceId": "stock_voice_1",
  "scenes": [
    { "script": "First scene.", "background": { "type": "color", "value": "#0f172a" } },
    { "script": "Second scene.", "background": { "type": "image", "value": "https://example.com/bg.jpg" }, "avatarId": "stock_2", "voiceId": "stock_voice_2" }
  ] }
```

| Field | Type | Notes |
|---|---|---|
| `title` | string, 1–120 | |
| `script` | string, ≤5000 | required unless `scenes` is given |
| `scenes` | array | each `{ script, background, avatarId?, voiceId?, layout? }`; `layout` is `{ scale: 0.5–1.5, x: -1..1, y: -1..1 }`, the presenter's size and offset in the frame (HeyGen renders it as the character's `scale` and `offset`; other renderers use their default); stored scenes also carry `avatarName` and `voiceName` |
| `avatarId` | string | from `GET /api/avatars` |
| `voiceId` | string | from `GET /api/voices` |
| `aspect` | `16:9` \| `9:16` \| `1:1` | default `16:9` |
| `resolution` | `720p` \| `1080p` | default `1080p`; the short side of the frame (1080p: 1920×1080, 1080×1920, 1080×1080; 720p: 1280×720, 720×1280, 720×720). HeyGen renders at these sizes; D-ID and the demo renderer record the value but output at their native size |
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

### `GET /api/videos` — list the library

Query parameters, all optional: `q` (matches title, script, avatar, and voice), `status` (`processing`, which includes queued, `completed`, or `failed`), `folder` (a name; pass it empty for unfiled videos), `batch`, `sort` (`newest`, `oldest`, `title`, `views`), `limit` (1–200; omit it to receive every match), and `trash` (`true` or `1` lists the trash instead of the library, newest deletion first). Returns `{ "videos", "matched", "total", "hasMore", "folders", "rendering", "trashed" }`: `matched` counts the query's results before `limit`, `total` the whole library (never the trash), `folders` the names in use, `rendering` the renders still in flight, and `trashed` the videos in the trash. The newest ten in-flight renders are refreshed from the provider on the way out, so polling the list is enough to see completions.

### `GET /api/videos/analytics` — the library's share analytics as a CSV download

One row per video, newest first: `id`, `title`, `status`, `created`, `folder`, `duration_sec`, `views`, `views_7d` (views in the last seven UTC days including today), `last_viewed`, `watched_25` … `watched_100`, `finish_rate` (percent of views that played to the end; empty before any view), `cta_clicks`, and `share_link` (built from `APP_URL` when set). Cells are quoted and formula-safe, with a byte-order mark for Excel.

### `GET /api/templates`, `POST /api/templates`, `GET /api/templates/:id`, `DELETE /api/templates/:id` — saved templates

A template is a starting point for the editor: scenes (with any per-scene presenter), avatar, voice, aspect, quality, captions, and speed, up to 50 per account. Create one from a video you own with `{ "fromVideoId", "title"?, "description"? }` (the title defaults to the video's), or spell it out with `{ "title", "scenes", "avatarId"?, "voiceId"?, "aspect"?, "resolution"?, "captions"?, "speed"? }` (scenes may carry a `layout` like a video's). `GET /api/templates` returns `{ "templates" }`, newest first; the editor opens one at `/create?template=<id>`.

### `GET /api/videos/:id` — fetch; refreshes the status from the provider while rendering
### `PATCH /api/videos/:id` — `{ "title"?: string, "folder"?: string, "shareDownload"?: boolean, "shareDisabled"?: boolean, "shareExpiresAt"?: string | null, "cover"?: string | null, "sharePassword"?: string | null, "shareCta"?: { "label", "url" } | null }` (empty `folder` means unfiled; `shareDownload` shows a download button on the public share page; `shareDisabled` takes the share link offline: the share page, its captions, and the view, watch, and click beacons answer `404` to the public while the owner keeps full access; `shareExpiresAt` (an ISO 8601 time with a UTC offset, e.g. `2030-06-01T10:00:00+02:00` or `...Z`, in the future, or `null` to clear) does the same automatically once that time passes, stored as a UTC instant; `cover` (a `data:image/...` URL, PNG/JPEG/WebP/GIF, 2 MB decoded, or `null` to remove) sets a custom poster kept in its own record and served by `GET /api/videos/:id/cover` (the video carries `cover: { updatedAt, mimeType, bytes }`; `updatedAt` versions the URL); `sharePassword` (4–64 characters, or `null` to remove) protects the share link: visitors must enter it before the page plays, captions and beacons need the resulting cookie, and the video carries `shareLocked: true` while the password itself is kept only as a salted hash in its own record; `shareCta` puts a call-to-action button under the share-page player, label up to 40 characters and an http(s) link, `null` removes it)
### `DELETE /api/videos/:id` — moves the video to the trash: it leaves the library, its share page, captions, cover, and beacons answer `404` to the public, and the owner can still read and restore it for 30 days, after which it is deleted for good (side records included) the next time the library is listed; `?permanent=true` deletes a trashed video for good straight away (`409` for a video that is not in the trash). The video carries `deletedAt` while trashed
### `POST /api/videos/:id/restore` — brings a trashed video back to the library → `{ video }`; a live video is returned as is
### `POST /api/videos/folders` — `{ "from": "Q4", "to": "Q4 2026" }` renames a folder by moving every video in it (trashed ones included); an empty `to` removes the folder and leaves its videos unfiled; renaming onto an existing folder merges them → `{ "moved" }`
### `POST /api/videos/bulk` — `{ "action": "move", "ids": [...], "folder": "Q4" }`, `{ "action": "delete", "ids": [...] }` (to the trash), `{ "action": "restore", "ids": [...] }`, `{ "action": "purge", "ids": [...] }` (delete trashed videos for good; a video that is not in the trash is reported in `missing`), or `{ "action": "share", "ids": [...], "shareDisabled": true | false }` (switch the share links off or on) → `{ "done", "missing" }`
### `POST /api/videos/:id/share` — `{ "to": ["jane@example.com", ...], "message"?: string }`

Emails the share link of a **completed** video to up to 10 recipients (de-duplicated; `message` is an optional plain-text note of up to 500 characters shown above the link; a password-protected link tells the recipient a password is needed without including it). `404` for a video that is not yours, `409` while the render is not finished or the share link is off or expired, `429` beyond 60 recipients per sender per hour (600 per instance); a refused batch takes nothing from the allowance. The link uses `APP_URL` when it is set, otherwise the request's origin. Returns `{ "sent": [...], "failed": [{ "to", "error" }], "delivers" }`; `delivers` is `false` with the demo email provider, which only records the message. The status is `502` when no recipient could be sent to.

### `POST /api/videos/:id/retry`

Submits a **failed** render again as a new video with the same scenes, presenter, look, and quality; the new video keeps the original's folder and batch row and carries `retryOf` with the original id. Returns `201 { video }` (or `502` when the provider refuses the start again). `409` when the video is not failed, `404` when it is not yours.

### `GET /api/videos/:id/cover` — the custom poster image (public under the share page's rules: `404` while the link is offline, for a password-protected link without the unlock cookie, and when no cover is set; `?v=` responses are immutable, and `public` only for a link that is neither offline nor password-protected, with a lifetime capped at the link's expiry)
### `GET /api/videos/:id/captions` — SRT; add `?format=vtt` for WebVTT (public; while the share link is offline only the owner's own request gets them, and a password-protected link needs the unlock cookie or the owner)
### `POST /api/videos/:id/view` — share-page view beacon (public; one per viewer per 10 minutes, 600 per video; counts only once the render completed; the video carries `views`, `lastViewedAt`, and `viewsByDay`, a `YYYY-MM-DD` → count map of the last 90 UTC days)
### `POST /api/videos/:id/watch` — `{ "quarter": 25 | 50 | 75 | 100 }` share-player progress beacon with the furthest point reached (public; every quarter up to it counts once per viewer per 10 minutes, 600 per quarter per video; counts only once the render completed; the video carries `watch: { q25, q50, q75, q100 }`)
### `POST /api/videos/:id/cta` — call-to-action click beacon (public; one per viewer per 10 minutes, 300 per video; counts only while a completed video carries a button)
### `POST /api/videos/:id/unlock` — `{ "password" }` for a password-protected share link (public; 5 attempts per client per video, 30 per client across all videos, and 100 per video per 15 minutes, `429` with `Retry-After` past that; `401` on a wrong password). A correct password sets an `httpOnly` cookie for that video, valid for 30 days or until the password changes (`SameSite=None; Secure` in production so a share page embedded on another site can unlock too; browsers that block third-party cookies cannot unlock inside a frame).

The beacons answer `{ "views" | "watch" | "clicks", "counted" }` and never fail on repeats; while the share link is offline they answer `404` like the share page, and a password-protected link counts only requests carrying the unlock cookie. A browser request from another site (`Sec-Fetch-Site` other than `same-origin`) is not counted, so a page elsewhere cannot count for visitors who never opened the share page.

### Personalized batch

`PUT /api/videos/batch` previews, `POST /api/videos/batch` renders one video per CSV row.

```json
{
  "title": "Welcome, {first_name}",
  "scriptTemplate": "Hi {first_name}, thanks for visiting {property}.",
  "csv": "first_name,property\nDana,12 Maple St\nSam,4 Oak Ave",
  "avatarId": "stock_1", "voiceId": "stock_voice_1", "aspect": "9:16", "resolution": "720p", "captions": true
}
```

`background`, `captions`, `speed`, and `resolution` take the same values and defaults as a single video. `POST` returns `{ "batchId", "videos", "skipped", "failed" }`. Rows beyond the monthly allowance are skipped; rows the provider rejected are reported in `failed`. Up to 100 rows per batch.

## Scripts

`POST /api/script` writes a script from a topic or revises one.

```json
{ "topic": "Why staged homes sell faster", "tone": "professional", "lengthSec": 45, "language": "English", "audience": "home sellers" }
```

Or write from a public web page (`url`; the topic defaults to the page title; private hosts, redirects, non-HTML, and pages over 1 MB are rejected):

```json
{ "url": "https://example.com/listings/12-maple-st", "lengthSec": 45 }
```

```json
{ "action": "shorten", "script": "…" }
{ "action": "tone", "script": "…", "tone": "energetic" }
{ "action": "translate", "script": "…", "language": "Spanish" }
```

Actions: `shorten`, `expand`, `tone`, `translate`, `polish`. Returns `{ "script": "…" }`.

## Interactive avatar

`POST /api/chat` returns one spoken-style reply in character. Keep the last 20 messages; the last one must be from the visitor. Rate limited to 60 turns per 10 minutes per client.

```json
{ "avatarId": "stock_1", "instructions": "You represent Acme Realty…", "language": "English",
  "messages": [{ "role": "user", "content": "Do you have open houses this weekend?" }] }
```

Returns `{ "reply": "…" }`.

### Shared presenters (agents)

- `GET /api/agents`, `POST /api/agents` → `{ "name", "avatarId", "voiceId"?, "instructions"?, "language"?, "isPublic"? }` → `201 { "agent" }` (20 per account)
- `GET | PATCH | DELETE /api/agents/:id` (`PATCH` takes any subset of the fields above)
- Public, no key: `GET /api/talk/:id` → the visitor-safe view (name, avatar, language, brand; never instructions) and `POST /api/talk/:id` → `{ "messages": [...], "conversationId"? }` → `{ "reply", "conversationId" }` (send the id back on later turns so the visit is one transcript), limited to 30 turns per 10 minutes per client and 600 per hour per agent. `404` when the agent is private or deleted. The page `/talk/:id` is embeddable in an iframe.
- `POST /api/talk/:id/lead` → `{ "conversationId", "email", "name"? }` records a visitor's contact details on the conversation (shown when the agent has `collectEmail`) and sends `lead.captured` to the owner's webhook; 5 per 10 minutes per client
- `POST /api/prefs/favorites` → `{ "kind": "avatar" | "voice", "id", "on": boolean }` stars or unstars an avatar or voice for the owner (newest 50 per kind kept); `GET /api/prefs` returns them as `favoriteAvatarIds` and `favoriteVoiceIds`, and every picker lists starred items first
- `GET /api/agents/:id/conversations` → the owner's transcripts (newest first, up to 50 visits of 40 messages); add `?format=csv` for a lead list download (up to 1000 conversations: started, last message, email, name, message count, first question, last reply; cells that look like spreadsheet formulas are neutralised); `DELETE` clears them. Transcripts are also removed when the agent is deleted.
- Live video (HeyGen Streaming, when `AVATAR_PROVIDER=heygen`): `POST /api/talk/:id/live` opens a session → `{ "available": true, "sessionId", "url", "accessToken", "expiresAt" }` or `{ "available": false }`; `POST /api/talk/:id/live/:sessionId` → `{ "text" }` makes the presenter say a reply; `DELETE` closes it. Sessions are scoped to the presenter, capped per client, and expire after 10 idle minutes. The owner's interactive page uses `/api/live` and `/api/live/:sessionId` the same way.
- Website embed: `<script src="https://<app>/embed/agent.js?id=agent_…" async></script>` adds a floating launcher that opens the talk page; options `position=left|right`, `color=%23hex`, `label=…`.

## Avatars and voices

- `GET /api/avatars` → `{ "avatars": [...] }` (custom photo avatars first, then the library)
- `POST /api/avatars` → `{ "name", "imageUrl", "gender"? }` where `imageUrl` is an https URL or a `data:image/…` upload (≤ 6 MB). Private and local hosts are rejected.
- `DELETE /api/avatars/:id`
- `GET /api/voices` → `{ "voices": [...] }` (the account's cloned voices first, `source: "custom"`)
- `POST /api/voices/clone` → `{ "name", "samples": ["data:audio/webm;base64,…"], "language"? }` (one to five audio data URLs, 10 MB total, five clones per account) → `201 { "voice" }`; `DELETE /api/voices/:id` removes a clone. Cloning runs on ElevenLabs when it is the voice provider; the demo provider saves the clone and previews use the browser voice
- `POST /api/voices/preview` → `{ "voiceId", "text", "speed" }`; returns audio, or `204` with `x-tts-fallback: browser` in demo mode

## Translation

- `POST /api/translate` → `{ "title", "sourceVideoUrl", "targetLanguage" }` → `201 { "translation" }`
- `GET /api/translate`, `GET /api/translate/:id`

## Brand kit

- `GET /api/brand` → `{ "brand": BrandKit | null }`
- `PUT /api/brand` → `{ "name", "logoUrl", "primaryColor": "#0f766e", "accentColor"?, "defaultAvatarId"?, "defaultVoiceId"?, "defaultAspect"?, "defaultResolution"? (`720p` | `1080p`), "captionsByDefault"? }`
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

- `POST /api/billing/checkout` → `{ "url" }` to start a Pro upgrade (Stripe Checkout, or an instant upgrade with the mock); browser sessions only (`403` with a key); in a workspace, owners only (`403` for editors)
- `POST /api/billing/portal` → `{ "url" }` for the Stripe Billing Portal (the mock downgrades to Free); same access rule as checkout
- `POST /api/webhooks/stripe` receives Stripe events (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`), verified with `STRIPE_WEBHOOK_SECRET`
- `GET /api/status` reports `renderLimitPerMonth` for the active owner and `usage.plan`

## Preferences and health

- `GET /api/prefs` → `{ "prefs", "suggestedEmail", "emailDelivers" }`; `PUT /api/prefs` → `{ "emailOnComplete"?: "you@example.com" }` (omit to turn off). When set, one email per video on completion or failure, with a link to open it; sent through the email provider.
- `GET /api/health` (public) → `{ "ok", "store", "persistence", "providers", "latencyMs", "time" }`, `503` when the store is unreachable. For uptime monitors.

## Account data

- `GET /api/account/export` downloads everything stored for the active account or workspace as JSON (key hashes, the webhook secret, and cover image bytes are left out; each video lists its cover's type and size). Session only; `403` with a key.
- `DELETE /api/account` with `{ "confirm": "DELETE" }` removes every record of the active account or workspace (cloned voices are deleted at the provider too) and returns counts per kind. Session only; in a workspace, owners only (`403` for editors). Workspace membership is unaffected.

## Outbound webhooks

Save an endpoint in **Settings → Webhook notifications**. Each delivery is a `POST` with:

```
Content-Type: application/json
X-Studio-Event: video.completed | video.failed | lead.captured | test
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

Deliveries are attempted once, after the response that completed the render, with a 10-second timeout and no redirects. The last outcome is shown in Settings. Endpoints on private or local addresses are rejected, and the delivery connects only to the addresses that passed that check.

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
