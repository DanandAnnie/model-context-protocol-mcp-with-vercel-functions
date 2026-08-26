"""Environment, paths, style tokens, and cost knobs for the toon pipeline."""

import os
from pathlib import Path

PYTHON_NOTE = (
    "Run via ~/.hermes/venvs/toon/bin/python — Hermes skill execution does not "
    "reliably use the hermes-agent venv, so entry points must name the "
    "interpreter explicitly."
)

HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))

SKILL_DIR = Path(__file__).resolve().parent.parent.parent  # .../toon-video-production
ASSETS_DIR = SKILL_DIR / "assets"
SCHEMA_PATH = SKILL_DIR / "schema" / "scene_plan.schema.json"
ASS_TEMPLATE = ASSETS_DIR / "captions" / "toon-default.ass"
FONTS_DIR = ASSETS_DIR / "fonts"
# Bundled so FFmpeg's subtitles filter never depends on system font config.
FONT_PATH = Path(os.environ.get("TOON_FONT_PATH", str(FONTS_DIR / "DejaVuSans-Bold.ttf")))
FONT_NAME = os.environ.get("TOON_FONT_NAME", "DejaVu Sans")

WORK_ROOT = Path(os.environ.get("TOON_WORK_DIR", str(HERMES_HOME / "work" / "toon-videos")))
CHAR_CACHE = Path(os.environ.get("TOON_CHAR_CACHE", str(HERMES_HOME / "cache" / "toon-characters")))
MUSIC_LIBRARY = Path(os.environ.get("TOON_MUSIC_LIBRARY", str(HERMES_HOME / "assets" / "music")))
SPEND_LOG = Path(os.environ.get("HERMES_SPEND_LOG", str(HERMES_HOME / "logs" / "spend.jsonl")))

# --- Style tokens: one fixed string per style, embedded verbatim in every ---
# --- image prompt of a video. Never mix tokens within one video.          ---
STYLE_TOKENS = {
    "classic-cartoon": (
        "classic 2D cartoon illustration, bold clean outlines, saturated flat "
        "colors with soft cel shading, expressive rubber-hose energy, "
        "storybook composition"
    ),
    "flat-modern": (
        "flat modern vector illustration, minimal geometric shapes, limited "
        "corporate-friendly palette, no outlines, subtle long shadows, "
        "generous negative space"
    ),
    "3d-soft": (
        "soft 3D rendered cartoon, rounded toy-like forms, matte clay "
        "materials, gentle global illumination, pastel color grade, shallow "
        "depth of field"
    ),
}

CONSISTENCY_SUFFIX = (
    "consistent character design matching the reference sheet, same "
    "proportions and palette in every frame, single cohesive art style, "
    "no text, no watermark, no photorealism"
)

# --- Rendering constants ---
FPS = 30
CRF = 20
AUDIO_BITRATE = "192k"
SCENE_PAD_SEC = 0.4          # breathing room appended after each scene's VO
MUSIC_DUCK_DB = -14.0        # music level under narration
MUSIC_FADE_SEC = 1.0
RUNTIME_OVERAGE_PCT = 15.0   # trim narration if total VO exceeds target by this
HOOK_CLIP_MAX_SEC = 8.0

RESOLUTIONS = {"9:16": (1080, 1920), "16:9": (1920, 1080)}

# --- ElevenLabs ---
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.environ.get("TOON_VOICE_ID", os.environ.get("ELEVENLABS_VOICE_ID", ""))
ELEVENLABS_MODEL_ID = os.environ.get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")

# --- Supabase (project xzkiqxgslehsmaxnasfp) ---
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://xzkiqxgslehsmaxnasfp.supabase.co").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get(
    "SUPABASE_SERVICE_ROLE_KEY", os.environ.get("SUPABASE_SERVICE_KEY", "")
)
BUCKET_VIDEOS = "toon-videos"
BUCKET_CHARACTERS = "toon-characters"
SIGNED_URL_TTL_SEC = int(os.environ.get("TOON_SIGNED_URL_TTL_SEC", str(7 * 24 * 3600)))

# --- Telegram approval gate ---
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
TELEGRAM_VIDEO_LIMIT_BYTES = 50 * 1024 * 1024  # Bot API upload cap

# --- Cost gates + per-unit estimates (USD unless noted) ---
MAX_VIDEO_COST_USD = float(os.environ.get("TOON_MAX_VIDEO_COST", "3.00"))
MAX_HOOK_CREDITS = int(os.environ.get("TOON_MAX_HOOK_CREDITS", "300"))
MUSIC_MODE = os.environ.get("TOON_MUSIC_MODE", "library")  # library | generate

COST_PER_IMAGE = float(os.environ.get("TOON_COST_PER_IMAGE", "0.07"))
COST_PER_1K_VO_CHARS = float(os.environ.get("TOON_COST_PER_1K_VO_CHARS", "0.15"))
COST_MUSIC_GEN = float(os.environ.get("TOON_COST_MUSIC_GEN", "0.10"))
COST_HOOK_CLIP = float(os.environ.get("TOON_COST_HOOK_CLIP", "0.50"))
HOOK_CLIP_CREDITS = int(os.environ.get("TOON_HOOK_CLIP_CREDITS", "150"))


def work_dir(video_id: str) -> Path:
    d = WORK_ROOT / video_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def require(value: str, name: str) -> str:
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value
