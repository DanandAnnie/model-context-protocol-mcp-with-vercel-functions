# toon-video-production

Hermes skill: script or one-line idea → finished 60–90s animated cartoon
explainer (scene-planned, character-consistent, VO'd with Dan's ElevenLabs
clone, music bed, burned captions, FFmpeg-assembled, Supabase-hosted,
Telegram-approved).

This directory is developed in-repo and installed onto the Mac Mini at
`~/.hermes/skills/content/toon-video-production/` by `./install.sh`.

## Layout

```
SKILL.md                      Orchestration playbook Claude follows (the skill itself)
install.sh                    Copy to ~/.hermes + create ~/.hermes/venvs/toon
schema/scene_plan.schema.json Scene plan contract (single source of truth / resume point)
supabase/migrations/          toon_characters + toon_video_jobs + buckets (applied to xzkiqxgslehsmaxnasfp)
assets/captions/              ASS caption templates (add styles by adding files)
assets/fonts/                 Bundled DejaVuSans-Bold.ttf (fontsdir for ASS burn)
scripts/toon_video/           Deterministic pipeline: VO, ffmpeg, Supabase, Telegram, cost gates
tests/                        Offline unit tests + ffmpeg smoke test (skips without ffmpeg)
```

## Architecture: who does what

**Claude (per SKILL.md):** writes the script + scene plan, generates
character sheets and scene stills via Higgsfield MCP, vision-QCs every frame,
decides re-rolls, and drives the CLI below in order.

**`toon_video` CLI (deterministic, run via `~/.hermes/venvs/toon/bin/python`):**
ElevenLabs VO with word timestamps + ffprobe durations, cost gates + JSONL
spend logging, Ken Burns zoompan clips, music bed ducking, ASS captions,
concat/mux/burn/export, Supabase storage + job rows, Telegram approval gate.

Audio-first is the core design decision: VO is generated first, measured with
ffprobe, and every clip is cut to the measured duration (+0.4s breathing
room). Never the reverse.

## Relationship to faceless-video-production

This skill **extends** `faceless-video-production` and reuses its patterns
(ElevenLabs VO, FFmpeg assembly, Supabase upload, Telegram gate). That
skill's code is not in this repo, so the overlapping steps are implemented
here as standalone modules explicitly marked `SHARED-CANDIDATE`
(`vo.py`, `supabase_io.py`, `telegram_gate.py`). **On the Mac Mini, refactor
each pair into `~/.hermes/skills/content/_shared/` and import from both
skills — do not let two copies drift.**

## Install (Mac Mini)

```bash
./install.sh
```

Then set env vars (SKILL.md → Environment), drop licensed music into
`~/.hermes/assets/music/`, and register the skill in Hermes. The Supabase
migration for project `xzkiqxgslehsmaxnasfp` has already been applied
(tables `toon_characters`, `toon_video_jobs`; private buckets `toon-videos`,
`toon-characters`) — `supabase/migrations/001_toon_video_schema.sql` is the
canonical record and is idempotent if re-run.

## Tests

```bash
cd tests && ~/.hermes/venvs/toon/bin/python -m pytest -q   # or any python3 with pytest
```

Pure-Python tests (plan validation, word grouping, ASS build, cost gates,
resume state) run anywhere; the assembly smoke test builds a 2-scene video
from placeholder stills and auto-skips when ffmpeg is absent.

## Definition of done (v1)

One 60s first-time-buyer explainer generated end-to-end, stills-only, under
$2, approved via Telegram, playable from a Supabase signed URL.
