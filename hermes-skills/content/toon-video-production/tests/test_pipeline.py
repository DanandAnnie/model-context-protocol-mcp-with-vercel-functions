"""Offline tests for the deterministic pipeline half. Run with
`python3 -m unittest discover tests` from the skill root (or pytest).
The assembly smoke test auto-skips when ffmpeg is not installed."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="toon-test-")
os.environ["TOON_WORK_DIR"] = str(Path(_TMP) / "work")
os.environ["TOON_CHAR_CACHE"] = str(Path(_TMP) / "chars")
os.environ["HERMES_SPEND_LOG"] = str(Path(_TMP) / "spend.jsonl")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from toon_video import captions, config, costs, state, vo  # noqa: E402


def sample_plan(n_scenes: int = 8, target: int = 60) -> dict:
    return {
        "video_id": str(uuid.uuid4()),
        "title": "First-Time Buyer Explainer",
        "style": "classic-cartoon",
        "target_length_sec": target,
        "aspect": "9:16",
        "characters": [
            {"slug": "bee-agent", "description": "friendly cartoon bee realtor", "reference_image_url": None}
        ],
        "music_mood": "upbeat-light",
        "hook_video": False,
        "scenes": [
            {
                "n": i,
                "narration": f"Narration for scene {i}, short and punchy.",
                "visual": f"Scene {i} visual description",
                "characters": ["bee-agent"] if i % 2 else [],
                "camera": ["zoom-in", "zoom-out", "pan-left", "pan-right", "static"][i % 5],
                "is_hook": i == 1,
                "duration_sec": None,
                "assets": {"vo": None, "still": None, "clip": None},
            }
            for i in range(1, n_scenes + 1)
        ],
    }


class TestValidation(unittest.TestCase):
    def test_valid_plan(self):
        self.assertEqual(state.validate(sample_plan()), [])

    def test_bad_camera(self):
        plan = sample_plan()
        plan["scenes"][2]["camera"] = "dolly"
        self.assertTrue(any("camera" in p for p in state.validate(plan)))

    def test_hook_must_be_scene_one(self):
        plan = sample_plan()
        plan["scenes"][0]["is_hook"] = False
        plan["scenes"][3]["is_hook"] = True
        self.assertTrue(any("hook" in p for p in state.validate(plan)))

    def test_undeclared_character(self):
        plan = sample_plan()
        plan["scenes"][0]["characters"] = ["ghost"]
        self.assertTrue(any("undeclared" in p for p in state.validate(plan)))

    def test_scene_count_for_target(self):
        plan = sample_plan(n_scenes=7, target=60)  # below the 8-12 window
        self.assertTrue(any("scene count" in p for p in state.validate(plan)))

    def test_bad_style(self):
        plan = sample_plan()
        plan["style"] = "anime"
        self.assertTrue(state.validate(plan))


class TestState(unittest.TestCase):
    def test_save_load_and_asset_roundtrip(self):
        plan = sample_plan()
        state.save(plan)
        loaded = state.load(plan["video_id"])
        self.assertEqual(loaded["title"], plan["title"])

        # Non-existent path is treated as absent (resume-safe).
        state.set_scene_asset(loaded, 1, "still", "/nonexistent/x.png")
        self.assertIsNone(state.scene_asset(loaded, 1, "still"))

        real = config.work_dir(plan["video_id"]) / "s1.png"
        real.write_bytes(b"png")
        state.set_scene_asset(loaded, 1, "still", real)
        self.assertEqual(state.scene_asset(loaded, 1, "still"), real)

    def test_invalidate_clips(self):
        plan = sample_plan()
        state.save(plan)
        wd = config.work_dir(plan["video_id"])
        (wd / "clips").mkdir(exist_ok=True)
        (wd / "clips_16x9").mkdir(exist_ok=True)
        tracked = wd / "clips" / "scene_01.mp4"
        secondary = wd / "clips_16x9" / "scene_01.mp4"
        raw = wd / "clips" / "scene_01.raw.mp4"
        for f in (tracked, secondary, raw):
            f.write_bytes(b"mp4")
        state.set_scene_asset(plan, 1, "clip", tracked)
        state.set_scene_asset(plan, 1, "clip_source", "hook-raw")

        # Duration-only change: clips cleared, raw hook footage kept for re-cut.
        state.invalidate_clips(plan, 1)
        self.assertIsNone(state.scene_asset(plan, 1, "clip"))
        self.assertIsNone(plan["scenes"][0]["assets"]["clip_source"])
        self.assertFalse(secondary.exists())
        self.assertTrue(raw.exists())

        # Visual change: raw footage goes too.
        state.invalidate_clips(plan, 1, drop_hook_raw=True)
        self.assertFalse(raw.exists())

    def test_slot_starts(self):
        plan = sample_plan(n_scenes=8)
        for s in plan["scenes"]:
            s["duration_sec"] = 2.0
        starts = state.scene_slot_starts(plan)
        self.assertEqual(starts[1], 0.0)
        self.assertAlmostEqual(starts[2], 2.0 + config.SCENE_PAD_SEC)
        self.assertAlmostEqual(state.total_vo_runtime(plan), 16.0)


class TestVO(unittest.TestCase):
    def test_chars_to_words(self):
        alignment = {
            "characters": list("hi there"),
            "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
            "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        }
        words = vo.chars_to_words(alignment)
        self.assertEqual([w["word"] for w in words], ["hi", "there"])
        self.assertEqual(words[0]["start"], 0.0)
        self.assertEqual(words[0]["end"], 0.2)
        self.assertEqual(words[1]["start"], 0.3)

    def test_runtime_check_flags_overage(self):
        plan = sample_plan(n_scenes=8, target=60)
        for s in plan["scenes"]:
            s["duration_sec"] = 10.0  # 80s VO + padding >> 60s target
        report = vo.runtime_check(plan)
        self.assertTrue(report["over_budget"])
        self.assertTrue(report["trim_candidates"])

    def test_runtime_check_ok(self):
        plan = sample_plan(n_scenes=8, target=60)
        for s in plan["scenes"]:
            s["duration_sec"] = 6.0  # 48s + 3.2s padding, within 15%
        self.assertFalse(vo.runtime_check(plan)["over_budget"])


class TestCaptions(unittest.TestCase):
    def test_event_grouping_and_timestamps(self):
        words = [
            {"word": f"w{i}", "start": i * 0.3, "end": i * 0.3 + 0.2} for i in range(6)
        ]
        events = captions._events_for_scene(words, offset=10.0)
        self.assertEqual(len(events), 2)  # 4-word max per line
        self.assertEqual(events[0]["text"], "w0 w1 w2 w3")
        self.assertAlmostEqual(events[0]["start"], 10.0)
        self.assertEqual(captions._ts(3661.5), "1:01:01.50")

    def test_gap_starts_new_event(self):
        words = [
            {"word": "a", "start": 0.0, "end": 0.2},
            {"word": "b", "start": 2.0, "end": 2.2},  # >MAX_GAP_SEC pause
        ]
        self.assertEqual(len(captions._events_for_scene(words, 0.0)), 2)

    ASS_HEADER = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Toon,DejaVu Sans,72,&H00FFFFFF,6,2,2,60,60,320,1"
    )

    def test_playres_follows_aspect_and_scales_style(self):
        fitted = captions._fit_playres(self.ASS_HEADER, "16:9")
        self.assertIn("PlayResX: 1920", fitted)
        self.assertIn("PlayResY: 1080", fitted)
        # Pixel-denominated style values scale with the script space:
        # heights by 1080/1920, horizontal margins by 1920/1080.
        self.assertIn("Style: Toon,DejaVu Sans,40,&H00FFFFFF,3,1,2,107,107,180,1", fitted)
        # Matching aspect leaves the template untouched.
        self.assertEqual(captions._fit_playres(self.ASS_HEADER, "9:16"), self.ASS_HEADER)

    def test_playres_injected_when_missing(self):
        bare = "[Script Info]\nScriptType: v4.00+"
        fitted = captions._fit_playres(bare, "16:9")
        self.assertIn("PlayResX: 1920", fitted)
        self.assertIn("PlayResY: 1080", fitted)

    def test_build_ass_from_plan(self):
        plan = sample_plan()
        wd = config.work_dir(plan["video_id"])
        for s in plan["scenes"]:
            s["duration_sec"] = 2.0
            wf = wd / f"words_{s['n']}.json"
            wf.write_text(json.dumps([{"word": "hello", "start": 0.1, "end": 0.5}]))
            s["assets"]["words"] = str(wf)
        state.save(plan)
        out = captions.build_ass(plan["video_id"])
        text = out.read_text()
        self.assertIn("[Events]", text)
        self.assertEqual(text.count("Dialogue:"), len(plan["scenes"]))


class TestCosts(unittest.TestCase):
    def test_estimate_math(self):
        plan = sample_plan(n_scenes=10)
        est = costs.estimate(plan)
        # 10 stills + 1 uncached character sheet
        self.assertEqual(est["images"], 11)
        self.assertAlmostEqual(est["breakdown_usd"]["stills"], 11 * config.COST_PER_IMAGE)
        self.assertFalse(est["hook_video"])
        self.assertEqual(est["breakdown_usd"]["hook_clip"], 0.0)
        # stills-only 60s explainer must clear the $3 gate with defaults
        self.assertFalse(est["over_video_gate"])

    def test_gate_blocks_without_confirm(self):
        est = {"over_video_gate": True, "over_hook_gate": False, "total_usd": 9.9,
               "video_gate_usd": 3.0, "hook_credits": 0, "hook_gate_credits": 300}
        with self.assertRaises(SystemExit):
            costs.enforce_gates(est, confirmed=False)
        costs.enforce_gates(est, confirmed=True)  # no raise

    def test_spend_log_roundtrip(self):
        vid = str(uuid.uuid4())
        costs.log_spend(vid, "vo", "elevenlabs", 1000, 0.15, "test")
        costs.log_spend(vid, "stills", "higgsfield", 8, 0.56, "test")
        self.assertAlmostEqual(costs.actual_spend(vid), 0.71)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg not installed")
class TestAssemblySmoke(unittest.TestCase):
    """Build a 2-scene video from placeholder stills and silent VO —
    the spec's 'test with placeholder stills first' step."""

    def test_end_to_end_placeholder(self):
        from toon_video import media

        plan = sample_plan(n_scenes=8)
        plan = {**plan, "scenes": plan["scenes"][:2]}
        wd = config.work_dir(plan["video_id"])
        clips, wavs = [], []
        for s in plan["scenes"]:
            n = s["n"]
            s["duration_sec"] = 1.5
            still = wd / f"still_{n}.png"
            subprocess.run(
                ["ffmpeg", "-y", "-f", "lavfi", "-i",
                 f"color=c={'red' if n == 1 else 'blue'}:s=540x960", "-frames:v", "1", str(still)],
                check=True, capture_output=True,
            )
            voice = wd / f"vo_{n}.mp3"
            subprocess.run(
                ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
                 "-b:a", "128k", str(voice)],
                check=True, capture_output=True,
            )
            clips.append(media.kenburns_clip(still, wd / f"clip_{n}.mp4",
                                             1.5 + config.SCENE_PAD_SEC, s["camera"], "9:16"))
            wavs.append(media.pad_vo(voice, wd / f"vo_{n}.wav", config.SCENE_PAD_SEC))

        silent = media.concat_clips(clips, wd / "video_silent.mp4")
        vo_track = media.concat_wavs(wavs, wd / "vo_track.wav")
        final = media.mux_and_burn(silent, vo_track, None, wd / "final.mp4")

        dur = media.probe_duration(final)
        expected = 2 * (1.5 + config.SCENE_PAD_SEC)
        self.assertAlmostEqual(dur, expected, delta=0.35)
        thumb = media.thumbnail(final, wd / "thumb.jpg")
        self.assertTrue(thumb.exists())

        # Secondary 16:9 pass from the same stills (the --also-horizontal path).
        from toon_video.cli import _secondary_clips

        state.save(plan)
        loaded = state.load(plan["video_id"])
        for s in loaded["scenes"]:
            state.set_scene_asset(loaded, s["n"], "still", wd / f"still_{s['n']}.png")
        state.save(loaded)
        clips2 = _secondary_clips(loaded, wd, "16:9")
        self.assertEqual(len(clips2), 2)
        silent2 = media.concat_clips(clips2, wd / "video_silent_16x9.mp4")
        final2 = media.mux_and_burn(silent2, vo_track, None, wd / "final_16x9.mp4")
        self.assertAlmostEqual(media.probe_duration(final2), expected, delta=0.35)


if __name__ == "__main__":
    unittest.main()
