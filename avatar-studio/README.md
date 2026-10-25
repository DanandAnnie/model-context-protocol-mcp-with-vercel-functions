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
| Home | Quick actions, recent videos, and insights: renders per day for the last 14 days, completion rate, share views with the share of viewers who watched to the end, the most viewed videos, and a CSV download of every video's views, watch-through, and clicks |
| Create video | Draft autosave (survives a refresh), multi-scene script editor with a Pause button that inserts timed pauses (`[pause 2s]`, sent to the renderer as breaks and left out of captions) (up to 20 scenes that can be reordered and duplicated, each with its own background and, if wanted, its own presenter and voice, sized and placed on the stage), recorded or uploaded audio a scene's presenter lip-syncs to instead of a voice (saved as reusable clips of up to 90 seconds), word/duration counter, AI script writer from a topic or a public web page URL plus an Improve menu (polish, shorten, expand, change tone, translate), avatar picker, voice picker with live preview, background color, image, or looping video, 16:9 / 9:16 / 1:1 at 720p or 1080p, captions with a position and size, speaking speed and voice pitch, live stage preview |
| My videos | Library (filtered, sorted, and paged on the server, 48 cards at a time) with renders that update in place as they finish, search, status and folder filters, and sorting (newest, oldest, title, most viewed), player, inline rename, a description for the share page and its link preview, comments for the team (`@email` a workspace member to email them a link), download, SRT captions (each line's wording and timing can be corrected on the video page) plus translated subtitle tracks (up to five languages), share link, delete to a trash that keeps videos for 30 days (restore or delete for good from the library's Trash view or the video page), retry a failed render with one click, "Edit a copy" |
| Share page | Public, sidebar-free player at `/share/:id` with a native subtitle track, an optional call-to-action button in the brand colour (clicks counted on the video page), watch-through counts (how many viewers reached a quarter, half, three quarters, and the end), and an optional download button (owner toggle); the owner can take the link offline, let it expire at a set time, put a password on it, set a custom cover image, or email it to up to ten people with a note; "Embed" copies an iframe snippet, optionally autoplaying muted and looping (`/share/:id?autoplay=1&loop=1`) |
| Hardening | Password sign-in is rate limited (5 attempts per 15 minutes per IP); security headers on every response; only share and talk pages may be framed; server-side fetches (page import, avatar images, webhooks) refuse private, loopback, link-local and IPv4-mapped IPv6 hosts and connect only to the addresses that passed the check (no DNS rebinding); post-login redirects stay on the site |
| Personalize | One script with `{column}` placeholders plus a CSV of recipients produces one video per row (up to 100), with live preview, missing-column checks, and the monthly allowance respected |
| Templates | Script templates by category (real estate, marketing, training, support, social) that pre-fill the editor, plus "My templates": save any video as a template (scenes, presenters, voice, and settings) and start new videos from it |
| Avatars | Star favourites to list them first in every picker; library presenters (with a preview clip played on hover where the provider offers one) + photo avatars created from an uploaded portrait, a webcam capture, or an image URL, renamed in place, each with an optional default voice the editor switches to when the avatar is picked |
| Voice cloning | Record about a minute or upload audio files; the clone (ElevenLabs instant cloning, or a demo stand-in) is private to the account, listed first, can be renamed, and usable in every video |
| Voices | Searchable voice library with previews (provider audio, provider sample, or browser speech in demo mode) |
| Video translate | Submit a video URL and up to five target languages at once (one dubbing job each), lip-synced or voice only, with the number of speakers when there are several, and track the jobs |
| Folders and share views | Move videos into folders from the detail page or in bulk from the library (multi-select move, delete, and share links off or on) and filter the library by folder, with rename and remove on the chosen folder; public share pages count one view per viewer per 10 minutes, shown on the detail page (with views per day for the last two weeks) and library cards |
| Workspaces | Shared spaces for a team: switch between Personal and any workspace in the sidebar; everything created while a workspace is active (videos, avatars, brand kit, keys, webhook) belongs to it and is visible to every member; owners invite by link (7-day expiry) or by email when `EMAIL_PROVIDER=resend` is configured as editors (create and change content) or viewers (watch and comment only), manage roles, and remove members; the Workspace page shows an activity feed of what the team did (videos created, trashed, and restored, members, keys, the brand kit, shared presenters); videos go through review (an editor asks, a workspace owner approves or asks for changes with a note), shown on the video page, as a library badge and filter, and in the activity feed |
| Interactive avatar | Chat with a presenter in real time (optionally briefed by a public web page read once as reference material, and opening with a line and up to three suggested questions of the owner's choosing), by typing or by speaking (push-to-talk through the browser's speech recognition where available): replies come from the script provider (Claude when configured, scripted in demo mode) in the owner's instructions and language, spoken by the browser while the portrait animates. Save a presenter as a shared agent and visitors talk to it at `/talk/:id` with no sign-in (instructions stay server-side; per-visitor and per-agent rate limits; conversation counts, transcripts, and optional email capture (`lead.captured` webhook) for the owner; brand header; embeddable, with a one-line `<script>` launcher for any website). With `AVATAR_PROVIDER=heygen`, sessions open on HeyGen Streaming and the browser joins the LiveKit room for live video (adapter follows the v1 streaming docs and is not exercised in tests); otherwise the portrait animates and the browser speaks |
| Brand kit | Logo, primary and accent colors, a default image or video background, default avatar, voice, aspect ratio, output quality, captions, and a pronunciation list the renderer follows; applied to every new video and shown on shared pages |
| Developer API | Personal API keys (created and revoked from Settings, secret shown once) let scripts call every `/api/*` endpoint with `Authorization: Bearer <key>` in any auth mode |
| Webhook notifications | One signed outbound webhook per account (HMAC-SHA256 over `timestamp.body`) fired on `video.completed`, `video.failed`, and `lead.captured`, with a test button and last-delivery status; private hosts rejected |
| Plans | Free and Pro plans per account or workspace; the plan sets the monthly render allowance (`RENDER_LIMIT_PER_MONTH`, `PLAN_PRO_RENDERS`); upgrade and manage from Settings via Stripe Checkout and the Billing Portal, or instantly with the demo provider |
| Email on completion | One email per video when it completes or fails, through the email provider; `/api/health` for uptime monitors |
| Your data | Export everything for the account or workspace as JSON (secrets redacted) or delete all of it with a typed confirmation; both need a signed-in session |
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
| Billing | `BILLING_PROVIDER` = `stripe` \| `mock` + `STRIPE_SECRET_KEY` + `STRIPE_PRICE_PRO` + `STRIPE_WEBHOOK_SECRET` | Stripe Checkout, Billing Portal, and webhooks; with `mock` upgrades apply instantly |
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

What landed when, and what each independent review found and fixed, is in [docs/CHANGELOG.md](docs/CHANGELOG.md).

## Project layout

```
src/app/(studio)/*      pages: home, create, batch, videos, templates, avatars, voices, translate, interactive, brand, workspace, settings
src/app/share/*         public share page; src/app/talk/* public presenter chat; src/app/embed/* website launcher script
src/app/api/*           route handlers (thin: validate, resolve the owner, call a service)
src/lib/services/*      one module per domain (videos, batches, avatars, voices, brand, scripts, agents, translations, account) with zod schemas; `@/lib/services` re-exports them all
src/lib/providers/*     HeyGen, D-ID, ElevenLabs, Anthropic, Resend, HeyGen Streaming, and demo adapters behind one interface each
src/lib/workspaces.ts   team spaces, invites, memberships      src/lib/billing.ts        plans and Stripe
src/lib/notifications.ts signed webhooks and result emails    src/lib/api-keys.ts       hashed developer keys
src/lib/streaming.ts    live avatar session registry           src/lib/insights.ts       home statistics
src/lib/templates.ts    script templates
src/lib/store/*         Supabase / in-memory persistence       supabase/schema.sql       one-table JSON store
src/lib/__tests__/*     unit tests (node:test)
e2e/*                   Playwright end-to-end specs (playwright.config.ts starts the open and password servers)
```

## Not included (yet)

Avatar training from video (no provider API in this app). The HeyGen Streaming adapter follows the v1 streaming docs but has not been run against the live API.
