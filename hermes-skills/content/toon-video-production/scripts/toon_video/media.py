"""FFmpeg/ffprobe wrappers: durations, Ken Burns clips, concat, audio mix,
caption burn, exports. Everything here is deterministic and free."""

import json
import shutil
import subprocess
from pathlib import Path

from . import config


def _bin(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise SystemExit(f"{name} not found on PATH — install ffmpeg (brew install ffmpeg)")
    return path


def run(cmd: list, quiet: bool = True) -> None:
    proc = subprocess.run(cmd, capture_output=quiet, text=True)
    if proc.returncode != 0:
        detail = (proc.stderr or "")[-2000:] if quiet else ""
        raise SystemExit(f"Command failed ({proc.returncode}): {' '.join(map(str, cmd))}\n{detail}")


def probe_duration(path) -> float:
    out = subprocess.run(
        [_bin("ffprobe"), "-v", "error", "-show_entries", "format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(json.loads(out.stdout)["format"]["duration"])


# --- Ken Burns -----------------------------------------------------------

# zoompan works in output frames; z/x/y are evaluated per frame ("on").
# Upscale the source first so subpixel pans don't shimmer.
_MAX_ZOOM = 1.12


def _zoompan_expr(camera: str, frames: int) -> str:
    z_in = f"min(1+{_MAX_ZOOM - 1:.4f}*on/{frames},{_MAX_ZOOM})"
    z_out = f"max({_MAX_ZOOM}-{_MAX_ZOOM - 1:.4f}*on/{frames},1)"
    center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
    if camera == "zoom-in":
        return f"z='{z_in}':{center}"
    if camera == "zoom-out":
        return f"z='{z_out}':{center}"
    if camera == "pan-left":
        return f"z={_MAX_ZOOM}:x='(iw-iw/zoom)*(1-on/{frames})':y='ih/2-(ih/zoom/2)'"
    if camera == "pan-right":
        return f"z={_MAX_ZOOM}:x='(iw-iw/zoom)*on/{frames}':y='ih/2-(ih/zoom/2)'"
    # static: hold a barely-perceptible 1.0 zoom so every scene goes through
    # the same filter path and encoder settings.
    return f"z=1:{center}"


def kenburns_clip(still: Path, out_path: Path, duration: float, camera: str, aspect: str) -> Path:
    w, h = config.RESOLUTIONS[aspect]
    frames = max(int(round(duration * config.FPS)), 1)
    vf = (
        f"scale={w * 2}:{h * 2}:force_original_aspect_ratio=increase,"
        f"crop={w * 2}:{h * 2},"
        f"zoompan={_zoompan_expr(camera, frames)}:d={frames}:s={w}x{h}:fps={config.FPS},"
        f"format=yuv420p"
    )
    run([
        _bin("ffmpeg"), "-y", "-loop", "1", "-i", str(still),
        "-vf", vf, "-frames:v", str(frames),
        "-c:v", "libx264", "-preset", "medium", "-crf", str(config.CRF),
        str(out_path),
    ])
    return out_path


def conform_clip(src: Path, out_path: Path, duration: float, aspect: str) -> Path:
    """Cut/scale an image-to-video hook clip to the scene slot and encoding params."""
    w, h = config.RESOLUTIONS[aspect]
    vf = (
        f"scale={w}:{h}:force_original_aspect_ratio=increase,"
        f"crop={w}:{h},fps={config.FPS},format=yuv420p"
    )
    run([
        _bin("ffmpeg"), "-y", "-i", str(src), "-t", f"{duration:.3f}",
        "-vf", vf, "-an",
        "-c:v", "libx264", "-preset", "medium", "-crf", str(config.CRF),
        str(out_path),
    ])
    return out_path


# --- Audio ---------------------------------------------------------------

def pad_vo(vo_mp3: Path, out_wav: Path, pad_sec: float) -> Path:
    """Normalize a scene VO to 48k stereo wav with trailing breathing room."""
    run([
        _bin("ffmpeg"), "-y", "-i", str(vo_mp3),
        "-af", f"apad=pad_dur={pad_sec}",
        "-ar", "48000", "-ac", "2", str(out_wav),
    ])
    return out_wav


def concat_wavs(wavs: list, out_wav: Path) -> Path:
    listfile = out_wav.with_suffix(".txt")
    listfile.write_text("".join(f"file '{Path(w).resolve()}'\n" for w in wavs))
    run([
        _bin("ffmpeg"), "-y", "-f", "concat", "-safe", "0", "-i", str(listfile),
        "-c", "copy", str(out_wav),
    ])
    return out_wav


def mix_music(vo_wav: Path, music: Path, out_wav: Path, total_sec: float) -> Path:
    """Music bed under narration: loop to length, duck by MUSIC_DUCK_DB,
    1s fade in/out, then mix against the full-level VO track."""
    fade_out_start = max(total_sec - config.MUSIC_FADE_SEC, 0)
    filt = (
        f"[1:a]aloop=loop=-1:size=2e9,atrim=0:{total_sec:.3f},"
        f"volume={config.MUSIC_DUCK_DB}dB,"
        f"afade=t=in:d={config.MUSIC_FADE_SEC},"
        f"afade=t=out:st={fade_out_start:.3f}:d={config.MUSIC_FADE_SEC}[bed];"
        f"[0:a][bed]amix=inputs=2:duration=first:normalize=0[mix]"
    )
    run([
        _bin("ffmpeg"), "-y", "-i", str(vo_wav), "-i", str(music),
        "-filter_complex", filt, "-map", "[mix]",
        "-ar", "48000", "-ac", "2", str(out_wav),
    ])
    return out_wav


# --- Final assembly ------------------------------------------------------

def concat_clips(clips: list, out_path: Path) -> Path:
    listfile = out_path.with_suffix(".concat.txt")
    listfile.write_text("".join(f"file '{Path(c).resolve()}'\n" for c in clips))
    run([
        _bin("ffmpeg"), "-y", "-f", "concat", "-safe", "0", "-i", str(listfile),
        "-c", "copy", str(out_path),
    ])
    return out_path


def _ass_filter_arg(ass_path: Path) -> str:
    # Escape for the subtitles filter's filename parser.
    p = str(ass_path.resolve()).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    d = str(config.FONTS_DIR.resolve()).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    return f"subtitles='{p}':fontsdir='{d}'"


def mux_and_burn(video: Path, audio: Path, ass_path, out_path: Path) -> Path:
    cmd = [_bin("ffmpeg"), "-y", "-i", str(video), "-i", str(audio)]
    if ass_path is not None:
        cmd += ["-vf", _ass_filter_arg(Path(ass_path))]
    cmd += [
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "medium", "-crf", str(config.CRF),
        "-c:a", "aac", "-b:a", config.AUDIO_BITRATE,
        "-movflags", "+faststart", "-shortest",
        str(out_path),
    ]
    run(cmd)
    return out_path


def thumbnail(video: Path, out_path: Path, at_sec: float = 0.5) -> Path:
    run([
        _bin("ffmpeg"), "-y", "-ss", f"{at_sec:.2f}", "-i", str(video),
        "-frames:v", "1", "-q:v", "3", str(out_path),
    ])
    return out_path
