"""toon-video-production pipeline helpers.

Deterministic half of the skill: ffprobe/ffmpeg assembly, ElevenLabs VO,
Supabase IO, Telegram gate, cost gates, and scene_plan.json state.
The creative half (scene planning, still/character generation, vision QC)
is orchestrated by Claude per SKILL.md and lands back here through the
``register-*`` CLI commands.

Always run through the dedicated venv interpreter
(~/.hermes/venvs/toon/bin/python) — never trust sys.executable from the
Hermes skill runner. See config.PYTHON_NOTE.
"""

__version__ = "0.1.0"
