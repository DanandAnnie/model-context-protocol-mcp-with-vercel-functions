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

Public routes need no key: `/api/videos/:id/captions`, `/api/videos/:id/cover`, `/api/videos/:id/view`, `/api/videos/:id/watch`, `/api/videos/:id/cta`, `/api/videos/:id/unlock`, `/api/videos/:id/lead`, `/api/talk/:id`, `/api/webhooks/:provider`, `/api/auth/*`, `/share/:id` (which takes `?autoplay=1` to start muted and `?loop=1` to repeat, the options the video page's Embed button offers).

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
| `scenes` | array | each `{ script, background, avatarId?, voiceId?, audioId?, layout? }`; `audioId` names an audio clip from `/api/clips` that the presenter lip-syncs to instead of a voice speaking `script` (the script is then what the clip says, kept for captions and search; the scene's voice, speed, pitch, and emotion do not apply; HeyGen uploads the clip once as an audio asset, D-ID speaks it in a single-scene video only, and a clip of another account is a `404`), and the stored scene carries `audioName` and `audioSeconds`; `layout` is `{ scale: 0.5–1.5, x: -1..1, y: -1..1, framing? }`, the presenter's size and offset in the frame (HeyGen renders it as the character's `scale` and `offset`; other renderers use their default), and `framing` is `full` (the default, stored as absent), `closeUp`, or `circle`, sent to HeyGen as the avatar's `avatar_style` (`normal`, `closeUp`, `circle`); a photo avatar has only HeyGen's `square` and `circle` talking-photo styles, so a close-up shows it in full; stored scenes also carry `avatarName` and `voiceName` |
| `avatarId` | string | from `GET /api/avatars` |
| `voiceId` | string | from `GET /api/voices` |
| `aspect` | `16:9` \| `9:16` \| `1:1` | default `16:9` |
| `resolution` | `720p` \| `1080p` | default `1080p`; the short side of the frame (1080p: 1920×1080, 1080×1920, 1080×1080; 720p: 1280×720, 720×1280, 720×720). HeyGen renders at these sizes; D-ID and the demo renderer record the value but output at their native size |
| `background` | `{ type: "color" \| "image" \| "video", value }` | a hex colour, a public image URL, or a public http(s) video URL (MP4 or WebM) that loops behind the presenter and fills the frame on HeyGen (other renderers use their default); default light grey |
| `script` pauses | text | write `[pause]` (one second) or `[pause 2.5s]` (up to 10 seconds) anywhere in a script or scene script; the stored script keeps the marker, HeyGen and ElevenLabs voices receive `<break time="…"/>` tags of at most three seconds each (a longer pause is several in a row), D-ID's Microsoft voices receive an SSML fragment (`ssml: true`, the rest of the text escaped, breaks of at most five seconds), the demo renderer adds the time to its length, captions leave a gap of that length between lines (and end early by a trailing pause), the AI writer's Improve actions and subtitle translations carry markers through as tokens so they come back as written, a script or scene of nothing but pauses is refused, and markers never appear in captions, the share page's transcript and link preview, or library search |
| `captions` | boolean | default `false` |
| `captionStyle` | object | `{ position: "bottom" \| "top", size: "small" \| "medium" \| "large", look?: "classic" \| "bold" \| "yellow" \| "minimal", font?: "sans" \| "serif" \| "rounded" \| "mono" }`, how subtitles sit, read, and look in the share player (looks: white on a dark box, bold on a solid box, yellow on a dark box, or white with a shadow and no box; `classic` is stored as absent); of these only the position is written to a file, as a `line:5%` cue setting in the WebVTT file for `top`, and the SRT carries no style; a value equal to the default is stored as absent; when set, HeyGen is told not to burn captions into the file so this look is the only one, which means the downloaded file of a styled video carries no captions (the share page's track is on from the start, except for a HeyGen file that already carries captions, where it waits in the CC menu) |
| `speed` | 0.5–1.5 | default `1` |
| `pitch` | integer -50–50 | voice pitch shift; HeyGen applies it (`voice.pitch`), other renderers keep the voice's natural pitch; `0` is stored as absent |
| `emotion` | `Excited` \| `Friendly` \| `Serious` \| `Soothing` \| `Broadcaster` | speaking style, spelled as HeyGen spells it; HeyGen applies it (`voice.emotion`) to every scene whose voice supports one (voices list `emotionSupport` when HeyGen reports it; a voice that reports `false` is sent none), other renderers keep the voice's natural delivery; absent means natural |

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

Query parameters, all optional: `q` (matches title, description, script, avatar, and voice), `status` (`processing`, which includes queued, `completed`, or `failed`), `folder` (a name; pass it empty for unfiled videos), `batch`, `sort` (`newest`, `oldest`, `title`, `views`), `limit` (1–200; omit it to receive every match), `review` (`pending`, `approved`, `changes`, or `none` for videos never sent for review), and `trash` (`true` or `1` lists the trash instead of the library, newest deletion first). Returns `{ "videos", "matched", "total", "hasMore", "folders", "rendering", "trashed" }`: `matched` counts the query's results before `limit`, `total` the whole library (never the trash), `folders` the names in use, `rendering` the renders still in flight, and `trashed` the videos in the trash. The newest ten in-flight renders are refreshed from the provider on the way out, so polling the list is enough to see completions.

### `GET /api/videos/analytics` — the library's share analytics as a CSV download

One row per video, newest first: `id`, `title`, `status`, `created`, `folder`, `duration_sec`, `views`, `views_7d` (views in the last seven UTC days including today), `last_viewed`, `watched_25` … `watched_100`, `finish_rate` (percent of views that played to the end; empty before any view), `cta_clicks`, and `share_link` (built from `APP_URL` when set). Cells are quoted and formula-safe, with a byte-order mark for Excel.

### `GET /api/templates`, `POST /api/templates`, `GET /api/templates/:id`, `DELETE /api/templates/:id` — saved templates

A template is a starting point for the editor: scenes (with any per-scene presenter), avatar, voice, aspect, quality, captions, and speed, up to 50 per account. Create one from a video you own with `{ "fromVideoId", "title"?, "description"? }` (the title defaults to the video's), or spell it out with `{ "title", "scenes", "avatarId"?, "voiceId"?, "aspect"?, "resolution"?, "captions"?, "captionStyle"?, "speed"?, "pitch"?, "emotion"? }` (scenes may carry a `layout` like a video's). `GET /api/templates` returns `{ "templates" }`, newest first; the editor opens one at `/create?template=<id>`.

### `GET /api/videos/:id` — fetch; refreshes the status from the provider while rendering. Answers `{ "video", "shareOrigin" }`: `shareOrigin` is the origin public links are built on (`APP_URL` when it is set, else the request's own), the same one the share email uses, so copied, embedded, and posted links match it
### `PATCH /api/videos/:id` — `{ "title"?: string, "description"?: string, "folder"?: string, "shareDownload"?: boolean, "shareGate"?: boolean, "shareDisabled"?: boolean, "shareExpiresAt"?: string | null, "cover"?: string | null, "sharePassword"?: string | null, "shareCta"?: { "label", "url" } | null }` (`description`, up to 500 characters, is shown under the share-page player and becomes the link preview's description in place of the script excerpt, an empty string removes it, and a retried render keeps it; empty `folder` means unfiled; `shareDownload` shows a download button on the public share page; `shareGate` makes the share page ask for the viewer's email (and optionally a name) before the player shows, a soft gate for collecting leads rather than a lock (use `sharePassword` to protect a video); `shareDisabled` takes the share link offline: the share page, its captions, and the view, watch, and click beacons answer `404` to the public while the owner keeps full access; `shareExpiresAt` (an ISO 8601 time with a UTC offset, e.g. `2030-06-01T10:00:00+02:00` or `...Z`, in the future, or `null` to clear) does the same automatically once that time passes, stored as a UTC instant; `cover` (a `data:image/...` URL, PNG/JPEG/WebP/GIF, 2 MB decoded, or `null` to remove) sets a custom poster kept in its own record and served by `GET /api/videos/:id/cover` (the video carries `cover: { updatedAt, mimeType, bytes }`; `updatedAt` versions the URL); `sharePassword` (4–64 characters, or `null` to remove) protects the share link: visitors must enter it before the page plays, captions and beacons need the resulting cookie, and the video carries `shareLocked: true` while the password itself is kept only as a salted hash in its own record; `shareCta` puts a call-to-action button under the share-page player, label up to 40 characters and an http(s) link, `null` removes it)
### `DELETE /api/videos/:id` — moves the video to the trash: it leaves the library, its share page, captions, cover, and beacons answer `404` to the public, and the owner can still read and restore it for 30 days, after which it is deleted for good (side records included) the next time the library is listed; `?permanent=true` deletes a trashed video for good straight away (`409` for a video that is not in the trash). The video carries `deletedAt` while trashed
### `POST /api/videos/:id/restore` — brings a trashed video back to the library → `{ video }`; a live video is returned as is
### `POST /api/videos/folders` — `{ "from": "Q4", "to": "Q4 2026" }` renames a folder by moving every video in it (trashed ones included); an empty `to` removes the folder and leaves its videos unfiled; renaming onto an existing folder merges them → `{ "moved" }`
### `POST /api/videos/bulk` — `{ "action": "move", "ids": [...], "folder": "Q4" }`, `{ "action": "delete", "ids": [...] }` (to the trash), `{ "action": "restore", "ids": [...] }`, `{ "action": "purge", "ids": [...] }` (delete trashed videos for good; a video that is not in the trash is reported in `missing`), or `{ "action": "share", "ids": [...], "shareDisabled": true | false }` (switch the share links off or on) → `{ "done", "missing" }`
### `POST /api/videos/:id/share` — `{ "to": ["jane@example.com", ...], "message"?: string }`

Emails the share link of a **completed** video to up to 10 recipients (de-duplicated; `message` is an optional plain-text note of up to 500 characters shown above the link; a password-protected link tells the recipient a password is needed without including it). `404` for a video that is not yours, `409` while the render is not finished or the share link is off or expired, `429` beyond 60 recipients per sender per hour (600 per instance); a refused batch takes nothing from the allowance. The link uses `APP_URL` when it is set, otherwise the request's origin. Returns `{ "sent": [...], "failed": [{ "to", "error" }], "delivers" }`; `delivers` is `false` with the demo email provider, which only records the message. The status is `502` when no recipient could be sent to.

### `POST /api/videos/:id/subtitles` — `{ "language" }`, `DELETE /api/videos/:id/subtitles?language=`
Translated subtitle tracks. `POST` translates the script into the language with the script provider (Claude; the demo provider prefixes the script with the language) and keeps it on the video as `subtitles[language]`, up to five languages, re-translating a language the video already has (matched without regard to case); the language is a name in letters (`Spanish`, `Portuguese (Brazil)`); `201 { "video" }`, `409` while the video is in the trash. Two requests for one video that overlap are written one after the other, so the cap and the one-track-per-language rule hold whichever lands last. The share page offers every track in the player's subtitle menu and `GET /api/videos/:id/captions?lang=<language>` (with `&format=vtt` for WebVTT) downloads one under the same public rules as the captions; an unknown language is a `404`. `DELETE` removes a track (the key as stored, matched without regard to case, whatever naming rule it was added under) and answers `{ "video" }`. An owner edit, a trash, or a restore that overlaps a translation keeps the track it added (and does not bring back one it removed). The library listing (`GET /api/videos`) leaves the subtitle text off its cards; `GET /api/videos/:id` carries it. Cues for a translation into a language written without word spaces (Chinese, Japanese, Thai; Korean is read at the same density) are kept to 40 such characters (a mixed sentence counts each of them as two and a quarter Latin ones against the 90-character cue): a sentence longer than that is cut at its clause marks, then at any spaces it has, then by character; a closing bracket or quote stays with its sentence.

### `GET | POST /api/videos/:id/comments`, `DELETE /api/videos/:id/comments/:commentId`
Review notes on a video for its owner and workspace members; viewers of the share page never see them. `GET` → `{ "comments": [{ "id", "videoId", "authorId", "authorEmail"?, "text", "atSec"?, "mentions"?, "createdAt" }] }` oldest first; `POST { "text", "atSec"? }` (up to 1000 characters, 200 comments per video; `atSec` pins the note to a moment, in seconds from the start, kept to tenths, only on a finished video (`400` before that) and at most half a second past its length (`400` beyond it; demo renders, which all play one sample clip, are not checked), `null` or absent for a note on the whole video) → `201 { "comment" }`, credited to the signed-in person (a script with an API key is credited to the key's owner); `DELETE` removes the caller's own comment (`403` for someone else's, `404` for a comment on another video). Comments go with the video when it is deleted for good and are part of the account export. In a workspace, `@email` naming a member (case-insensitive, up to 10 per comment, the author and non-members ignored) is recorded as `mentions: [{ "userId", "email" }]` and each person is emailed the comment after the response (60 mention emails per author per hour, 600 per instance; past either the comment still posts but nobody is emailed), with a link to `/videos/:id?ws=<workspace>` (plus `&t=<seconds>` for a pinned note, which opens the player at that moment; the email names it, "at 1:05") that switches the reader into the workspace when they belong to it and are not already in it; a mention starts at the beginning of the text or after a space or opening punctuation, so the middle of an address is not one; mail goes out only when an email provider is configured.

### `POST /api/videos/:id/review` — `{ "action": "request" | "approve" | "changes" | "withdraw", "note"? }`

Review and approval for a workspace video (a video in a personal space answers `400`). Anyone who can edit asks for a review of a finished render, with an optional note of up to 500 characters (`409` while one is pending or the video is still rendering or failed); a workspace owner signed in with a session approves or asks for changes (`403` for editors and API keys; `changes` needs a `note`; `409` unless a review is pending); the person who asked, or an owner, withdraws a pending request (a request made with an API key is withdrawn by a person signed in). A new request after a decision starts over, and changing the title, description, cover, or call-to-action of an approved video clears the approval, since those are what the share page shows. Returns `{ video }`, which carries `review: { status: "pending" | "approved" | "changes", requestedById, requestedByEmail?, requestedAt, note?, decidedById?, decidedByEmail?, decidedAt? }`; requests and decisions appear in the activity feed (`video.review_requested`, `video.approved`, `video.changes_requested`).

### `POST /api/videos/:id/retry`

Submits a **failed** render again as a new video with the same scenes, presenter, look, and quality; the new video keeps the original's folder, description, and batch row and carries `retryOf` with the original id. Returns `201 { video }` (or `502` when the provider refuses the start again). `409` when the video is not failed, `404` when it is not yours.

### `GET /api/videos/:id/cover` — the custom poster image (public under the share page's rules: `404` while the link is offline, for a password-protected link without the unlock cookie, and when no cover is set; `?v=` responses are immutable, and `public` only for a link that is neither offline nor password-protected, with a lifetime capped at the link's expiry)
### `GET /api/videos/:id/captions` — SRT; add `?format=vtt` for WebVTT, whose cues carry the video's caption position (public; while the share link is offline only the owner's own request gets them, and a password-protected link needs the unlock cookie or the owner)
### `POST /api/videos/:id/lead`, `GET /api/videos/:id/leads` — the email gate
`POST { "email", "name"? }` (public; the share page's form) records a viewer for a video whose `shareGate` is on and sets a cookie that lets them through to the player for 30 days; a video that does not ask, or that the public cannot open, answers `404`, a password-protected link needs its unlock cookie first (`401`), and each viewer may submit five times per ten minutes; past 300 submissions per video in that window viewers are still let through but not recorded, so a flood of made-up addresses cannot lock real viewers out. The page shows the player as soon as the email is accepted, so an embed in a browser that blocks third-party cookies still plays (the cookie is `Partitioned` in production and only spares a return visit the form). A gated link's preview leaves out the video and the script excerpt; the captions file stays public, as on any share page. Addresses are lower-cased and kept once per video: the first submission fires the `lead.captured` webhook with `{ "source": "share", "videoId", "videoTitle", "email", "name"?, "capturedAt" }` (a shared presenter's leads carry `"source": "presenter"`), and a return visit only updates `lastSeenAt` and `visits`. `GET .../leads` (owner or editor; a workspace viewer gets `403`) → `{ "leads": [{ "id", "videoId", "email", "name"?, "createdAt", "lastSeenAt", "visits" }] }`, newest first; `?format=csv` downloads them with formula-looking cells defused. Leads stay when the gate is turned off, are part of the account export, and are deleted with the video when it is deleted for good
### `PUT | DELETE /api/videos/:id/captions` — `PUT { "cues": [{ "startMs", "endMs", "text" }] }` saves corrected captions in the script's language (1–500 lines, each up to 300 characters, whole milliseconds up to four hours, every line ending after it starts and starting no earlier than the line before it ends; an error names the line; in the WebVTT file a line's `<`, `>`, and `&` are escaped and in SRT a `-->` is written `→`, so a line's text can never start a cue of its own), which then serve the share page's track and every download in place of the lines timed from the script; the video carries them as `captionCues`, saving clears an approval, a trashed video answers `409`, and viewers get `403`. `DELETE` drops them so the captions follow the script again. `GET ...?format=json` returns `{ "cues", "edited" }`, the lines currently served. Captions a renderer burned into the picture keep the original wording, and translated tracks (`?lang=`) are not affected
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

`background`, `captions`, `captionStyle`, `speed`, `pitch`, `emotion`, and `resolution` take the same values and defaults as a single video. `POST` returns `{ "batchId", "videos", "skipped", "failed" }`. Rows beyond the monthly allowance are skipped; rows the provider rejected are reported in `failed`. Up to 100 rows per batch.

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

Actions: `shorten`, `expand`, `tone`, `translate`, `polish`. Returns `{ "script": "…" }`. A `translate` keeps the terms in the brand kit's `glossary` exactly as written.

### `POST /api/video-agent` — a whole video from one prompt

```json
{ "prompt": "A TikTok explaining three tips for staging a home", "lengthSec": 60, "language": "English", "orientation": "auto", "mode": "generate" }
```

The script writer plans the video: a title, one scene per idea (a hook and a call to action framed as close-ups), and a frame orientation (portrait for social formats, landscape otherwise). `prompt` is 3–10,000 characters; `url` (optional) is a public web page the plan uses as its only source of facts, under the same rules as the script writer's; `avatarId` and `voiceId` (optional) choose the presenter and voice, else the brand kit's defaults, else the first ones listed (a chosen presenter brings its own default voice); `orientation` is `auto`, `landscape`, `portrait`, or `square`; `lengthSec` is 15–300 (default 60); `mode` is `generate` (default) or `plan`. Every scene gets the brand kit's background, captions are on unless the kit turns them off, and the kit's quality applies; the plan keeps to ten scenes and the 5000 characters a video holds.

- `mode: "generate"` renders straight away and answers `201 { "video", "draft" }`, counted against the render allowance like `POST /api/videos` (`502` with the failed video if the render could not start).
- `mode: "plan"` answers `{ "draft" }` without rendering: `{ title, scenes: [{ script, background, layout? }], avatarId, voiceId, aspect, resolution, captions }`, a body `POST /api/videos` takes as is. The Video Agent page opens it in the editor for review.

An unknown presenter answers `404`, an unknown voice, an unreadable page, or a prompt with nothing to plan `400`, and viewers `403`.

## Interactive avatar

`POST /api/chat` returns one spoken-style reply in character. Keep the last 20 messages; the last one must be from the visitor. Rate limited to 60 turns per 10 minutes per client.

```json
{ "avatarId": "stock_1", "instructions": "You represent Acme Realty…", "language": "English",
  "messages": [{ "role": "user", "content": "Do you have open houses this weekend?" }] }
```

Returns `{ "reply": "…" }`.

### Shared presenters (agents)

- `GET /api/agents` → `{ "agents", "shareOrigin" }` (`shareOrigin` is the origin the `/talk/:id` links and the embed script are built on: `APP_URL` when set, else the request's own), `POST /api/agents` → `{ "name", "avatarId", "voiceId"?, "instructions"?, "greeting"?, "starters"?, "knowledgeUrl"?, "language"?, "isPublic"?, "collectEmail"? }` → `201 { "agent" }` (20 per account). `greeting` (up to 200 characters; an empty string removes it) is shown to visitors as the presenter's first message and sent back with the transcript; `starters` (up to three questions of 80 characters; an empty list removes them) are offered as chips until the visitor's first message. `knowledgeUrl` names a public web page that is read once (same public-host, HTML-only, 1 MB rules as the script writer's page import; a page that cannot be read is a `400`); its readable text (at least 80 characters, kept up to 6000) is stored on the agent as `knowledge` with `knowledgeUpdatedAt`, included in the account export, and handed to the model after the instructions as untrusted reference material. Visitors never see it
- `GET | PATCH | DELETE /api/agents/:id` (`PATCH` takes any subset of the fields above; `knowledgeUrl` reads the page again, `null` forgets it)
- Public, no key: `GET /api/talk/:id` → the visitor-safe view (name, avatar, language, `greeting`, `starters`, brand; never instructions; an uploaded brand logo comes as a path relative to the app's origin, `/api/talk/:id/logo?v=…`, instead of the file itself; it answers 404 once the link is paused or removed, and caches may keep it for up to an hour) and `POST /api/talk/:id` → `{ "messages": [...], "conversationId"? }` → `{ "reply", "conversationId" }` (send the id back on later turns so the visit is one transcript), limited to 30 turns per 10 minutes per client and 600 per hour per agent. `404` when the agent is private or deleted. The page `/talk/:id` is embeddable in an iframe.
- `POST /api/talk/:id/lead` → `{ "conversationId", "email", "name"? }` records a visitor's contact details on the conversation (shown when the agent has `collectEmail`) and sends `lead.captured` to the owner's webhook; 5 per 10 minutes per client
- `POST /api/prefs/favorites` → `{ "kind": "avatar" | "voice", "id", "on": boolean }` stars or unstars an avatar or voice for the owner (newest 50 per kind kept); `GET /api/prefs` returns them as `favoriteAvatarIds` and `favoriteVoiceIds`, and every picker lists starred items first
- `GET /api/agents/:id/conversations` → the owner's transcripts (newest first, up to 50 visits of 40 messages); add `?format=csv` for a lead list download (up to 1000 conversations: started, last message, email, name, message count, first question, last reply; cells that look like spreadsheet formulas are neutralised); `DELETE` clears them. Transcripts are also removed when the agent is deleted.
- Live video (HeyGen Streaming, when `AVATAR_PROVIDER=heygen`): `POST /api/talk/:id/live` opens a session → `{ "available": true, "sessionId", "url", "accessToken", "expiresAt" }` or `{ "available": false }`; `POST /api/talk/:id/live/:sessionId` → `{ "text" }` makes the presenter say a reply; `DELETE` closes it. Sessions are scoped to the presenter, capped per client, and expire after 10 idle minutes. The owner's interactive page uses `/api/live` and `/api/live/:sessionId` the same way.
- Website embed: `<script src="https://<app>/embed/agent.js?id=agent_…" async></script>` adds a floating launcher that opens the talk page; options `position=left|right`, `color=%23hex`, `label=…`.

## Avatars and voices

- `GET /api/avatars` → `{ "avatars": [...] }` (custom photo avatars first, then the library; a library presenter may carry `previewVideoUrl`, a short clip the tiles play on hover)
- `POST /api/avatars` → `{ "name", "imageUrl", "gender"?, "defaultVoiceId"? }` where `imageUrl` is an https URL or a `data:image/…` upload (≤ 6 MB) and `defaultVoiceId` names a voice from `GET /api/voices` (cloned voices included; an unavailable voice is a `400`) that the editor switches to when the avatar is picked. Private and local hosts are rejected.
- `PATCH /api/avatars/:id` → `{ "name"?: string, "gender"?: "male" | "female" | "neutral" | null, "defaultVoiceId"?: string | null }` renames a photo avatar, changes its gender, or sets its default voice (`null` clears either; deleting a cloned voice clears it from every avatar that named it); library presenters answer `404`. Videos keep the name they were rendered with; shared presenters built on the avatar take the new name
- `DELETE /api/avatars/:id`
- `GET /api/voices` → `{ "voices": [...] }` (the account's cloned voices first, `source: "custom"`; HeyGen voices carry `emotionSupport` when HeyGen reports whether the voice takes an `emotion`)
- `POST /api/voices/clone` → `{ "name", "samples": ["data:audio/webm;base64,…"], "language"? }` (one to five audio data URLs, 10 MB total, five clones per account) → `201 { "voice" }`; `PATCH /api/voices/:id` → `{ "name" }` renames a clone (provider voices answer `404`; videos keep the name they were rendered with, and the provider's own copy of the voice keeps its name); `DELETE /api/voices/:id` removes a clone. Cloning runs on ElevenLabs when it is the voice provider; the demo provider saves the clone and previews use the browser voice
- `POST /api/voices/preview` → `{ "voiceId", "text", "speed" }`; returns audio, or `204` with `x-tts-fallback: browser` in demo mode
- Audio clips for audio scenes: `POST /api/clips` → `{ "name", "audio": "data:audio/wav;base64,…", "durationSec"? }` saves a PCM WAV (its length is computed from the file's format and data size) or an MP3 (`durationSec` required; the bytes must start with an ID3 tag or an MPEG frame), 3 MB and 90 seconds at most so a clip fits in one request body on Vercel, 20 clips per account → `201 { "clip": { id, name, mimeType, bytes, durationSec, createdAt } }`. The editor records or takes any audio file the browser can decode and converts it to 16 kHz mono WAV before saving (a recording stops at 90 seconds; a longer file is refused, and longer narration goes across several scenes). HeyGen's asset upload is documented for MP3; WAV acceptance has not been checked against the live API. `GET /api/clips` → `{ "clips" }` newest first (metadata only); `GET /api/clips/:id` returns the audio to the owner; `DELETE /api/clips/:id` removes a clip and its audio (rendered videos keep their footage; a retry or copy that names a deleted clip is refused, and the editor drops it from a restored scene)

## Translation

- `POST /api/translate` → `{ "title", "sourceVideoUrl", "targetLanguage" }` → `201 { "translation" }`, or `{ "title", "sourceVideoUrl", "targetLanguages": [...] }` (1 to 5 languages, repeats ignored without regard to case) → `201 { "translations" }`, one dubbing job per language, each titled `"<title> (<language>)"`. Either form takes `"audioOnly": true` to dub the voice alone and leave the mouth as filmed (HeyGen `translate_audio_only`; lip-synced otherwise) and `"speakers"` (1–10, this app's limit; `null` means not set) to say how many people talk so each keeps a voice of their own (HeyGen `speaker_num`; detected when absent), `"quality"` (`"speed"`, the default, or `"precision"`, slower for a more natural dub; HeyGen `mode`), `"removeMusic": true` to leave the background music out (HeyGen `disable_music_track`), and `"enhanceSpeech": true` to clean up the speech (HeyGen `enable_speech_enhancement`), `"proofread": true` to translate the lines first and dub them only once they are approved (below), and `"keepGlossary": true` to keep the brand kit's glossary terms exactly as written: the job then stores the kit's terms at that moment as `glossary`, and HeyGen gets them as a brand glossary's `do_not_translate_terms` (`brand_glossary_id`; one glossary per set of terms, named `Avatar Studio terms <digest>` and created once with an `Idempotency-Key`, found by name when it already exists, so a kit edit never changes a glossary an earlier dub used; a glossary HeyGen cannot set up fails the dub rather than dubbing without the terms); all are stored on each job, defaults as no field. Jobs go to HeyGen's `POST /v3/video-translations`; a completed job carries `captionUrls: { srt?, vtt? }`, the dub's subtitle files where HeyGen made them. A job the provider refuses is returned as failed while the rest start (the response then carries an `error` saying how many failed); `502` when none started
- Proofread dubs: a job made with `"proofread": true` goes to HeyGen's `POST /v3/video-translations/proofreads` (same source, language, and options) and carries `proofreadStage`: `"preparing"` while the lines are translated (polled like a running job), then `"ready"` with `proofreadCues` (`[{ "startMs", "endMs", "text" }]`, read from the proofread's SRT; more than 500 lines fails the job), then `"dubbing"` while the dub is being started. `PATCH /api/translate/:id` with `{ "lines": [...], "basedOn"? }` (one text per line, in order, 1–300 characters each; the timing stays as translated; `basedOn` is the job's `updatedAt` when the lines were opened, and a mismatch answers `409` so one editor never overwrites another's corrections) saves corrections; `POST /api/translate/:id/dub`, with the same body or none, starts the dub: the app serves the lines as SRT at `GET /api/translate/:id/srt?token=…` (public, behind a secret kept on the job and never sent to the browser; `404` without it), hands that link to HeyGen (`PUT .../proofreads/:id/srt`, then `POST .../generate`), and the job becomes an ordinary dub with a `providerJobId`. Both answer `409` once the lines are no longer open (a different line count, a stale `basedOn`, a dub already started); the start is claimed with a conditional write, so of two requests at once (two clicks, two editors, two server instances) only one reaches HeyGen. When HeyGen refuses the dub (a 4xx), `502` with the lines open again and the reason in `error`; when it does not answer (a timeout after 20 seconds, a dropped connection, or a 5xx), `502` too, but the dub may have started, so the lines stay claimed and say so. A job HeyGen does not know yet is given 30 minutes from the dub's start (`dubStartedAt`), not from the proofread's. A start that never finished (no answer, the server stopped mid-call, or an accepted dub that could not be recorded after three tries, whose HeyGen job id is then logged) shows the lines again after two minutes, with a warning to check HeyGen before dubbing again. A finished proofread whose subtitle link HeyGen refuses fails the job (a 403 or 404 straight after completion, a 408, and a 429 are asked about again with a fresh link), and lines still not ready after a day are given up. The SRT link is built on `APP_URL`, which must be the app's public https address: with HeyGen, `"proofread": true` answers `400` without it (Vercel's per-deployment URLs are usually behind Deployment Protection, so they are not used); demo mode needs nothing. Account exports leave the secret out; viewers get `403`
- `GET /api/translate`, `GET /api/translate/:id`: both ask the provider about jobs still running (the list up to five per request, each job at most every 15 seconds, least recently asked first) and renew a finished HeyGen job's presigned links once they are an hour old

## Brand kit

- `GET /api/brand` → `{ "brand": BrandKit | null }`
- `PUT /api/brand` → `{ "name", "logoUrl", "primaryColor": "#0f766e", "accentColor"?, "defaultBackground"? (an image or video `background` as on a video, behind every new scene instead of the primary colour), "pronunciations"? (up to 50 `{ "word", "sayAs" }` rules, a word of up to 40 characters and a spelling of up to 80; every render replaces each word, whole and case-insensitively, in the script handed to the renderer while the stored script and its captions keep the spelling), "glossary"? (up to 50 terms of 2 to 60 characters, repeats ignoring case dropped, that `translate` revisions and subtitle languages keep exactly as written: each whole, case-insensitive occurrence (a letter, mark, digit, or underscore on either side means it is part of a longer word; Chinese, Japanese, and Thai text around it does not) reaches the model as a token, with what the token stands for, and comes back in the source's spelling; dubbing jobs keep them when made with `keepGlossary`, see `POST /api/translate`), "defaultAvatarId"?, "defaultVoiceId"?, "defaultAspect"?, "defaultResolution"? (`720p` | `1080p`), "captionsByDefault"?, "watermark"? (`top-left` | `top-right` | `bottom-left` | `bottom-right`: the logo is laid over the share and embed player in that corner, not in fullscreen or picture-in-picture, the video file unchanged; shown only while the kit has a logo) }`. An uploaded logo is served to share pages by `GET /api/videos/:id/logo` (public under the share page's rules: 404 for a missing, trashed, or offline video and for a kit whose logo is an external URL, which the page links directly; a password does not hide it, since the locked page shows the brand header; a request whose `v` is the kit's current version may be cached for up to an hour and never past the link's expiry, any other is `no-store`; sent with `nosniff` and a sandboxing Content-Security-Policy). An uploaded logo must be PNG, JPEG, WebP, GIF, SVG, AVIF, BMP, or ICO (`400` otherwise)
- `DELETE /api/brand`

## Workspaces

- `GET /api/workspaces` → `{ "personalId", "activeId", "workspaces": [...] }`
- `POST /api/workspaces` → `{ "name" }` → `201`
- `GET | PATCH | DELETE /api/workspaces/:id` (`PATCH` renames; owners only; `DELETE` removes the workspace and everything it owns, as the account deletion does for a person: videos with their comments, covers, and viewer emails, avatars, voices (provider clones included), clips, templates, presenters and transcripts, the brand kit, keys, the webhook, the plan, and the activity feed, then its members and invites; its keys are revoked before anything else goes. `400` while a Stripe subscription can still bill the workspace: cancel it first)
- `POST /api/workspaces/:id/invites` → `{ "email"?, "role": "owner" | "editor" | "viewer" }` (default `editor`) → `201 { "invite", "url" }`; `DELETE /api/workspaces/:id/invites/:token` revokes. Roles: owners manage members, billing, and the account's data; editors create, change, and delete content; viewers watch, download, and comment. While a viewer's active owner is a workspace, every route that creates, changes, or deletes content answers `403` (comments and favourites are allowed); viewers cannot mint API keys, and a member made a viewer loses the keys they minted under the workspace
- `PATCH /api/workspaces/:id/members/:userId` → `{ "role": "owner" | "editor" | "viewer" }` (owners only; the last owner cannot be demoted); `DELETE` removes (owners) or leaves (self)
- `POST /api/workspaces/switch` → `{ "id": "ws_…" }` or your personal id; sets the `studio_workspace` cookie (browser sessions only; keys are bound at minting)
- `GET | POST /api/invites/:token` describes and accepts an invite
- `GET /api/activity?limit=50` → `{ "events": [{ "id", "ownerId", "kind", "actorId", "actorEmail"?, "subject"?, "subjectId"?, "count"?, "role"?, "createdAt" }] }`, the active account's or workspace's activity, newest first (`limit` up to 200; the last 200 events are kept). Kinds: `video.created`, `video.trashed`, `video.restored`, `video.purged` (single videos carry the title as `subject`; bulk actions carry `count`), `batch.created` (`subject` is the batch title, `count` the rows started), `member.joined`, `member.left`, `member.removed`, `member.role` (`subject` is the member's email or id, `role` the new role), `apikey.created`, `apikey.revoked`, `brand.saved`, `brand.removed`, `agent.created`, `agent.deleted`. `actorId` is the signed-in person (their email in `actorEmail` when the account mode knows one), or the owner id itself when the request carried an API key and no session. Only changes are recorded: a video trashed twice, a member opening an invite link again, or a role set to what it already was leaves no event, and a render or batch the provider refused outright (`502`) is not "created". Recording is best effort: a failure to resolve the person or to write is logged and the request that did the work still succeeds. The feed is part of the account export and is removed with the account's data. On Supabase, re-run `supabase/schema.sql` after upgrading so the `activity` kind passes the table's check constraint; until then events are refused and logged, and the feed stays empty

## Keys and notifications

- `GET /api/keys`, `POST /api/keys` → `{ "name" }` → `201 { "key", "secret" }`, `DELETE /api/keys/:id`
- `GET | PUT | DELETE /api/notifications` (`PUT` → `{ "url" }`), `POST /api/notifications/test`

## Billing

- `POST /api/billing/checkout` → `{ "url" }` to start a Pro upgrade (Stripe Checkout, or an instant upgrade with the mock); browser sessions only (`403` with a key); in a workspace, owners only (`403` for editors)
- `POST /api/billing/portal` → `{ "url" }` for the Stripe Billing Portal (the mock downgrades to Free); same access rule as checkout
- `POST /api/webhooks/stripe` receives Stripe events (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`), verified with `STRIPE_WEBHOOK_SECRET`; with Supabase storage (where a missing workspace is really deleted, not just unknown to one in-memory instance), a subscription bought for a workspace deleted while its checkout was open is cancelled at Stripe at once (if Stripe cannot be reached the route answers `500` so Stripe delivers the event again), and later events for a deleted workspace are ignored
- `GET /api/status` reports `renderLimitPerMonth` for the active owner and `usage.plan`

## Preferences and health

- `GET /api/prefs` → `{ "prefs", "suggestedEmail", "emailDelivers" }`; `PUT /api/prefs` → `{ "emailOnComplete"?: "you@example.com" }` (omit to turn off). When set, one email per video on completion or failure, with a link to open it; sent through the email provider.
- `GET /api/health` (public) → `{ "ok", "store", "persistence", "providers", "latencyMs", "time" }`, `503` when the store is unreachable. For uptime monitors.

## Account data

- `GET /api/account/export` downloads everything stored for the active account or workspace as JSON (key hashes, the webhook secret, and cover image bytes are left out; each video lists its cover's type and size; the activity feed is included). Session only; `403` with a key.
- `DELETE /api/account` with `{ "confirm": "DELETE" }` removes every record of the active account or workspace (cloned voices are deleted at the provider too) and returns counts per kind; `400` while a Stripe subscription can still bill the account (cancel it first from Settings, Manage subscription, which Stripe customers see on Free too; otherwise it keeps billing with no plan left to manage it). For anyone who has been a Stripe customer, Stripe is asked about all of their subscriptions, so a missed webhook does not decide it; while Stripe cannot be reached the delete is refused, also for former customers now on Free. Keys go first and cloned voices next; a voice the provider fails to delete stops the run with `409`, its row and the videos and other content kept (the keys are already gone, and the message says so), to retry once the provider answers. Session only; in a workspace, owners only (`403` for editors). Workspace membership is unaffected.

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
