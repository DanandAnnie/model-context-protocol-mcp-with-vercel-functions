"""Step 0/6 — Cost estimation, hard gates, and spend logging.

Spend lines append to the claude-hermes JSONL (HERMES_SPEND_LOG) tagged
task=toon-video with the video_id, so the existing nightly ETL picks them
up into ai_usage unchanged.
"""

import datetime
import json

from . import config


def estimate(plan: dict) -> dict:
    n_scenes = len(plan["scenes"])
    vo_chars = sum(len(s["narration"]) for s in plan["scenes"])
    hook = bool(plan.get("hook_video"))
    # +1 still per not-yet-cached character for the reference sheet.
    uncached_chars = sum(1 for c in plan.get("characters", []) if not c.get("reference_image_url"))

    images = n_scenes + uncached_chars
    breakdown = {
        "stills": round(images * config.COST_PER_IMAGE, 4),
        "vo": round(vo_chars / 1000.0 * config.COST_PER_1K_VO_CHARS, 4),
        "music": round(config.COST_MUSIC_GEN, 4) if config.MUSIC_MODE == "generate" else 0.0,
        "hook_clip": round(config.COST_HOOK_CLIP, 4) if hook else 0.0,
    }
    total = round(sum(breakdown.values()), 4)
    return {
        "scenes": n_scenes,
        "images": images,
        "vo_chars": vo_chars,
        "hook_video": hook,
        "hook_credits": config.HOOK_CLIP_CREDITS if hook else 0,
        "breakdown_usd": breakdown,
        "total_usd": total,
        "over_video_gate": total > config.MAX_VIDEO_COST_USD,
        "over_hook_gate": hook and config.HOOK_CLIP_CREDITS > config.MAX_HOOK_CREDITS,
        "video_gate_usd": config.MAX_VIDEO_COST_USD,
        "hook_gate_credits": config.MAX_HOOK_CREDITS,
    }


def enforce_gates(est: dict, confirmed: bool) -> None:
    """Exit non-zero when a gate trips and Dan hasn't confirmed. Claude
    surfaces the estimate and only retries with --confirm-cost after an
    explicit go-ahead."""
    blocked = []
    if est["over_video_gate"]:
        blocked.append(
            f"estimated ${est['total_usd']:.2f} exceeds TOON_MAX_VIDEO_COST "
            f"${est['video_gate_usd']:.2f}"
        )
    if est["over_hook_gate"]:
        blocked.append(
            f"hook clip {est['hook_credits']} credits exceeds TOON_MAX_HOOK_CREDITS "
            f"{est['hook_gate_credits']}"
        )
    if blocked and not confirmed:
        raise SystemExit(
            "COST GATE: " + "; ".join(blocked) + ". Re-run with --confirm-cost after approval."
        )


def log_spend(video_id: str, step: str, provider: str, units, cost_usd: float, note: str = "") -> None:
    config.SPEND_LOG.parent.mkdir(parents=True, exist_ok=True)
    line = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "task": "toon-video",
        "video_id": video_id,
        "step": step,
        "provider": provider,
        "units": units,
        "cost_usd": round(float(cost_usd), 6),
        "note": note,
    }
    with open(config.SPEND_LOG, "a") as f:
        f.write(json.dumps(line) + "\n")


def actual_spend(video_id: str) -> float:
    if not config.SPEND_LOG.exists():
        return 0.0
    total = 0.0
    with open(config.SPEND_LOG) as f:
        for raw in f:
            try:
                line = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if line.get("task") == "toon-video" and line.get("video_id") == video_id:
                total += float(line.get("cost_usd") or 0.0)
    return round(total, 4)
