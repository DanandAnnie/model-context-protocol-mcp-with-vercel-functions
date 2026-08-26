"""Step 2 — Voiceover, audio-first.

SHARED-CANDIDATE: faceless-video-production has an ElevenLabs VO step.
On the Mac Mini, fold that skill's implementation and this module into one
shared module (~/.hermes/skills/content/_shared/elevenlabs_vo.py) and make
both skills import it — do not maintain two copies.

One MP3 per scene via ElevenLabs with-timestamps, measured with ffprobe,
duration_sec written back into scene_plan.json. Word-level timings are
saved per scene for the caption step. Idempotent: scenes whose VO already
exists on disk are skipped unless forced.
"""

import base64
import json
import shutil
import subprocess
from pathlib import Path

import requests

from . import config, costs, media, state


def synthesize_scene(text: str, mp3_path: Path, words_path: Path) -> None:
    api_key = config.require(config.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY")
    voice = config.require(config.ELEVENLABS_VOICE_ID, "ELEVENLABS_VOICE_ID (or TOON_VOICE_ID)")
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps"
    resp = requests.post(
        url,
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": config.ELEVENLABS_MODEL_ID,
            "output_format": "mp3_44100_128",
        },
        timeout=120,
    )
    if resp.status_code != 200:
        raise SystemExit(f"ElevenLabs error {resp.status_code}: {resp.text[:500]}")
    body = resp.json()
    mp3_path.write_bytes(base64.b64decode(body["audio_base64"]))
    words = chars_to_words(body.get("alignment") or {})
    words_path.write_text(json.dumps(words, indent=2))


def chars_to_words(alignment: dict) -> list:
    """Collapse ElevenLabs character alignment into word timings."""
    chars = alignment.get("characters") or []
    starts = alignment.get("character_start_times_seconds") or []
    ends = alignment.get("character_end_times_seconds") or []
    words, cur, w_start, w_end = [], "", None, None
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if cur:
                words.append({"word": cur, "start": w_start, "end": w_end})
                cur, w_start = "", None
            continue
        if not cur:
            w_start = s
        cur += ch
        w_end = e
    if cur:
        words.append({"word": cur, "start": w_start, "end": w_end})
    return words


def whisper_fallback(mp3_path: Path, words_path: Path) -> bool:
    """Local word timestamps via whisper-cpp when ElevenLabs alignment is
    missing. Returns False when no whisper binary is installed."""
    binary = shutil.which("whisper-cli") or shutil.which("whisper-cpp") or shutil.which("main")
    if not binary:
        return False
    wav = mp3_path.with_suffix(".16k.wav")
    media.run([shutil.which("ffmpeg"), "-y", "-i", str(mp3_path), "-ar", "16000", "-ac", "1", str(wav)])
    out_prefix = str(mp3_path.with_suffix(""))
    proc = subprocess.run(
        [binary, "-f", str(wav), "-ml", "1", "-oj", "-of", out_prefix],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return False
    result = json.loads(Path(out_prefix + ".json").read_text())
    words = []
    for seg in result.get("transcription", []):
        token = seg.get("text", "").strip()
        offsets = seg.get("offsets") or {}
        if token:
            words.append({
                "word": token,
                "start": offsets.get("from", 0) / 1000.0,
                "end": offsets.get("to", 0) / 1000.0,
            })
    words_path.write_text(json.dumps(words, indent=2))
    return True


def run_vo(video_id: str, only_scenes=None, force: bool = False) -> dict:
    plan = state.load(video_id)
    wd = config.work_dir(video_id) / "vo"
    wd.mkdir(exist_ok=True)

    for scene in plan["scenes"]:
        n = scene["n"]
        if only_scenes and n not in only_scenes:
            continue
        mp3 = wd / f"scene_{n:02d}.mp3"
        words = wd / f"scene_{n:02d}.words.json"
        if mp3.exists() and not force:
            print(f"scene {n}: VO exists, skipping")
        else:
            print(f"scene {n}: synthesizing {len(scene['narration'])} chars")
            synthesize_scene(scene["narration"], mp3, words)
            costs.log_spend(
                video_id, step="vo", provider="elevenlabs",
                units=len(scene["narration"]),
                cost_usd=len(scene["narration"]) / 1000.0 * config.COST_PER_1K_VO_CHARS,
                note=f"scene {n}",
            )
            # Force re-cutting downstream: a new VO invalidates the old clip.
            state.set_scene_asset(plan, n, "clip", None)
        if not words.exists():
            if not whisper_fallback(mp3, words):
                print(f"scene {n}: WARNING no word timestamps (no alignment, no whisper-cpp)")
        scene["duration_sec"] = round(media.probe_duration(mp3), 3)
        state.set_scene_asset(plan, n, "vo", mp3)
        if words.exists():
            state.set_scene_asset(plan, n, "words", words)
        state.save(plan)

    return runtime_check(plan)


def runtime_check(plan: dict) -> dict:
    """Audio-first invariant: measured VO drives everything downstream.
    If total runtime exceeds target by >RUNTIME_OVERAGE_PCT, report which
    scenes to trim — Claude rewrites those narrations and re-runs vo for
    only the offending scenes."""
    total = state.total_vo_runtime(plan)
    padded = total + config.SCENE_PAD_SEC * len(plan["scenes"])
    target = float(plan["target_length_sec"])
    overage_pct = (padded - target) / target * 100.0
    report = {
        "total_vo_sec": round(total, 2),
        "padded_runtime_sec": round(padded, 2),
        "target_sec": target,
        "overage_pct": round(overage_pct, 1),
        "over_budget": overage_pct > config.RUNTIME_OVERAGE_PCT,
        "trim_candidates": [],
    }
    if report["over_budget"]:
        per_scene_budget = target / max(len(plan["scenes"]), 1)
        report["trim_candidates"] = sorted(
            (
                {"n": s["n"], "duration_sec": s["duration_sec"], "chars": len(s["narration"])}
                for s in plan["scenes"]
                if (s.get("duration_sec") or 0) > per_scene_budget
            ),
            key=lambda x: -x["duration_sec"],
        )
    return report
