"""Docker-backed cloud computer manager for Dan Cloud Computers.

One Docker container == one "computer". This module shells out to the local
`docker` CLI to spawn, control, and tear down containers. Desktop control
(screenshot / click / type / key) is performed with `docker exec` running
scrot and xdotool against the container's DISPLAY=:1.

Kept dependency-light on purpose (no docker SDK) so it stays transparent and
local-first.
"""

from __future__ import annotations

import base64
import os
import re
import shlex
import subprocess
from typing import Dict, List, Optional, Tuple

from . import registry

IMAGE = os.environ.get("DCC_IMAGE", "dan-cloud-computer/desktop:latest")
CONTAINER_PREFIX = "dcc_"
BASE_PORT = int(os.environ.get("DCC_BASE_PORT", "6080"))
DISPLAY = ":1"

# When the API runs inside a container that talks to the host docker daemon,
# bind-mount sources must be HOST paths. Override with DCC_HOST_DATA_DIR.
# Default: the same path the API sees (correct when running on the host).
HOST_DATA_DIR = os.environ.get("DCC_HOST_DATA_DIR", os.path.abspath(registry.DATA_DIR))


class ComputerError(RuntimeError):
    pass


def _run(cmd: List[str], timeout: int = 60) -> Tuple[int, str, str]:
    """Run a command, returning (rc, stdout, stderr)."""
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout.decode(errors="replace"), proc.stderr.decode(errors="replace")


def _container_name(name: str) -> str:
    return f"{CONTAINER_PREFIX}{name}"


def _valid_name(name: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,30}", name))


def _pick_port() -> int:
    used = set(registry.used_ports())
    port = BASE_PORT
    while port in used:
        port += 1
    return port


def _docker_state(container: str) -> Optional[str]:
    """Return the container's docker state ('running', 'exited', ...) or None."""
    rc, out, _ = _run(["docker", "inspect", "-f", "{{.State.Status}}", container])
    if rc != 0:
        return None
    return out.strip()


# --------------------------------------------------------------------------
# Lifecycle
# --------------------------------------------------------------------------
def spawn(name: str, notes: str = "") -> Dict:
    if not _valid_name(name):
        raise ComputerError(
            "name must be lowercase alphanumeric, '-' or '_', max 31 chars"
        )
    if registry.get_computer(name):
        raise ComputerError(f"computer '{name}' already exists")

    port = _pick_port()
    container = _container_name(name)

    # Per-computer persistent volume (browser profile, files).
    api_volume_path = os.path.join(registry.VOLUMES_DIR, name)
    os.makedirs(api_volume_path, exist_ok=True)
    host_volume_path = os.path.join(HOST_DATA_DIR, "volumes", name)

    cmd = [
        "docker", "run", "-d",
        "--name", container,
        "--shm-size=1g",
        "-p", f"{port}:6080",
        "-v", f"{host_volume_path}:/root/persist",
        "--label", "dan-cloud-computer=1",
        IMAGE,
    ]
    rc, out, err = _run(cmd, timeout=120)
    if rc != 0:
        raise ComputerError(f"docker run failed: {err.strip() or out.strip()}")

    container_id = out.strip()[:12]
    vnc_url = f"http://localhost:{port}/vnc.html?autoconnect=1&resize=scale"

    record = registry.add_computer({
        "name": name,
        "container_id": container_id,
        "container_name": container,
        "status": "running",
        "host_port": port,
        "vnc_url": vnc_url,
        "volume_path": api_volume_path,
        "notes": notes,
    })
    return record


def status(name: str) -> Dict:
    rec = registry.get_computer(name)
    if not rec:
        raise ComputerError(f"unknown computer '{name}'")
    # Reconcile registry status with the live docker state.
    state = _docker_state(rec["container_name"])
    if state is None:
        live = "destroyed"
    elif state == "running":
        live = "running"
    else:
        live = "stopped"
    if live != rec["status"]:
        rec = registry.update_computer(name, status=live) or rec
    return rec


def stop(name: str) -> Dict:
    rec = registry.get_computer(name)
    if not rec:
        raise ComputerError(f"unknown computer '{name}'")
    rc, _, err = _run(["docker", "stop", rec["container_name"]], timeout=60)
    if rc != 0 and "No such container" not in err:
        raise ComputerError(f"docker stop failed: {err.strip()}")
    return registry.update_computer(name, status="stopped") or rec


def start(name: str) -> Dict:
    """Start a previously stopped computer (keeps its volume + port)."""
    rec = registry.get_computer(name)
    if not rec:
        raise ComputerError(f"unknown computer '{name}'")
    rc, _, err = _run(["docker", "start", rec["container_name"]], timeout=60)
    if rc != 0:
        raise ComputerError(f"docker start failed: {err.strip()}")
    return registry.update_computer(name, status="running") or rec


def destroy(name: str) -> Dict:
    rec = registry.get_computer(name)
    if not rec:
        raise ComputerError(f"unknown computer '{name}'")
    # Remove the container; the volume directory is left on disk for safety.
    _run(["docker", "rm", "-f", rec["container_name"]], timeout=60)
    registry.remove_computer(name)
    return {"name": name, "status": "destroyed", "volume_path": rec.get("volume_path")}


def list_all() -> List[Dict]:
    return registry.list_computers()


# --------------------------------------------------------------------------
# Control primitives (run inside the container via docker exec)
# --------------------------------------------------------------------------
def _exec(name: str, args: List[str], timeout: int = 60, with_display: bool = True) -> Tuple[int, str, str]:
    rec = registry.get_computer(name)
    if not rec:
        raise ComputerError(f"unknown computer '{name}'")
    base = ["docker", "exec"]
    if with_display:
        base += ["-e", f"DISPLAY={DISPLAY}"]
    base.append(rec["container_name"])
    return _run(base + args, timeout=timeout)


def bash(name: str, command: str, timeout: int = 60) -> Dict:
    """Run a bash command inside the computer."""
    rc, out, err = _exec(
        name, ["bash", "-lc", command], timeout=timeout, with_display=True
    )
    return {"exit_code": rc, "stdout": out, "stderr": err}


def screenshot(name: str) -> str:
    """Capture the desktop and return a base64-encoded PNG."""
    # scrot writes to a temp file; we cat it out as base64 over the exec pipe.
    cmd = "scrot -o /tmp/dcc_shot.png >/dev/null 2>&1 && base64 -w0 /tmp/dcc_shot.png"
    rc, out, err = _exec(name, ["bash", "-lc", cmd], timeout=30)
    if rc != 0 or not out.strip():
        raise ComputerError(f"screenshot failed: {err.strip() or 'no output'}")
    # Validate it decodes.
    try:
        base64.b64decode(out.strip())
    except Exception as exc:  # noqa: BLE001
        raise ComputerError(f"screenshot not valid base64: {exc}")
    return out.strip()


def click(name: str, x: int, y: int, button: int = 1) -> Dict:
    rc, _, err = _exec(
        name, ["xdotool", "mousemove", str(x), str(y), "click", str(button)]
    )
    if rc != 0:
        raise ComputerError(f"click failed: {err.strip()}")
    return {"clicked": [x, y], "button": button}


def type_text(name: str, text: str) -> Dict:
    rc, _, err = _exec(name, ["xdotool", "type", "--delay", "20", "--", text])
    if rc != 0:
        raise ComputerError(f"type failed: {err.strip()}")
    return {"typed": text}


def press_key(name: str, key: str) -> Dict:
    """Press a key or chord, e.g. 'Return', 'ctrl+l', 'alt+Tab'."""
    rc, _, err = _exec(name, ["xdotool", "key", "--", key])
    if rc != 0:
        raise ComputerError(f"key failed: {err.strip()}")
    return {"key": key}


# --------------------------------------------------------------------------
# Hermes / MCP integration point
# --------------------------------------------------------------------------
# A future Hermes-style agent loop would call the primitives above
# (screenshot -> reason -> click/type/key) in a perception/action loop.
# The MCP server in ../mcp/server.py already exposes these as tools; an
# autonomous agent driver can be wired in here (e.g. an `act(goal)` method
# that repeatedly screenshots, asks a model for the next action, and applies
# it via click/type/press_key).
