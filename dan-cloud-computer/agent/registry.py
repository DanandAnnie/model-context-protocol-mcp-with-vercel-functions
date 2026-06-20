"""Local JSON registry for Dan Cloud Computers.

Stores one record per computer in data/computers.json. Intentionally simple
and local-first: no database, just a JSON file guarded by a lock so concurrent
API requests don't corrupt it.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# Resolve paths relative to the repo so the API can run from anywhere.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_THIS_DIR)

DATA_DIR = os.environ.get("DCC_DATA_DIR", os.path.join(_REPO_ROOT, "data"))
REGISTRY_PATH = os.path.join(DATA_DIR, "computers.json")
VOLUMES_DIR = os.path.join(DATA_DIR, "volumes")

_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_files() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(VOLUMES_DIR, exist_ok=True)
    if not os.path.exists(REGISTRY_PATH):
        with open(REGISTRY_PATH, "w") as fh:
            json.dump({"computers": []}, fh, indent=2)


def _read() -> Dict[str, Any]:
    _ensure_files()
    with open(REGISTRY_PATH) as fh:
        return json.load(fh)


def _write(data: Dict[str, Any]) -> None:
    _ensure_files()
    # Atomic write to avoid half-written JSON if the process dies mid-write.
    tmp = REGISTRY_PATH + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, REGISTRY_PATH)


def list_computers() -> List[Dict[str, Any]]:
    with _lock:
        return _read()["computers"]


def get_computer(name: str) -> Optional[Dict[str, Any]]:
    with _lock:
        for c in _read()["computers"]:
            if c["name"] == name:
                return c
    return None


def add_computer(record: Dict[str, Any]) -> Dict[str, Any]:
    record.setdefault("created_at", _now())
    record.setdefault("notes", "")
    with _lock:
        data = _read()
        if any(c["name"] == record["name"] for c in data["computers"]):
            raise ValueError(f"computer '{record['name']}' already exists")
        data["computers"].append(record)
        _write(data)
    return record


def update_computer(name: str, **fields: Any) -> Optional[Dict[str, Any]]:
    with _lock:
        data = _read()
        for c in data["computers"]:
            if c["name"] == name:
                c.update(fields)
                _write(data)
                return c
    return None


def remove_computer(name: str) -> bool:
    with _lock:
        data = _read()
        before = len(data["computers"])
        data["computers"] = [c for c in data["computers"] if c["name"] != name]
        changed = len(data["computers"]) != before
        if changed:
            _write(data)
        return changed


def used_ports() -> List[int]:
    return [c.get("host_port") for c in list_computers() if c.get("host_port")]
