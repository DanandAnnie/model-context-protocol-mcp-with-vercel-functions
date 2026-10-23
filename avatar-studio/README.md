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
| Share page | Public, sidebar-free player at `/share/:id` |
| Templates | Script templates by category (real estate, marketing, training, support, social) that pre-fill the editor |
| Avatars | Library presenters + photo avatars created from an uploaded portrait, a webcam capture, or an image URL |
| Voices | Searchable voice library with previews (provider audio, provider sample, or browser speech in demo mode) |
| Video translate | Submit a video URL + target language, track dubbing jobs |
| Settings | Usage summary (videos, completed, processing, failed, seconds rendered), which provider backs each capability, access mode, and how to configure it |
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

## Project layout

```
src/app/(studio)/*      pages: home, create, videos, templates, avatars, voices, translate, settings
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

Team workspaces and sharing between accounts, billing/credits, interactive real-time avatars, and avatar training from video.
