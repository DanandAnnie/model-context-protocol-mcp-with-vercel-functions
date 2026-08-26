"""Step 9 — Telegram approval gate. Nothing posts without approval:
Hermes proposes, Dan approves.

SHARED-CANDIDATE: faceless-video-production has the same gate — unify on
the Mac Mini. Callback handling (button taps) stays with the existing
Hermes Telegram listener, which shells out to:
    toon approve <video_id> | toon kill <video_id> | toon reroll <video_id> <n>
"""

import json
from pathlib import Path

import requests

from . import config


def _api(method: str) -> str:
    token = config.require(config.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN")
    return f"https://api.telegram.org/bot{token}/{method}"


def _keyboard(video_id: str) -> str:
    return json.dumps({
        "inline_keyboard": [
            [{"text": "✅ Approve", "callback_data": f"toon:approve:{video_id}"}],
            [{"text": "🎬 Re-roll scene…", "callback_data": f"toon:reroll:{video_id}"}],
            [{"text": "❌ Kill", "callback_data": f"toon:kill:{video_id}"}],
        ]
    })


def send_preview(video_id: str, mp4: Path, caption: str, fallback_url: str) -> None:
    chat_id = config.require(config.TELEGRAM_CHAT_ID, "TELEGRAM_CHAT_ID")
    if mp4.stat().st_size <= config.TELEGRAM_VIDEO_LIMIT_BYTES:
        with open(mp4, "rb") as f:
            resp = requests.post(
                _api("sendVideo"),
                data={
                    "chat_id": chat_id,
                    "caption": caption,
                    "supports_streaming": "true",
                    "reply_markup": _keyboard(video_id),
                },
                files={"video": (mp4.name, f, "video/mp4")},
                timeout=600,
            )
    else:
        # Over the Bot API upload cap: send the signed Supabase URL instead.
        resp = requests.post(
            _api("sendMessage"),
            data={
                "chat_id": chat_id,
                "text": f"{caption}\n\n▶️ {fallback_url}",
                "reply_markup": _keyboard(video_id),
            },
            timeout=60,
        )
    if resp.status_code != 200:
        raise SystemExit(f"Telegram send failed {resp.status_code}: {resp.text[:500]}")


def send_note(text: str) -> None:
    """Plain status/flag message (QC failures, cost gates, errors)."""
    chat_id = config.require(config.TELEGRAM_CHAT_ID, "TELEGRAM_CHAT_ID")
    resp = requests.post(
        _api("sendMessage"),
        data={"chat_id": chat_id, "text": text},
        timeout=60,
    )
    if resp.status_code != 200:
        raise SystemExit(f"Telegram send failed {resp.status_code}: {resp.text[:500]}")
