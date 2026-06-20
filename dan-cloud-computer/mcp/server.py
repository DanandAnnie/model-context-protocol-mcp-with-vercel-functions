"""Dan Cloud Computers - MCP server (placeholder, but functional).

Exposes the cloud-computer control primitives as MCP tools so a future
Hermes/MCP agent can drive desktops the same way the dashboard does. Each
tool is a thin wrapper around the FastAPI control API.

This is intentionally a placeholder scaffold: the tool surface is final, but
an autonomous agent loop (perceive -> reason -> act) is left as the future
Hermes integration point (see TODOs below and agent/computer.py).

Run (stdio transport, e.g. from an MCP client like Claude Desktop):
    pip install "mcp[cli]" httpx
    export DCC_API_URL=http://localhost:8000
    export DCC_API_TOKEN=dev-secret-token
    python mcp/server.py
"""

from __future__ import annotations

import os

import httpx

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "The 'mcp' package is required. Install with: pip install 'mcp[cli]' httpx"
    ) from exc

API_URL = os.environ.get("DCC_API_URL", "http://localhost:8000")
API_TOKEN = os.environ.get("DCC_API_TOKEN", "dev-secret-token")

mcp = FastMCP("dan-cloud-computer")


def _headers() -> dict:
    return {"X-API-Token": API_TOKEN}


def _client() -> httpx.Client:
    return httpx.Client(base_url=API_URL, headers=_headers(), timeout=120)


# --------------------------------------------------------------------------
# Tools (names match the MVP spec)
# --------------------------------------------------------------------------
@mcp.tool()
def computer_spawn(name: str, notes: str = "") -> dict:
    """Spawn a new cloud computer (Linux XFCE desktop container)."""
    with _client() as c:
        r = c.post("/computers", json={"name": name, "notes": notes})
        r.raise_for_status()
        return r.json()


@mcp.tool()
def computer_status(name: str) -> dict:
    """Get the live status of a computer."""
    with _client() as c:
        r = c.get(f"/computers/{name}/status")
        r.raise_for_status()
        return r.json()


@mcp.tool()
def computer_bash(name: str, command: str, timeout: int = 60) -> dict:
    """Run a bash command inside a computer and return stdout/stderr/exit_code."""
    with _client() as c:
        r = c.post(f"/computers/{name}/bash", json={"command": command, "timeout": timeout})
        r.raise_for_status()
        return r.json()


@mcp.tool()
def computer_screenshot(name: str) -> dict:
    """Take a screenshot of the desktop. Returns a base64-encoded PNG."""
    with _client() as c:
        r = c.get(f"/computers/{name}/screenshot")
        r.raise_for_status()
        return r.json()


@mcp.tool()
def computer_click(name: str, x: int, y: int, button: int = 1) -> dict:
    """Click at pixel coordinate (x, y). button: 1=left, 2=middle, 3=right."""
    with _client() as c:
        r = c.post(f"/computers/{name}/click", json={"x": x, "y": y, "button": button})
        r.raise_for_status()
        return r.json()


@mcp.tool()
def computer_type(name: str, text: str) -> dict:
    """Type text into the currently focused element."""
    with _client() as c:
        r = c.post(f"/computers/{name}/type", json={"text": text})
        r.raise_for_status()
        return r.json()


@mcp.tool()
def computer_key(name: str, key: str) -> dict:
    """Press a key or chord, e.g. 'Return', 'ctrl+l', 'alt+Tab'."""
    with _client() as c:
        r = c.post(f"/computers/{name}/key", json={"key": key})
        r.raise_for_status()
        return r.json()


@mcp.tool()
def computer_destroy(name: str) -> dict:
    """Destroy a computer (removes its container)."""
    with _client() as c:
        r = c.delete(f"/computers/{name}")
        r.raise_for_status()
        return r.json()


# --------------------------------------------------------------------------
# Future Hermes integration point
# --------------------------------------------------------------------------
# TODO(hermes): add an autonomous `computer_act(name, goal)` tool that runs a
# perceive->reason->act loop: call computer_screenshot, send the image + goal
# to a vision-capable model, parse the next action, and apply it via
# computer_click / computer_type / computer_key until the goal is met.

if __name__ == "__main__":
    mcp.run()  # stdio transport by default
