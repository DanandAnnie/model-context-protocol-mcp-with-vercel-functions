# Avatar Studio

A self-hosted, HeyGen-style AI video studio built with Next.js. Write a script
(or have AI write it), pick an avatar and a voice, choose the look, and render a
talking-presenter video. Translate finished videos into other languages.

The product experience is built here; the heavy ML (lip-sync, voice synthesis,
dubbing) is delegated to pluggable providers so you can run on HeyGen's API,
D-ID, ElevenLabs, or in a fully offline **demo mode** with no keys at all.

## Features

| Area | What you get |
|---|---|
| Home | Quick actions, recent videos |
| Create video | Draft autosave (survives a refresh), multi-scene script editor (up to 20 scenes, each with its own background), word/duration counter, AI script writer plus an Improve menu (polish, shorten, expand, change tone, translate), avatar picker, voice picker with live preview, background color/image, 16:9 / 9:16 / 1:1, captions, speaking speed, live stage preview |
| My videos | Library with search and status filters, player, inline rename, download, SRT captions, share link, delete, "Edit a copy" |
| Share page | Public, sidebar-free player at `/share/:id` with a native subtitle track; "Embed" copies an iframe snippet |
| Hardening | Password sign-in is rate limited (5 attempts per 15 minutes per IP); security headers on every response; only share pages may be framed |
| Personalize | One script with `{column}` placeholders plus a CSV of recipients produces one video per row (up to 100), with live preview, missing-column checks, and the monthly allowance respected |
| Templates | Script templates by category (real estate, marketing, training, support, social) that pre-fill the editor |
| Avatars | Library presenters + photo avatars created from an uploaded portrait, a webcam capture, or an image URL |
| Voices | Searchable voice library with previews (provider audio, provider sample, or browser speech in demo mode) |
| Video translate | Submit a video URL + target language, track dubbing jobs |
| Folders and share views | Move videos into folders from the detail page or in bulk from the library (multi-select move and delete) and filter the library by folder; public share pages count one view per viewer per 10 minutes, shown on the detail page and library cards |
| Workspaces | Shared spaces for a team: switch between Personal and any workspace in the sidebar; everything created while a workspace is active (videos, avatars, brand kit, keys, webhook) belongs to it and is visible to every member; owners invite by link (7-day expiry) or by email when `EMAIL_PROVIDER=resend` is configured, manage roles, and remove members |
| Brand kit | Logo, primary and accent colors, default avatar, voice, aspect ratio, and captions; applied to every new video and shown on shared pages |
| Developer API | Personal API keys (created and revoked from Settings, secret shown once) let scripts call every `/api/*` endpoint with `Authorization: Bearer <key>` in any auth mode |
| Webhook notifications | One signed outbound webhook per account (HMAC-SHA256 over `timestamp.body`) fired on `video.completed` and `video.failed`, with a test button and last-delivery status; private hosts rejected |
| Settings | Usage summary (videos, completed, processing, failed, seconds rendered, this month vs allowance), which provider backs each capability, access mode, and how to configure it |
| Allowance | Optional `RENDER_LIMIT_PER_MONTH` caps renders per account per calendar month; exceeding it returns 429 with a clear message |
| Accounts | Per-user accounts with Supabase Auth (email + password sign up / sign in, email confirmation); each user sees only their own videos, avatars, and translations. Falls back to a shared `STUDIO_PASSWORD` gate, then open mode. Landing, login, share pages, and provider webhooks stay public |
| API | REST routes under `/api/*`, provider webhooks under `/api/webhooks/:provider` |

## Quick start

```bash
cd avatar-studio
npm install
cp .env.example .env.local   # optional: add keys to leave demo mode
npm run dev                  # http://localhost:3000
npm test                     # service-layer tests (node:test via tsx)
npm run build && npm run e2e # Playwright end-to-end suite (open + password modes)
```

With no keys the app runs in demo mode: stock illustrated avatars, browser
text-to-speech previews, template scripts, and simulated renders that complete
after ~12 seconds using a sample clip.

## Providers

| Capability | Env | Backends |
|---|---|---|
| Avatar rendering | `AVATAR_PROVIDER` = `heygen` \| `did` \| `mock` | HeyGen Video Generate API, D-ID Talks API |
| Voices / TTS | `TTS_PROVIDER` = `elevenlabs` \| `heygen` \| `mock` | ElevenLabs, HeyGen voices |
| Script writer | `SCRIPT_PROVIDER` = `anthropic` \| `mock` | Claude via the Anthropic SDK |
| Translation | automatic when `HEYGEN_API_KEY` is set | HeyGen Video Translate |
| Persistence | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Supabase (`supabase/schema.sql`), else in-memory |
| Invite email | `EMAIL_PROVIDER` = `resend` \| `mock` + `RESEND_API_KEY` + `EMAIL_FROM` | Resend; with `mock` invites are link-only |

Access control: set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
for per-user accounts (enable Email auth in Supabase and point its Site URL at
this deployment; confirmation links return via `/auth/callback`). Without those,
`STUDIO_PASSWORD` gives a single shared password. Items are stored with an
`ownerId` (the Supabase user id, or `local`), so switching modes later keeps data.

CI: `.github/workflows/avatar-studio.yml` runs typecheck, unit tests, the
production build, and the Playwright end-to-end suite on every push or PR that
touches this folder.

Voices follow the renderer: HeyGen rendering always lists HeyGen voices (its
API accepts no others); D-ID uses ElevenLabs voices when configured, otherwise
its built-in Microsoft voices, which the demo voice list maps onto by gender.
Custom photo avatars are uploaded to the renderer on first use and the
returned asset id is cached on the avatar.

Set `WEBHOOK_SECRET` and `APP_URL` to enable provider callbacks to
`/api/webhooks/<provider>`; without a secret the callback endpoint stays
disabled and the app relies on polling, which works either way.

Adding a provider means implementing one interface in `src/lib/providers/types.ts`
and registering it in `src/lib/providers/index.ts`.

## Deploy to Vercel

Import the repository and set **Root Directory** to `avatar-studio`. Add the
environment variables above. For production use Supabase storage, since the
in-memory store resets on every cold start.

## API

Every route is documented in [docs/API.md](docs/API.md): authentication with personal keys, request shapes, the batch and script endpoints, workspaces, and how to verify outbound webhook signatures.

## Project layout

```
src/app/(studio)/*      pages: home, create, batch, videos, templates, avatars, voices, translate, settings
src/app/api/*           route handlers
src/lib/providers/*     HeyGen, D-ID, ElevenLabs, Anthropic, and demo adapters
src/lib/services.ts     orchestration + validation (zod)
src/lib/templates.ts    script templates
src/lib/__tests__/*     unit tests
e2e/*                   Playwright end-to-end specs (playwright.config.ts starts both servers)
src/lib/store/*         Supabase / in-memory persistence
supabase/schema.sql     one-table JSON store
```

## Not included (yet)

Team workspaces and sharing between accounts, paid billing (only a monthly render allowance today), interactive real-time avatars, and avatar training from video.
