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
| Create video | Script editor with word/duration counter, AI script writer, avatar picker, voice picker with live preview, background color/image, 16:9 / 9:16 / 1:1, captions, speaking speed, live stage preview |
| My videos | Library with status polling, player, download, delete, "Edit a copy" |
| Templates | Script templates by category (real estate, marketing, training, support, social) that pre-fill the editor |
| Avatars | Library presenters + photo avatars created from an uploaded portrait or image URL |
| Voices | Searchable voice library with previews (provider audio, provider sample, or browser speech in demo mode) |
| Video translate | Submit a video URL + target language, track dubbing jobs |
| Settings | Shows which provider backs each capability and how to configure it |
| API | REST routes under `/api/*`, provider webhooks under `/api/webhooks/:provider` |

## Quick start

```bash
cd avatar-studio
npm install
cp .env.example .env.local   # optional: add keys to leave demo mode
npm run dev                  # http://localhost:3000
npm test                     # service-layer tests (node:test via tsx)
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

CI: `.github/workflows/avatar-studio.yml` runs typecheck, tests, and the
production build on every push or PR that touches this folder.

Set `APP_URL` to the public URL of the deployment so providers can call back
`/api/webhooks/<provider>`; polling also works, so a missed webhook never
strands a job. Add `WEBHOOK_SECRET` to require `?secret=` on callbacks.

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
src/lib/store/*         Supabase / in-memory persistence
supabase/schema.sql     one-table JSON store
```

## Not included (yet)

User accounts and per-user workspaces, billing/credits, a timeline editor with
multiple scenes, interactive real-time avatars, and avatar training from video.
