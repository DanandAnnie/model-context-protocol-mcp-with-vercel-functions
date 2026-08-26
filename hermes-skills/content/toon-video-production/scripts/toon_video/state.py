"""scene_plan.json — the single source of truth and resume point.

Every pipeline step reads the plan, fills in what it produced
(duration_sec, assets.*), and writes it back atomically. Re-running any
step skips scenes whose assets already exist, so a partial crash resumes
without regenerating paid assets.
"""

import json
import os
import tempfile
import uuid
from pathlib import Path

from . import config

VALID_CAMERAS = {"zoom-in", "zoom-out", "pan-left", "pan-right", "static"}
VALID_STYLES = set(config.STYLE_TOKENS)
SCENE_COUNT_HINTS = {60: (8, 12), 90: (12, 16)}


def plan_path(video_id: str) -> Path:
    return config.work_dir(video_id) / "scene_plan.json"


def load(video_id: str) -> dict:
    p = plan_path(video_id)
    if not p.exists():
        raise SystemExit(f"No scene_plan.json for video_id {video_id} (expected {p})")
    with open(p) as f:
        return json.load(f)


def save(plan: dict) -> Path:
    p = plan_path(plan["video_id"])
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(plan, f, indent=2)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return p


def new_video_id() -> str:
    return str(uuid.uuid4())


def validate(plan: dict) -> list:
    """Validate against the JSON Schema when jsonschema is installed,
    plus pipeline invariants the schema can't express. Returns a list of
    problems; empty means valid."""
    problems = []

    schema = None
    if config.SCHEMA_PATH.exists():
        with open(config.SCHEMA_PATH) as f:
            schema = json.load(f)
    try:
        import jsonschema  # type: ignore

        if schema is not None:
            for err in jsonschema.Draft7Validator(schema).iter_errors(plan):
                problems.append(f"schema: {'/'.join(str(x) for x in err.absolute_path)}: {err.message}")
    except ImportError:
        problems.extend(_manual_checks(plan))

    scenes = plan.get("scenes") or []
    target = plan.get("target_length_sec")
    if target in SCENE_COUNT_HINTS:
        lo, hi = SCENE_COUNT_HINTS[target]
        if not (lo <= len(scenes) <= hi):
            problems.append(
                f"scene count {len(scenes)} outside {lo}-{hi} expected for {target}s target"
            )
    for i, s in enumerate(scenes, start=1):
        if s.get("n") != i:
            problems.append(f"scene {i}: n={s.get('n')} — scenes must be numbered 1..N in order")
    hooks = [s["n"] for s in scenes if s.get("is_hook")]
    if len(hooks) > 1:
        problems.append(f"multiple hook scenes: {hooks} — only scene 1 may be the hook")
    if hooks and hooks != [1]:
        problems.append(f"hook scene must be scene 1, got {hooks}")

    declared = {c.get("slug") for c in plan.get("characters", [])}
    for s in scenes:
        for slug in s.get("characters", []):
            if slug not in declared:
                problems.append(f"scene {s.get('n')}: undeclared character '{slug}'")
    return problems


def _manual_checks(plan: dict) -> list:
    """Fallback structural checks when jsonschema isn't importable."""
    problems = []
    for key in ("video_id", "title", "style", "target_length_sec", "aspect", "characters", "music_mood", "scenes"):
        if key not in plan:
            problems.append(f"missing top-level key: {key}")
    if plan.get("style") not in VALID_STYLES:
        problems.append(f"invalid style: {plan.get('style')!r}")
    if plan.get("target_length_sec") not in (60, 90):
        problems.append(f"target_length_sec must be 60 or 90, got {plan.get('target_length_sec')!r}")
    if plan.get("aspect") not in config.RESOLUTIONS:
        problems.append(f"invalid aspect: {plan.get('aspect')!r}")
    for s in plan.get("scenes") or []:
        n = s.get("n", "?")
        for key in ("narration", "visual", "camera", "assets"):
            if key not in s:
                problems.append(f"scene {n}: missing {key}")
        if s.get("camera") not in VALID_CAMERAS:
            problems.append(f"scene {n}: invalid camera {s.get('camera')!r}")
    return problems


def scene_asset(plan: dict, n: int, kind: str):
    """Return the existing asset path for scene n if it's on disk, else None."""
    scene = next((s for s in plan["scenes"] if s["n"] == n), None)
    if scene is None:
        raise SystemExit(f"No scene {n} in plan {plan['video_id']}")
    val = (scene.get("assets") or {}).get(kind)
    if val and Path(val).exists():
        return Path(val)
    return None


def set_scene_asset(plan: dict, n: int, kind: str, path) -> None:
    scene = next((s for s in plan["scenes"] if s["n"] == n), None)
    if scene is None:
        raise SystemExit(f"No scene {n} in plan {plan['video_id']}")
    scene.setdefault("assets", {"vo": None, "still": None, "clip": None})
    scene["assets"][kind] = str(path) if path is not None else None


def total_vo_runtime(plan: dict) -> float:
    return sum(float(s.get("duration_sec") or 0.0) for s in plan["scenes"])


def scene_slot_starts(plan: dict) -> dict:
    """Final-timeline start time of each scene (VO duration + pad per scene)."""
    starts, t = {}, 0.0
    for s in plan["scenes"]:
        starts[s["n"]] = t
        t += float(s.get("duration_sec") or 0.0) + config.SCENE_PAD_SEC
    return starts
