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
| Create video | Draft autosave (survives a refresh), multi-scene script editor with a Pause button that inserts timed pauses (`[pause 2s]`, sent to the renderer as breaks and left out of captions; a scene of only pauses is a silent one, the presenter holding up to a minute, as HeyGen's silent scenes) (up to 20 scenes that can be reordered and duplicated, each with its own background (a colour, an image by URL or uploaded from the computer, or a looping video, filling the frame or, in the preview, shown whole), a slide deck saved as PDF imported as one scene per page (the page behind the presenter, its text as a draft script, the format from the page shape) or as PowerPoint (.pptx) with each slide's speaker notes as its script (hidden slides left out; choose the PDF and the .pptx together for the pages with the notes), and, if wanted, its own presenter, voice, and speaking speed, the presenter sized, placed, and framed in full, as a close-up, or in a circle on the stage preview (HeyGen's v3 API places the presenter itself, so renders use its framing), or no presenter at all (a picture or video background then fills the frame with the voice or a clip over it, or held in silence, as HeyGen's scenes without an avatar)), recorded or uploaded audio a scene's presenter lip-syncs to instead of a voice (saved as reusable clips of up to 90 seconds), script import from a plain-text, Markdown, or Word (.docx) file (one scene per paragraph, or per part between headings or `---` lines, a Word document's title naming the video, up to the 5000 characters a video holds), on-screen text per scene (a title, a name and role, a price; at the top, middle, or bottom, in three sizes and any colour, previewed on the stage and kept with the scene; HeyGen's v3 API has no text element, so renders do not carry it yet), word/duration counter, find and replace across every scene (match case, whole words; pause markers never touched), AI script writer from a topic or a public web page URL plus an Improve menu (polish, shorten, expand, change tone, translate), avatar picker, voice picker with live preview, background color, image, or looping video, 16:9 / 9:16 / 1:1 at 720p or 1080p, captions with a position, size, look (classic, bold, yellow, or minimal), and typeface (sans, serif, rounded, or mono), speaking speed, voice pitch, HeyGen's Avatar V engine for looks that support it, a transparent background (the presenter alone as a WebM with an alpha channel, for compositing, on HeyGen), an accent for voices that speak several (British, Australian, or Indian English, Mexican Spanish, and so on, which HeyGen applies to voices that offer accents), photo avatar motion (expressiveness low, medium, or high, and gestures in words, which HeyGen applies to photo avatar presenters, and to video avatars rendering on Avatar V), and voice emotion (excited, friendly, serious, soothing, or broadcaster, kept with the video; HeyGen's v3 API takes no emotion, so renders keep the voice's natural delivery), live stage preview |
| Video Agent | Describe a video in a sentence or a page of notes (optionally with a public web page or an attached PDF, Word, PowerPoint, or text document to write from, read in the browser) and the agent writes the script, splits it into scenes, frames the hook and call to action as close-ups, picks portrait or landscape, and applies the brand kit's presenter, voice, background, quality, and captions; generate it straight away or review the plan in the editor first; presenter, voice, format, length, and language can be set |
| My videos | Library (filtered, sorted, and paged on the server, 48 cards at a time) with renders that update in place as they finish, search, status and folder filters, and sorting (newest, oldest, title, most viewed), player, inline rename, a description for the share page and its link preview, comments for the team (`@email` a workspace member to email them a link; pin a note to the player's moment and its time seeks back there), download, SRT captions (each line's wording and timing can be corrected on the video page) plus translated subtitle tracks (up to five languages), share link (copy it, email it, or post it to LinkedIn, X, Facebook, or WhatsApp), delete to a trash that keeps videos for 30 days (restore or delete for good from the library's Trash view or the video page), retry a failed render with one click, "Make other sizes" (the same video rendered again as a 9:16 portrait or a 1:1 square, each a new video, warning first about on-screen text that would not fit), short clips (HeyGen's AI Clipping picks the best moments and cuts 30-second, 1-minute, or 3-minute clips framed for social media, with or without captions, guided by what to look for), "Edit a copy" |
| Share page | Public, sidebar-free player at `/share/:id` with a native subtitle track, chapters for a video of several scenes (one per scene, titled from its on-screen text or its first words, each playing from where its scene starts, following captions an editor corrected, the one playing marked; the video page lists them too, with a "Copy for YouTube" button that copies them as a description lists them, `0:00 Welcome`, and says whether YouTube would show them as chapters), a transcript under the player (the caption lines with their times, corrected ones included, in the language of the subtitle track the viewer turns on; a line plays the video from there and the line being spoken is marked), an optional call-to-action button in the brand colour (clicks counted on the video page), watch-through counts (how many viewers reached a quarter, half, three quarters, and the end), an optional download button (owner toggle), and an optional email gate (viewers give an email before the video plays; the owner sees the list on the video page, downloads it as CSV, and the webhook hears `lead.captured`); the owner can take the link offline, let it expire at a set time, put a password on it, set a custom cover image (uploaded, or a paused frame of the video), or email it to up to ten people with a note; "Embed" copies an iframe snippet, optionally autoplaying muted and looping (`/share/:id?autoplay=1&loop=1`) |
| Hardening | Password sign-in is rate limited (5 attempts per 15 minutes per IP); security headers on every response; only share and talk pages may be framed; server-side fetches (page import, avatar images, webhooks) refuse private, loopback, link-local and IPv4-mapped IPv6 hosts and connect only to the addresses that passed the check (no DNS rebinding); post-login redirects stay on the site |
| Personalize | One script with `{column}` placeholders plus a CSV of recipients produces one video per row (up to 100), with live preview, missing-column checks, and the monthly allowance respected; the batch page sets speaking speed, pitch, and emotion, and can start from a saved template (its script, presenter, voice, look, captions, and first background) |
| Templates | Script templates by category (real estate, marketing, training, support, social) that pre-fill the editor, plus "My templates": save any video as a template (scenes, presenters, voice, and settings) and start new videos from it; "HeyGen templates" lists the layouts made in HeyGen Studio and marked for the API, with a form for each one's slots (text, a picture, video, or audio link, a presenter, a voice) that renders it as a library video |
| Avatars | Star favourites to list them first in every picker; library presenters (with a preview clip played on hover where the provider offers one) + photo avatars created from an uploaded portrait, a webcam capture, or an image URL, renamed in place, each with an optional default voice the editor switches to when the avatar is picked |
| Digital twins | Train a presenter from footage of a real person (a public link to one person speaking to camera; HeyGen's digital twin), send the person a consent link to record their agreement on HeyGen's page, and the twin joins the avatars once it is trained and consented to, with the voice cloned from the footage as its own voice |
| New looks | Dress a photo avatar in a look pack (modern corporate, business-casual, Scandinavian minimal, cool tech, healthcare, keynote, fitness, car dealership; women's or men's; landscape or portrait): HeyGen's Look Packs make about five looks around its face, each kept as a photo avatar of its own once ready |
| Presenter from a description | Describe a person (age, look, clothes, setting, light) in the New photo avatar panel and HeyGen draws a presenter who does not exist (prompt to avatar), kept as a photo avatar like an upload; an illustrated stand-in in demo mode |
| Voice cloning | Record about a minute or upload audio files; the clone (ElevenLabs instant cloning, HeyGen voice cloning from the samples joined into one recording, or a demo stand-in) is private to the account, listed first, can be renamed, and usable in every video |
| Voice design | Describe a voice (age, accent, tone, pace), hear three previews read in it, and keep the one you like: ElevenLabs text-to-voice, or a demo stand-in whose previews the browser reads; designed voices sit with the clones, five of your own per account, and like them are listed only to the account that made them |
| Voices | Searchable voice library with previews (provider audio, provider sample, or browser speech in demo mode) |
| Video translate | Submit a video URL and up to five target languages at once (one dubbing job each), lip-synced or voice only, with the number of speakers when there are several, at Speed or Precision quality, optionally without the background music or with enhanced speech, and track the jobs; a finished dub links its subtitle files (SRT and VTT) where HeyGen makes them; "Proofread the lines first" stops once the lines are translated so they can be corrected on the page, and the dub is made from the approved lines; "Follow the brand glossary" (on by default when the brand kit has terms or rules) has HeyGen leave those terms untranslated and use the kit's fixed translations for the dub's language |
| Clean up | Cut the filler words ("um", "uh") and long silences out of a recording, from a public link or a video of the library (HeyGen filler word removal), and get one cleaned video back to watch and download, with how many filler words were cut and how much shorter it is |
| Lip sync | Put new audio on a video, a line re-recorded or a voice-over replaced, and the speaker's mouth is redrawn to match (HeyGen lip sync): the footage is a video of the library or a public link, the audio an uploaded or saved audio clip or a public link, at a fast or a precise quality; the result is listed to watch and download |
| Folders and share views | Move videos into folders from the detail page or in bulk from the library (multi-select move, delete, and share links off or on) and filter the library by folder, with rename and remove on the chosen folder; public share pages count one view per viewer per 10 minutes, shown on the detail page (with views per day for the last two weeks) and library cards |
| Workspaces | Shared spaces for a team: switch between Personal and any workspace in the sidebar; everything created while a workspace is active (videos, avatars, brand kit, keys, webhook) belongs to it and is visible to every member; owners invite by link (7-day expiry) or by email when `EMAIL_PROVIDER=resend` is configured as editors (create and change content) or viewers (watch and comment only), manage roles, and remove members; the Workspace page shows an activity feed of what the team did (videos created, trashed, and restored, members, keys, the brand kit, shared presenters); videos go through review (an editor asks, a workspace owner approves or asks for changes with a note), shown on the video page, as a library badge and filter, and in the activity feed |
| Interactive avatar | Chat with a presenter in real time (optionally briefed by a public web page read once as reference material, and opening with a line and up to three suggested questions of the owner's choosing), by typing or by speaking (push-to-talk through the browser's speech recognition where available): replies come from the script provider (Claude when configured, scripted in demo mode) in the owner's instructions and language, spoken by the browser while the portrait animates. Save a presenter as a shared agent and visitors talk to it at `/talk/:id` with no sign-in (instructions stay server-side; per-visitor and per-agent rate limits; conversation counts, transcripts, and optional email capture (`lead.captured` webhook) for the owner; brand header; embeddable, with a one-line `<script>` launcher for any website). With `LIVEAVATAR_API_KEY` and `LIVEAVATAR_AVATAR_ID` set, sessions open on HeyGen's LiveAvatar (which replaces HeyGen's streaming API, retired October 31, 2026). LiveAvatar's avatars are its own, so every live session shows that one avatar, whichever presenter it opens for. The browser joins the LiveKit room once the avatar and LiveAvatar's agent are in it, and says each reply there as a command. The session token stays on the server, which keeps the session alive every minute and stops it when the page closes or goes idle. Until then, and whenever a session ends or cannot open, the portrait animates and the browser speaks |
| Brand kit | Filled in from a company website (its declared name, logo, and colours, for review before saving), logo, primary and accent colors, a default image or video background, default avatar, voice, aspect ratio, output quality, captions, a pronunciation list the renderer follows, terms that script and subtitle translations never translate, and an optional logo watermark in a corner of the share and embed player; applied to every new video and shown on shared pages |
| Developer API | Personal API keys (created and revoked from Settings, secret shown once) let scripts call every `/api/*` endpoint with `Authorization: Bearer <key>` in any auth mode |
| Webhook notifications | One signed outbound webhook per account (HMAC-SHA256 over `timestamp.body`) fired on `video.completed`, `video.failed`, and `lead.captured`, with a test button and last-delivery status; private hosts rejected |
| Plans | Free and Pro plans per account or workspace; the plan sets the monthly render allowance (`RENDER_LIMIT_PER_MONTH`, `PLAN_PRO_RENDERS`); upgrade and manage from Settings via Stripe Checkout and the Billing Portal, or instantly with the demo provider |
| Email on completion | One email per video when it completes or fails, through the email provider; `/api/health` for uptime monitors |
| Your data | Export everything for the account or workspace as JSON (secrets redacted) or delete all of it with a typed confirmation; both need a signed-in session |
| Settings | Usage summary (videos, completed, processing, failed, seconds rendered, this month vs allowance), which provider backs each capability, access mode, and how to configure it |
| Allowance | Optional `RENDER_LIMIT_PER_MONTH` caps renders per account per calendar month; exceeding it returns 429 with a clear message. A render counts when it starts, deleting it does not give it back, and one the provider fails is returned |
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
| Avatar rendering | `AVATAR_PROVIDER` = `heygen` \| `did` \| `mock` | HeyGen v3 API (studio videos, photo avatars, assets), D-ID Talks API |
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
returned id is cached on the avatar (on HeyGen, a v3 photo avatar look, waited
for while HeyGen prepares it; see [API.md](./docs/API.md#heygen-api-version)).

Set `WEBHOOK_SECRET` and `APP_URL` to enable provider callbacks to
`/api/webhooks/<provider>`; without a secret the callback endpoint stays
disabled and the app relies on polling, which works either way. Proofread dubs
with HeyGen need `APP_URL` set to the app's public https address, since HeyGen
reads the corrected lines from it.

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
src/lib/providers/*     HeyGen, D-ID, ElevenLabs, Anthropic, Resend, LiveAvatar, and demo adapters behind one interface each
src/lib/workspaces.ts   team spaces, invites, memberships      src/lib/billing.ts        plans and Stripe
src/lib/notifications.ts signed webhooks and result emails    src/lib/api-keys.ts       hashed developer keys
src/lib/streaming.ts    live avatar session registry           src/lib/insights.ts       home statistics
src/lib/templates.ts    script templates
src/lib/store/*         Supabase / in-memory persistence       supabase/schema.sql       one-table JSON store
src/lib/__tests__/*     unit tests (node:test)
e2e/*                   Playwright end-to-end specs (playwright.config.ts starts the open and password servers)
```

## Not included (yet)

Avatar training from video (no provider API in this app). The LiveAvatar adapter follows LiveAvatar's published web SDK (FULL mode, the commands, waiting for the avatar and agent) and two open-source clients (the token, start, and stop calls, used there in LITE mode), and has not been run against the live API; a session that fails to open leaves the portrait animating and the browser speaking the replies. A visitor's room token lets them send LiveAvatar commands of their own for as long as the session runs (at most 15 minutes): longer text than the app allows, an answer from LiveAvatar's own model, or a spoken conversation through their microphone. Those bypass the talk page's chat limits and transcripts. Whether a FULL session with no context speaks unprompted has not been checked. HeyGen's v3 video API has no presenter layout, on-screen text, background fit, or voice emotion, so those editor settings are previewed and kept but not rendered.
