---
name: toon-video-production
description: >
  Turn a script or one-line idea into a finished 60-90 second animated cartoon
  explainer: scene-planned, character-consistent, voiced with Dan's ElevenLabs
  clone, music-bedded, caption-burned, assembled in FFmpeg on the Mac Mini,
  uploaded to Supabase, approved via Telegram. Use for listing explainers,
  first-time-buyer education, Assurance PM owner education, and St. George
  market explainers. Triggers on "toon video:" and "toon reroll:".
---

# toon-video-production

Extends `faceless-video-production` — reuse its ElevenLabs VO, FFmpeg
assembly, Supabase upload, and Telegram gate patterns. The overlapping steps
in `scripts/toon_video/` are marked `SHARED-CANDIDATE`; when both skills live
on the Mac Mini, refactor them into `~/.hermes/skills/content/_shared/` and
import from both. Do not maintain two copies. Internal use only — SaaS
Factory candidate, but the 25-tenant rule applies.

## Invocation

```
claude-hermes "toon video: <idea or full script> [--style <style>] [--length 60|90] [--character <name>] [--hook-video | --stills-only]"
claude-hermes "toon reroll: <video_id> scene <n> [new visual description]"
```

Defaults: `--stills-only`, `--length 60`, style `classic-cartoon`, brand voice
The Finest Homes (unless flagged otherwise). Idea-only input → write the
script first in brand voice (see `brand-voice-marketing` skill).

## Interpreter rule (do not skip)

Every Python call goes through the dedicated venv — Hermes skill execution
does NOT reliably use the hermes-agent venv (same failure as the docs venv
fix):

```bash
TOON_PY=~/.hermes/venvs/toon/bin/python
cd ~/.hermes/skills/content/toon-video-production/scripts
$TOON_PY -m toon_video <command> ...
```

If the venv is missing, run `./install.sh` from the skill root first.

## Core design decision: audio-first

Voiceover is generated BEFORE visuals. Scene durations derive from measured
VO audio and clips are cut to match — never sync narration to pre-cut clips.
`scene_plan.json` (in `~/.hermes/work/toon-videos/<video_id>/`) is the single
source of truth and resume point: every step is idempotent, re-runs skip
completed assets, and a crash resumes without regenerating paid assets.

## Pipeline

### Step 1 — Scene plan (you, the model)

From the script/idea, write a scene plan: **8–12 scenes for 60s, 12–16 for
90s**. Each scene: exact narration text, prompt-ready visual description,
character slugs, camera motion (`zoom-in|zoom-out|pan-left|pan-right|static`),
mood. One hook scene only, and it must be scene 1. Schema:
`schema/scene_plan.schema.json`. Keep narration tight — ~2.5 words/sec of
target length total.

```bash
$TOON_PY -m toon_video init /path/to/draft_plan.json [--hook-video] [--confirm-cost]
```

`init` validates, prints the cost estimate, creates the work dir, and upserts
the `toon_video_jobs` row (status `planning`). **Cost gate:** exit code 3
means the estimate exceeds `TOON_MAX_VIDEO_COST` (default $3.00) or the hook
clip exceeds `TOON_MAX_HOOK_CREDITS` (default 300 credits). Surface the
estimate to Dan (Telegram) and only re-run with `--confirm-cost` after an
explicit go-ahead. Never bypass the gate yourself.

### Step 2 — Voiceover (SHARED with faceless-video-production)

```bash
$TOON_PY -m toon_video vo <video_id>
```

One MP3 per scene via Dan's ElevenLabs clone (with word timestamps; local
whisper-cpp fallback), duration measured with ffprobe and written back into
the plan. **Exit code 4 = runtime >15% over target:** the report lists trim
candidates — rewrite ONLY those scenes' narration shorter, then
`vo --scenes <ns> --force`. Repeat until under budget.

### Step 3 — Character sheets (cached, once per character per style)

For each character slug in the plan:

```bash
$TOON_PY -m toon_video character lookup <slug> --style <style>
```

If not cached: get the prompt with `character prompt <slug> --style <style>
--description "..."`, generate ONE image with Higgsfield `generate_image`
(front view, neutral pose — the prompt encodes this), vision-check it against
the description, then:

```bash
$TOON_PY -m toon_video character register <slug> --style <style> --description "..." --image /path/sheet.png --cost-usd 0.07
```

Sheets are the reusable consistency moat — never regenerate a cached sheet
unless Dan asks.

### Step 4 — Scene stills

```bash
$TOON_PY -m toon_video still-prompts <video_id>
```

emits one prompt per pending scene (fixed style token + visual + consistency
suffix — same token in every prompt of a video, never mixed) plus each
scene's character sheet paths/URLs. Generate with Higgsfield
`generate_image_batch` (parallel, ≤12 per call), passing the character sheet
as a reference element / image-to-image reference for scenes that have one.
Register each result:

```bash
$TOON_PY -m toon_video register-still <video_id> <n> <path-or-url>
```

**Vision QC (required):** view every still against the style token and
character sheet. Off-style or off-model → re-roll that scene once
(`register-still` the replacement, then `qc-flag <video_id> <n> --rerolled`).
Still bad → keep the better frame and `qc-flag <video_id> <n> --rerolled
--flag --reason "..."` so the Telegram preview carries the warning. Log spend
for the batch: image gen cost lands in the JSONL via your Higgsfield usage —
if you generated N stills, that spend is already tagged by `init`'s estimate;
verify with `estimate`.

### Step 5 — Motion

```bash
$TOON_PY -m toon_video clips <video_id>
```

FFmpeg zoompan (Ken Burns) per still, direction from the scene's `camera`
field, cut to `duration_sec + 0.4s` breathing room. Zero credit cost.

`--hook-video` only: scene 1 gets a true image-to-video clip (existing
Veo/FAL path from faceless-video-production, 8s max) — generate from scene
1's still, then `register-clip <video_id> 1 <path-or-url> --provider veo
--cost-usd <x>`. The credit gate was already enforced at `init`.

### Step 6 — Music bed

```bash
$TOON_PY -m toon_video music <video_id>            # TOON_MUSIC_MODE=library (default)
$TOON_PY -m toon_video music <video_id> --file <generated.mp3> --cost-usd 0.10   # generate mode
```

Library mode picks a licensed track from `~/.hermes/assets/music/` by mood
match (cheaper, deterministic). Generate mode: create one track for the
plan's `music_mood`, then register it. Assembly ducks it -14 dB under
narration with 1s fade in/out.

### Step 7 — Captions

```bash
$TOON_PY -m toon_video captions <video_id>
```

Word-level timestamps (ElevenLabs alignment, whisper-cpp fallback) burned via
the FFmpeg subtitles filter with ASS styling. One style at launch:
`assets/captions/toon-default.ass`; new styles are new template files passed
with `--template` — no code changes. The font is bundled in `assets/fonts/`
and referenced by absolute fontsdir, so missing system fonts can't break the
burn.

### Step 8 — Assembly

```bash
$TOON_PY -m toon_video assemble <video_id>
```

Concat demuxer → mux VO → duck music → burn captions → 1080x1920 H.264
CRF 20, AAC 192k (+ thumbnail). 16:9 needs clips re-rendered at that aspect —
only do it if Dan asked.

### Step 9 — Publish gate (SHARED pattern)

```bash
$TOON_PY -m toon_video publish <video_id>
```

Uploads MP4 + thumbnail to the private `toon-videos/` bucket, sets the job to
`awaiting_approval` with actual cost, and sends the Telegram preview with
Approve / Re-roll scene N / Kill buttons. **Nothing posts without approval —
Hermes proposes, Dan approves.** Button callbacks arrive through the existing
Hermes Telegram listener, which runs `approve`/`kill`/`reroll`. Distribution
after approval belongs to social-content-engine, not this skill.

## Re-roll workflow

```
claude-hermes "toon reroll: <video_id> scene <n> [new visual description]"
```

```bash
$TOON_PY -m toon_video reroll <video_id> <n> [--visual "..."] [--narration "..."]
```

Clears that scene's still + clip (VO untouched unless `--narration`), then:
regenerate the still (Step 4 for that scene) → `clips` → `assemble` →
`publish`. Only the cleared assets are regenerated.

## Failure modes (handle explicitly)

- **Off-style frame** → vision QC in Step 4: auto-reroll once, then flag in
  Telegram via `qc-flag`. Never loop rerolls beyond one without Dan.
- **Wrong interpreter** → always `~/.hermes/venvs/toon/bin/python`; never
  bare `python3` or `sys.executable`.
- **Missing fonts** → bundled font + fontsdir; if captions render tofu, check
  `TOON_FONT_NAME` matches the template's Fontname.
- **Partial crash** → `status <video_id>` shows per-scene asset state; re-run
  the failed step — completed paid assets are skipped.
- **Runtime over budget** → trim only the scenes `vo` reports; regenerate
  only those (exit code 4 handling in Step 2).

## Environment

Required: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (or `TOON_VOICE_ID`),
`SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
Optional knobs: `TOON_MAX_VIDEO_COST` (3.00), `TOON_MAX_HOOK_CREDITS` (300),
`TOON_MUSIC_MODE` (library), `TOON_MUSIC_LIBRARY`, `TOON_WORK_DIR`,
`TOON_CHAR_CACHE`, `HERMES_SPEND_LOG`, `TOON_COST_PER_IMAGE`,
`TOON_COST_PER_1K_VO_CHARS`, `TOON_COST_HOOK_CLIP`, `TOON_HOOK_CLIP_CREDITS`,
`TOON_FONT_PATH`/`TOON_FONT_NAME`, `TOON_SIGNED_URL_TTL_SEC`.
Supabase project: `xzkiqxgslehsmaxnasfp` (tables `toon_characters`,
`toon_video_jobs`; buckets `toon-videos/`, `toon-characters/` — migration in
`supabase/migrations/`).

## Out of scope (v1)

Lip sync, multi-character dialogue scenes, 5-minute videos, per-scene music
changes, public SaaS wrapper (25-tenant rule), auto-posting to social
(social-content-engine handles distribution after approval).
