"""Step 7 — Captions: per-scene word timings -> one ASS file on the final
timeline, styled by the template asset. Styles are addable by dropping a
new .ass template into assets/captions/ — no code changes."""

import json
from pathlib import Path

from . import config, state

MAX_WORDS_PER_LINE = 4
MAX_GAP_SEC = 0.6  # start a new caption event after a pause this long


def _ts(sec: float) -> str:
    sec = max(sec, 0.0)
    h = int(sec // 3600)
    m = int(sec % 3600 // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _events_for_scene(words: list, offset: float) -> list:
    """Group word timings into short caption lines."""
    events, group = [], []
    for w in words:
        if group and (
            len(group) >= MAX_WORDS_PER_LINE
            or w["start"] - group[-1]["end"] > MAX_GAP_SEC
        ):
            events.append(group)
            group = []
        group.append(w)
    if group:
        events.append(group)
    return [
        {
            "start": offset + g[0]["start"],
            "end": offset + g[-1]["end"] + 0.15,
            "text": " ".join(x["word"] for x in g),
        }
        for g in events
    ]


def build_ass(video_id: str, template: Path = None) -> Path:
    plan = state.load(video_id)
    template = template or config.ASS_TEMPLATE
    header = template.read_text()
    if "[Events]" not in header:
        raise SystemExit(f"Caption template {template} has no [Events] section")
    header = header.split("[Events]")[0].rstrip()

    starts = state.scene_slot_starts(plan)
    lines = [
        header,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    n_events = 0
    for scene in plan["scenes"]:
        words_file = (scene.get("assets") or {}).get("words")
        if not words_file or not Path(words_file).exists():
            print(f"scene {scene['n']}: no word timings, skipping captions for this scene")
            continue
        words = json.loads(Path(words_file).read_text())
        for ev in _events_for_scene(words, starts[scene["n"]]):
            text = ev["text"].replace("\n", " ").replace("{", "(").replace("}", ")")
            lines.append(
                f"Dialogue: 0,{_ts(ev['start'])},{_ts(ev['end'])},Toon,,0,0,0,,{text}"
            )
            n_events += 1

    out = config.work_dir(video_id) / "captions.ass"
    out.write_text("\n".join(lines) + "\n")
    print(f"captions: {n_events} events -> {out}")
    return out
