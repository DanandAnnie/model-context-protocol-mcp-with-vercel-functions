"""Step 7 — Captions: per-scene word timings -> one ASS file on the final
timeline, styled by the template asset. Styles are addable by dropping a
new .ass template into assets/captions/ — no code changes."""

import json
import re
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


def build_ass(video_id: str, template: Path = None, aspect: str = None,
              out_name: str = "captions.ass") -> Path:
    plan = state.load(video_id)
    template = template or config.ASS_TEMPLATE
    header = template.read_text()
    if "[Events]" not in header:
        raise SystemExit(f"Caption template {template} has no [Events] section")
    header = header.split("[Events]")[0].rstrip()
    header = _fit_playres(header, aspect or plan.get("aspect", "9:16"))

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

    out = config.work_dir(video_id) / out_name
    out.write_text("\n".join(lines) + "\n")
    print(f"captions: {n_events} events -> {out}")
    return out


def _playres_value(header: str, key: str):
    m = re.search(rf"(?m)^{key}:\s*(\d+)", header)
    return int(m.group(1)) if m else None


# Style fields measured in PlayRes pixels, and which axis they scale with.
_H_SCALED_FIELDS = ("Fontsize", "Spacing", "Outline", "Shadow", "MarginV")
_W_SCALED_FIELDS = ("MarginL", "MarginR")


def _scale_styles(header: str, wf: float, hf: float) -> str:
    """Scale pixel-denominated Style fields when the script space changes,
    so captions keep the same on-screen proportions in every export."""
    lines = header.splitlines()
    fields = None
    for i, line in enumerate(lines):
        if line.startswith("Format:") and fields is None and "Fontsize" in line:
            fields = [f.strip() for f in line.split(":", 1)[1].split(",")]
        elif line.startswith("Style:") and fields:
            values = [v.strip() for v in line.split(":", 1)[1].split(",")]
            for j, name in enumerate(fields[: len(values)]):
                factor = hf if name in _H_SCALED_FIELDS else wf if name in _W_SCALED_FIELDS else None
                if factor is not None:
                    try:
                        values[j] = str(int(round(float(values[j]) * factor)))
                    except ValueError:
                        pass
            lines[i] = "Style: " + ",".join(values)
    return "\n".join(lines)


def _fit_playres(header: str, aspect: str) -> str:
    """Fit the template's script space to the render resolution: rewrite (or
    inject) PlayRes and rescale the Style's pixel values to match, so caption
    size and placement stay proportionally identical across exports."""
    w, h = config.RESOLUTIONS.get(aspect, config.RESOLUTIONS["9:16"])
    tw, th = _playres_value(header, "PlayResX"), _playres_value(header, "PlayResY")
    if tw is None or th is None:
        # No declared script space: claim the render resolution outright so
        # libass never falls back to its implied 384x288 space.
        return header.replace(
            "[Script Info]", f"[Script Info]\nPlayResX: {w}\nPlayResY: {h}", 1
        )
    if (tw, th) == (w, h):
        return header
    header = re.sub(r"(?m)^PlayResX:\s*\d+", f"PlayResX: {w}", header)
    header = re.sub(r"(?m)^PlayResY:\s*\d+", f"PlayResY: {h}", header)
    return _scale_styles(header, w / tw, h / th)
