"""Supabase REST IO (service role): storage upload/sign + job/character rows.

SHARED-CANDIDATE: faceless-video-production has a Supabase upload step —
unify on the Mac Mini into ~/.hermes/skills/content/_shared/supabase_io.py.
"""

import json
import mimetypes
from pathlib import Path

import requests

from . import config


def _headers(extra=None) -> dict:
    key = config.require(config.SUPABASE_SERVICE_KEY, "SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": f"Bearer {key}"}
    if extra:
        h.update(extra)
    return h


def upload(bucket: str, object_path: str, file_path: Path) -> str:
    """Upsert a file into a storage bucket; returns the storage URI."""
    ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    url = f"{config.SUPABASE_URL}/storage/v1/object/{bucket}/{object_path}"
    with open(file_path, "rb") as f:
        resp = requests.post(
            url,
            headers=_headers({"Content-Type": ctype, "x-upsert": "true"}),
            data=f,
            timeout=600,
        )
    if resp.status_code not in (200, 201):
        raise SystemExit(f"Storage upload failed {resp.status_code}: {resp.text[:500]}")
    return f"supabase://{bucket}/{object_path}"


def signed_url(bucket: str, object_path: str, ttl_sec: int = None) -> str:
    url = f"{config.SUPABASE_URL}/storage/v1/object/sign/{bucket}/{object_path}"
    resp = requests.post(
        url,
        headers=_headers({"Content-Type": "application/json"}),
        json={"expiresIn": ttl_sec or config.SIGNED_URL_TTL_SEC},
        timeout=60,
    )
    if resp.status_code != 200:
        raise SystemExit(f"Sign failed {resp.status_code}: {resp.text[:500]}")
    return config.SUPABASE_URL + "/storage/v1" + resp.json()["signedURL"]


def _rest(table: str) -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{table}"


def upsert_job(plan: dict, status: str, **fields) -> None:
    row = {
        "video_id": plan["video_id"],
        "title": plan["title"],
        "style": plan["style"],
        "status": status,
        "scene_plan": plan,
    }
    row.update(fields)
    resp = requests.post(
        _rest("toon_video_jobs") + "?on_conflict=video_id",
        headers=_headers({
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }),
        data=json.dumps(row),
        timeout=60,
    )
    if resp.status_code not in (200, 201, 204):
        raise SystemExit(f"Job upsert failed {resp.status_code}: {resp.text[:500]}")


def set_job_status(video_id: str, status: str, **fields) -> None:
    patch = {"status": status}
    patch.update(fields)
    resp = requests.patch(
        _rest("toon_video_jobs") + f"?video_id=eq.{video_id}",
        headers=_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        data=json.dumps(patch),
        timeout=60,
    )
    if resp.status_code not in (200, 204):
        raise SystemExit(f"Job update failed {resp.status_code}: {resp.text[:500]}")


def get_job(video_id: str):
    resp = requests.get(
        _rest("toon_video_jobs") + f"?video_id=eq.{video_id}&limit=1",
        headers=_headers(),
        timeout=60,
    )
    if resp.status_code != 200:
        raise SystemExit(f"Job fetch failed {resp.status_code}: {resp.text[:500]}")
    rows = resp.json()
    return rows[0] if rows else None


def upsert_character(slug: str, style: str, description: str, reference_image_url: str) -> None:
    resp = requests.post(
        _rest("toon_characters") + "?on_conflict=slug,style",
        headers=_headers({
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }),
        data=json.dumps({
            "slug": slug,
            "style": style,
            "description": description,
            "reference_image_url": reference_image_url,
        }),
        timeout=60,
    )
    if resp.status_code not in (200, 201, 204):
        raise SystemExit(f"Character upsert failed {resp.status_code}: {resp.text[:500]}")


def get_character(slug: str, style: str):
    resp = requests.get(
        _rest("toon_characters") + f"?slug=eq.{slug}&style=eq.{style}&limit=1",
        headers=_headers(),
        timeout=60,
    )
    if resp.status_code != 200:
        raise SystemExit(f"Character fetch failed {resp.status_code}: {resp.text[:500]}")
    rows = resp.json()
    return rows[0] if rows else None
