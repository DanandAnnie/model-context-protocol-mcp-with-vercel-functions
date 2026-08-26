"""Step 3 — Character sheets: cached once per (slug, style), reused across
videos. Generation itself happens in Claude via Higgsfield/FAL; this module
owns the cache, the Supabase record, and the prompt text."""

from pathlib import Path

import requests

from . import config, supabase_io


def cache_dir(slug: str, style: str) -> Path:
    d = config.CHAR_CACHE / slug
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_path(slug: str, style: str) -> Path:
    return cache_dir(slug, style) / f"{style}.png"


def sheet_prompt(description: str, style: str) -> str:
    token = config.STYLE_TOKENS[style]
    return (
        f"character reference sheet, single character, front view, neutral "
        f"standing pose, full body, plain solid light background, even "
        f"lighting. Character: {description}. Art style: {token}. "
        f"{config.CONSISTENCY_SUFFIX}"
    )


def lookup(slug: str, style: str):
    """Local cache first, then Supabase (re-hydrating the cache). Returns
    {'path': Path|None, 'url': str|None} — both None means generate."""
    local = cache_path(slug, style)
    if local.exists():
        row = supabase_io.get_character(slug, style)
        return {"path": local, "url": (row or {}).get("reference_image_url")}
    row = supabase_io.get_character(slug, style)
    if row and row.get("reference_image_url"):
        url = supabase_io.signed_url(
            config.BUCKET_CHARACTERS, f"{slug}/{style}.png"
        )
        resp = requests.get(url, timeout=120)
        if resp.status_code == 200:
            local.write_bytes(resp.content)
            return {"path": local, "url": row["reference_image_url"]}
    return {"path": None, "url": None}


def register(slug: str, style: str, description: str, image: Path) -> dict:
    """Store a freshly generated sheet: local cache + bucket + table row."""
    local = cache_path(slug, style)
    if Path(image).resolve() != local.resolve():
        local.write_bytes(Path(image).read_bytes())
    uri = supabase_io.upload(config.BUCKET_CHARACTERS, f"{slug}/{style}.png", local)
    supabase_io.upsert_character(slug, style, description, uri)
    return {"path": local, "url": uri}
