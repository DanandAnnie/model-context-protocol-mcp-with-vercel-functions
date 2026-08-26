"""CLI for the toon pipeline. Claude (Hermes) drives these subcommands per
SKILL.md; each is idempotent and resumes from scene_plan.json.

Usage:  ~/.hermes/venvs/toon/bin/python -m toon_video <command> ...

Exit codes: 0 ok · 1 error · 3 cost gate tripped · 4 runtime over budget
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

from . import captions, characters, config, costs, media, state, vo


def _print(obj) -> None:
    print(json.dumps(obj, indent=2, default=str))


def _parse_scenes(arg):
    return [int(x) for x in arg.split(",")] if arg else None


# --- commands ------------------------------------------------------------

def cmd_init(args):
    raw = json.loads(Path(args.plan).read_text())
    raw.setdefault("video_id", state.new_video_id())
    raw.setdefault("aspect", "9:16")
    raw.setdefault("hook_video", bool(args.hook_video))
    for s in raw.get("scenes", []):
        s.setdefault("is_hook", s.get("n") == 1 and raw["hook_video"])
        s.setdefault("duration_sec", None)
        s.setdefault("assets", {"vo": None, "still": None, "clip": None})
    problems = state.validate(raw)
    if problems:
        _print({"valid": False, "problems": problems})
        sys.exit(1)
    est = costs.estimate(raw)
    state.save(raw)
    try:
        costs.enforce_gates(est, confirmed=args.confirm_cost)
    except SystemExit as e:
        _print({"video_id": raw["video_id"], "estimate": est, "blocked": str(e)})
        sys.exit(3)
    if not args.local_only:
        from . import supabase_io
        supabase_io.upsert_job(raw, "planning", credit_cost_estimate=est["total_usd"])
    _print({"video_id": raw["video_id"], "estimate": est, "plan": str(state.plan_path(raw["video_id"]))})


def cmd_validate(args):
    plan = json.loads(Path(args.plan).read_text())
    problems = state.validate(plan)
    _print({"valid": not problems, "problems": problems})
    sys.exit(0 if not problems else 1)


def cmd_estimate(args):
    _print(costs.estimate(state.load(args.video_id)))


def cmd_vo(args):
    if not args.local_only:
        from . import supabase_io
        supabase_io.set_job_status(args.video_id, "voicing")
    report = vo.run_vo(args.video_id, only_scenes=_parse_scenes(args.scenes), force=args.force)
    _print(report)
    if report["over_budget"]:
        print(
            f"RUNTIME OVER BUDGET by {report['overage_pct']}% — trim narration on scenes "
            f"{[c['n'] for c in report['trim_candidates']]} and re-run "
            f"`vo --scenes <ns> --force`.",
            file=sys.stderr,
        )
        sys.exit(4)


def cmd_still_prompts(args):
    """Emit the per-scene image prompts (style token + character sheet refs +
    visual + consistency suffix) for Claude to feed generate_image_batch."""
    plan = state.load(args.video_id)
    token = config.STYLE_TOKENS[plan["style"]]
    refs = {c["slug"]: c.get("reference_image_url") for c in plan.get("characters", [])}
    out = []
    for s in plan["scenes"]:
        if state.scene_asset(plan, s["n"], "still") and not args.include_done:
            continue
        out.append({
            "n": s["n"],
            "prompt": f"{token}. {s['visual']}. {config.CONSISTENCY_SUFFIX}",
            "character_refs": [
                {"slug": slug, "reference_image_url": refs.get(slug),
                 "local_sheet": str(characters.cache_path(slug, plan["style"]))}
                for slug in s.get("characters", [])
            ],
            "aspect": plan["aspect"],
            "is_hook": s.get("is_hook", False),
        })
    _print({"video_id": plan["video_id"], "style": plan["style"], "prompts": out})


def _fetch_to(path_or_url: str, dest: Path) -> Path:
    if path_or_url.startswith(("http://", "https://")):
        import requests
        resp = requests.get(path_or_url, timeout=300)
        if resp.status_code != 200:
            raise SystemExit(f"Download failed {resp.status_code}: {path_or_url}")
        dest.write_bytes(resp.content)
    else:
        src = Path(path_or_url)
        if not src.exists():
            raise SystemExit(f"No such file: {src}")
        if src.resolve() != dest.resolve():
            shutil.copyfile(src, dest)
    return dest


def cmd_register_still(args):
    plan = state.load(args.video_id)
    wd = config.work_dir(args.video_id) / "stills"
    wd.mkdir(exist_ok=True)
    dest = _fetch_to(args.source, wd / f"scene_{args.n:02d}.png")
    state.set_scene_asset(plan, args.n, "still", dest)
    # New still invalidates the old motion clip.
    state.set_scene_asset(plan, args.n, "clip", None)
    state.save(plan)
    _print({"scene": args.n, "still": str(dest)})


def cmd_register_clip(args):
    plan = state.load(args.video_id)
    scene = next(s for s in plan["scenes"] if s["n"] == args.n)
    if not scene.get("is_hook"):
        raise SystemExit(f"scene {args.n} is not the hook scene — clips are hook-only in v1")
    wd = config.work_dir(args.video_id) / "clips"
    wd.mkdir(exist_ok=True)
    raw = _fetch_to(args.source, wd / f"scene_{args.n:02d}.raw.mp4")
    dur = min(
        float(scene["duration_sec"] or config.HOOK_CLIP_MAX_SEC) + config.SCENE_PAD_SEC,
        config.HOOK_CLIP_MAX_SEC,
    )
    conformed = media.conform_clip(raw, wd / f"scene_{args.n:02d}.mp4", dur, plan["aspect"])
    state.set_scene_asset(plan, args.n, "clip", conformed)
    state.save(plan)
    costs.log_spend(args.video_id, "hook-clip", args.provider, 1, args.cost_usd, f"scene {args.n}")
    _print({"scene": args.n, "clip": str(conformed), "duration_sec": dur})


def cmd_character(args):
    if args.action == "lookup":
        found = characters.lookup(args.slug, args.style)
        _print({"slug": args.slug, "style": args.style,
                "cached": found["path"] is not None,
                "path": found["path"], "url": found["url"]})
    elif args.action == "prompt":
        print(characters.sheet_prompt(args.description or "", args.style))
    elif args.action == "register":
        reg = characters.register(args.slug, args.style, args.description or "", Path(args.image))
        if args.cost_usd:
            costs.log_spend("-", "character-sheet", "image-gen", 1, args.cost_usd, args.slug)
        _print({"slug": args.slug, "style": args.style, "path": reg["path"], "url": reg["url"]})


def cmd_clips(args):
    """Ken Burns motion for every scene with a still and no clip yet."""
    plan = state.load(args.video_id)
    if not args.local_only:
        from . import supabase_io
        supabase_io.set_job_status(args.video_id, "rendering")
    wd = config.work_dir(args.video_id) / "clips"
    wd.mkdir(exist_ok=True)
    made = []
    for s in plan["scenes"]:
        n = s["n"]
        if state.scene_asset(plan, n, "clip") and not args.force:
            continue
        still = state.scene_asset(plan, n, "still")
        if still is None:
            raise SystemExit(f"scene {n}: no still registered — run still generation first")
        if s.get("duration_sec") is None:
            raise SystemExit(f"scene {n}: no duration_sec — run vo first (audio-first ordering)")
        dur = float(s["duration_sec"]) + config.SCENE_PAD_SEC
        clip = media.kenburns_clip(still, wd / f"scene_{n:02d}.mp4", dur, s["camera"], plan["aspect"])
        state.set_scene_asset(plan, n, "clip", clip)
        state.save(plan)
        made.append(n)
    _print({"video_id": args.video_id, "rendered": made})


def cmd_music(args):
    plan = state.load(args.video_id)
    wd = config.work_dir(args.video_id)
    if args.file:
        dest = wd / ("music_bed" + (Path(args.file).suffix or ".mp3"))
        _fetch_to(args.file, dest)
        if config.MUSIC_MODE == "generate" and args.cost_usd:
            costs.log_spend(args.video_id, "music", "music-gen", 1, args.cost_usd, plan["music_mood"])
    else:
        # Library mode: pick the first track whose filename mentions the mood.
        mood = plan["music_mood"].lower()
        candidates = sorted(
            p for p in config.MUSIC_LIBRARY.glob("**/*")
            if p.suffix.lower() in (".mp3", ".wav", ".m4a", ".aac", ".flac")
        )
        match = next((p for p in candidates if any(tok in p.name.lower() for tok in mood.split("-"))), None)
        if match is None and candidates:
            match = candidates[0]
            print(f"music: no '{mood}' match in library, falling back to {match.name}")
        if match is None:
            raise SystemExit(
                f"No tracks in {config.MUSIC_LIBRARY} — add licensed tracks or use "
                f"TOON_MUSIC_MODE=generate with --file"
            )
        dest = wd / ("music_bed" + match.suffix)
        shutil.copyfile(match, dest)
    plan["music_asset"] = str(dest)
    state.save(plan)
    _print({"video_id": args.video_id, "music": str(dest)})


def cmd_captions(args):
    template = Path(args.template) if args.template else None
    out = captions.build_ass(args.video_id, template=template)
    _print({"video_id": args.video_id, "ass": str(out)})


def final_name(aspect: str) -> str:
    return "final_" + aspect.replace(":", "x") + ".mp4"


def _secondary_clips(plan: dict, wd: Path, aspect: str) -> list:
    """Re-render every scene's motion clip at a second aspect. Pure FFmpeg
    from assets already on disk (stills + raw hook clip), zero credit cost,
    so these aren't tracked in the plan — just rebuilt when missing."""
    out_dir = wd / ("clips_" + aspect.replace(":", "x"))
    out_dir.mkdir(exist_ok=True)
    clips = []
    for s in plan["scenes"]:
        n = s["n"]
        out = out_dir / f"scene_{n:02d}.mp4"
        if out.exists():
            clips.append(out)
            continue
        dur = float(s["duration_sec"]) + config.SCENE_PAD_SEC
        raw_hook = wd / "clips" / f"scene_{n:02d}.raw.mp4"
        if s.get("is_hook") and raw_hook.exists():
            dur = min(dur, config.HOOK_CLIP_MAX_SEC)
            clips.append(media.conform_clip(raw_hook, out, dur, aspect))
            continue
        still = state.scene_asset(plan, n, "still")
        if still is None:
            raise SystemExit(f"scene {n}: no still on disk — can't render {aspect} clip")
        clips.append(media.kenburns_clip(still, out, dur, s["camera"], aspect))
    return clips


def cmd_assemble(args):
    plan = state.load(args.video_id)
    wd = config.work_dir(args.video_id)
    audio_dir = wd / "audio"
    audio_dir.mkdir(exist_ok=True)

    clips, wavs = [], []
    for s in plan["scenes"]:
        n = s["n"]
        clip = state.scene_asset(plan, n, "clip")
        vo_mp3 = state.scene_asset(plan, n, "vo")
        if clip is None:
            raise SystemExit(f"scene {n}: no clip — run `clips` (or register the hook clip) first")
        if vo_mp3 is None:
            raise SystemExit(f"scene {n}: no VO — run `vo` first")
        clips.append(clip)
        wavs.append(media.pad_vo(vo_mp3, audio_dir / f"scene_{n:02d}.wav", config.SCENE_PAD_SEC))

    silent = media.concat_clips(clips, wd / "video_silent.mp4")
    vo_track = media.concat_wavs(wavs, wd / "vo_track.wav")
    total = media.probe_duration(vo_track)

    music_file = plan.get("music_asset")
    if music_file and Path(music_file).exists():
        mixed = media.mix_music(vo_track, Path(music_file), wd / "audio_mix.wav", total)
    else:
        print("assemble: no music bed registered, using VO only")
        mixed = vo_track

    primary = plan.get("aspect", "9:16")
    ass_path = None if args.no_captions else captions.build_ass(args.video_id, aspect=primary)

    out = media.mux_and_burn(silent, mixed, ass_path, wd / final_name(primary))
    thumb = media.thumbnail(out, wd / "thumbnail.jpg")
    result = {"video_id": args.video_id, "mp4": str(out), "thumbnail": str(thumb),
              "runtime_sec": round(media.probe_duration(out), 2)}

    if args.also_horizontal:
        other = "16:9" if primary == "9:16" else "9:16"
        silent2 = media.concat_clips(
            _secondary_clips(plan, wd, other),
            wd / ("video_silent_" + other.replace(":", "x") + ".mp4"),
        )
        ass2 = None if args.no_captions else captions.build_ass(
            args.video_id, aspect=other,
            out_name="captions_" + other.replace(":", "x") + ".ass",
        )
        out2 = media.mux_and_burn(silent2, mixed, ass2, wd / final_name(other))
        result["mp4_" + other.replace(":", "x")] = str(out2)
    _print(result)


def cmd_publish(args):
    from . import supabase_io, telegram_gate
    plan = state.load(args.video_id)
    wd = config.work_dir(args.video_id)
    primary_name = final_name(plan.get("aspect", "9:16"))
    mp4 = wd / primary_name
    thumb = wd / "thumbnail.jpg"
    if not mp4.exists():
        raise SystemExit(f"No {primary_name} — run `assemble` first")

    vid = plan["video_id"]
    supabase_io.upload(config.BUCKET_VIDEOS, f"{vid}/{primary_name}", mp4)
    if thumb.exists():
        supabase_io.upload(config.BUCKET_VIDEOS, f"{vid}/thumbnail.jpg", thumb)
    # Secondary-aspect export rides along when assemble produced one.
    for aspect in config.RESOLUTIONS:
        extra = wd / final_name(aspect)
        if extra.exists() and extra != mp4:
            supabase_io.upload(config.BUCKET_VIDEOS, f"{vid}/{extra.name}", extra)
    url = supabase_io.signed_url(config.BUCKET_VIDEOS, f"{vid}/{primary_name}")

    actual = costs.actual_spend(vid)
    supabase_io.upsert_job(
        plan, "awaiting_approval",
        output_url=f"supabase://{config.BUCKET_VIDEOS}/{vid}/{primary_name}",
        credit_cost_actual=actual,
    )
    flagged = [s["n"] for s in plan["scenes"] if (s.get("qc") or {}).get("flagged")]
    caption = (
        f"🎬 {plan['title']}\n"
        f"{plan['style']} · {round(media.probe_duration(mp4))}s · ${actual:.2f} actual"
        + (f"\n⚠️ QC-flagged scenes: {flagged}" if flagged else "")
    )
    telegram_gate.send_preview(vid, mp4, caption, url)
    _print({"video_id": vid, "status": "awaiting_approval", "signed_url": url,
            "actual_cost_usd": actual})


def cmd_approve(args):
    from . import supabase_io
    supabase_io.set_job_status(args.video_id, "approved")
    _print({"video_id": args.video_id, "status": "approved"})


def cmd_kill(args):
    from . import supabase_io
    supabase_io.set_job_status(args.video_id, "killed")
    _print({"video_id": args.video_id, "status": "killed"})


def cmd_reroll(args):
    """Regenerate one scene's still (+clip). VO untouched unless the
    narration changed (pass --narration)."""
    plan = state.load(args.video_id)
    scene = next((s for s in plan["scenes"] if s["n"] == args.n), None)
    if scene is None:
        raise SystemExit(f"No scene {args.n}")
    if args.visual:
        scene["visual"] = args.visual
    state.set_scene_asset(plan, args.n, "still", None)
    state.set_scene_asset(plan, args.n, "clip", None)
    if args.narration:
        scene["narration"] = args.narration
        state.set_scene_asset(plan, args.n, "vo", None)
        state.set_scene_asset(plan, args.n, "words", None)
        scene["duration_sec"] = None
    state.save(plan)
    if not args.local_only:
        from . import supabase_io
        supabase_io.set_job_status(args.video_id, "rendering")
    steps = ["still-prompts + generate + register-still", "clips", "assemble", "publish"]
    if args.narration:
        steps.insert(0, f"vo --scenes {args.n} --force")
    _print({"video_id": args.video_id, "scene": args.n, "cleared": True, "next_steps": steps})


def cmd_qc_flag(args):
    plan = state.load(args.video_id)
    scene = next(s for s in plan["scenes"] if s["n"] == args.n)
    qc = scene.get("qc") or {"rerolled": 0, "flagged": False, "reason": None}
    if args.rerolled:
        qc["rerolled"] = int(qc.get("rerolled", 0)) + 1
    if args.flag:
        qc["flagged"] = True
        qc["reason"] = args.reason
    scene["qc"] = qc
    state.save(plan)
    _print({"scene": args.n, "qc": qc})


def cmd_status(args):
    plan = state.load(args.video_id)
    scenes = []
    for s in plan["scenes"]:
        scenes.append({
            "n": s["n"],
            "duration_sec": s.get("duration_sec"),
            "vo": state.scene_asset(plan, s["n"], "vo") is not None,
            "words": state.scene_asset(plan, s["n"], "words") is not None,
            "still": state.scene_asset(plan, s["n"], "still") is not None,
            "clip": state.scene_asset(plan, s["n"], "clip") is not None,
        })
    _print({
        "video_id": plan["video_id"], "title": plan["title"], "style": plan["style"],
        "music": plan.get("music_asset"),
        "runtime_sec": round(state.total_vo_runtime(plan) + config.SCENE_PAD_SEC * len(scenes), 2),
        "scenes": scenes,
        "actual_cost_usd": costs.actual_spend(plan["video_id"]),
    })


# --- parser --------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="toon_video", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    def vid(sp):
        sp.add_argument("video_id")
        return sp

    sp = sub.add_parser("init", help="validate a plan file, gate cost, create work dir + job row")
    sp.add_argument("plan", help="path to scene_plan.json draft")
    sp.add_argument("--hook-video", action="store_true")
    sp.add_argument("--confirm-cost", action="store_true")
    sp.add_argument("--local-only", action="store_true", help="skip Supabase job row")
    sp.set_defaults(fn=cmd_init)

    sp = sub.add_parser("validate", help="validate a plan file only")
    sp.add_argument("plan")
    sp.set_defaults(fn=cmd_validate)

    sp = vid(sub.add_parser("estimate"))
    sp.set_defaults(fn=cmd_estimate)

    sp = vid(sub.add_parser("vo", help="ElevenLabs VO per scene + durations + runtime check"))
    sp.add_argument("--scenes", help="comma-separated scene numbers")
    sp.add_argument("--force", action="store_true")
    sp.add_argument("--local-only", action="store_true")
    sp.set_defaults(fn=cmd_vo)

    sp = vid(sub.add_parser("still-prompts", help="emit image prompts for pending scenes"))
    sp.add_argument("--include-done", action="store_true")
    sp.set_defaults(fn=cmd_still_prompts)

    sp = vid(sub.add_parser("register-still"))
    sp.add_argument("n", type=int)
    sp.add_argument("source", help="local path or URL of the generated still")
    sp.set_defaults(fn=cmd_register_still)

    sp = vid(sub.add_parser("register-clip", help="register + conform the hook image-to-video clip"))
    sp.add_argument("n", type=int)
    sp.add_argument("source")
    sp.add_argument("--provider", default="veo")
    sp.add_argument("--cost-usd", type=float, default=config.COST_HOOK_CLIP)
    sp.set_defaults(fn=cmd_register_clip)

    sp = sub.add_parser("character", help="lookup/prompt/register a character sheet")
    sp.add_argument("action", choices=["lookup", "prompt", "register"])
    sp.add_argument("slug")
    sp.add_argument("--style", required=True, choices=sorted(config.STYLE_TOKENS))
    sp.add_argument("--description", default="")
    sp.add_argument("--image", help="path of generated sheet (register)")
    sp.add_argument("--cost-usd", type=float, default=0.0)
    sp.set_defaults(fn=cmd_character)

    sp = vid(sub.add_parser("clips", help="Ken Burns clips for scenes missing them"))
    sp.add_argument("--force", action="store_true")
    sp.add_argument("--local-only", action="store_true")
    sp.set_defaults(fn=cmd_clips)

    sp = vid(sub.add_parser("music", help="pick a library bed by mood, or register a generated one"))
    sp.add_argument("--file", help="generated/explicit track path or URL")
    sp.add_argument("--cost-usd", type=float, default=config.COST_MUSIC_GEN)
    sp.set_defaults(fn=cmd_music)

    sp = vid(sub.add_parser("captions", help="build ASS captions from word timings"))
    sp.add_argument("--template")
    sp.set_defaults(fn=cmd_captions)

    sp = vid(sub.add_parser("assemble", help="concat clips + mux VO + music + burn captions"))
    sp.add_argument("--no-captions", action="store_true")
    sp.add_argument("--also-horizontal", action="store_true")
    sp.set_defaults(fn=cmd_assemble)

    sp = vid(sub.add_parser("publish", help="upload to Supabase + Telegram approval gate"))
    sp.set_defaults(fn=cmd_publish)

    sp = vid(sub.add_parser("approve"))
    sp.set_defaults(fn=cmd_approve)
    sp = vid(sub.add_parser("kill"))
    sp.set_defaults(fn=cmd_kill)

    sp = vid(sub.add_parser("reroll", help="clear one scene's still/clip for regeneration"))
    sp.add_argument("n", type=int)
    sp.add_argument("--visual", help="new visual description")
    sp.add_argument("--narration", help="new narration (also regenerates VO)")
    sp.add_argument("--local-only", action="store_true")
    sp.set_defaults(fn=cmd_reroll)

    sp = vid(sub.add_parser("qc-flag", help="record a vision-QC result for a scene"))
    sp.add_argument("n", type=int)
    sp.add_argument("--rerolled", action="store_true")
    sp.add_argument("--flag", action="store_true")
    sp.add_argument("--reason")
    sp.set_defaults(fn=cmd_qc_flag)

    sp = vid(sub.add_parser("status"))
    sp.set_defaults(fn=cmd_status)
    return p


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
