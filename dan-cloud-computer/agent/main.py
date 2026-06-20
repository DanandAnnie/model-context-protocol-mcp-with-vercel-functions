"""Dan Cloud Computers - FastAPI control API.

A single internal shared token guards every endpoint (header:
`X-API-Token: <token>` or `Authorization: Bearer <token>`). This is an
internal MVP, not a multi-tenant SaaS: no users, teams, or billing.

Run locally:
    export DCC_API_TOKEN=dev-secret-token
    uvicorn agent.main:app --reload --port 8000
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import computer, registry

API_TOKEN = os.environ.get("DCC_API_TOKEN", "dev-secret-token")

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_THIS_DIR)
DASHBOARD_DIR = os.path.join(_REPO_ROOT, "dashboard")

app = FastAPI(title="Dan Cloud Computers", version="0.1.0")


# ---- Auth ---------------------------------------------------------------
def require_token(
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> None:
    token = x_api_token
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:]
    if token != API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing API token")


# ---- Request models -----------------------------------------------------
class SpawnRequest(BaseModel):
    name: str = Field(..., description="lowercase id, e.g. 'box1'")
    notes: str = ""


class BashRequest(BaseModel):
    command: str
    timeout: int = 60


class ClickRequest(BaseModel):
    x: int
    y: int
    button: int = 1


class TypeRequest(BaseModel):
    text: str


class KeyRequest(BaseModel):
    key: str


# ---- Health + meta ------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True, "service": "dan-cloud-computer"}


# ---- Computer lifecycle -------------------------------------------------
@app.get("/computers", dependencies=[Depends(require_token)])
def list_computers():
    return {"computers": computer.list_all()}


@app.post("/computers", dependencies=[Depends(require_token)])
def spawn(req: SpawnRequest):
    try:
        return computer.spawn(req.name, req.notes)
    except computer.ComputerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/computers/{name}/status", dependencies=[Depends(require_token)])
def get_status(name: str):
    try:
        return computer.status(name)
    except computer.ComputerError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/computers/{name}/stop", dependencies=[Depends(require_token)])
def stop(name: str):
    try:
        return computer.stop(name)
    except computer.ComputerError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/computers/{name}/start", dependencies=[Depends(require_token)])
def start(name: str):
    try:
        return computer.start(name)
    except computer.ComputerError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/computers/{name}", dependencies=[Depends(require_token)])
def destroy(name: str):
    try:
        return computer.destroy(name)
    except computer.ComputerError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ---- Control primitives -------------------------------------------------
@app.post("/computers/{name}/bash", dependencies=[Depends(require_token)])
def bash(name: str, req: BashRequest):
    try:
        return computer.bash(name, req.command, req.timeout)
    except computer.ComputerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/computers/{name}/screenshot", dependencies=[Depends(require_token)])
def screenshot(name: str):
    try:
        b64 = computer.screenshot(name)
        return {"name": name, "format": "png", "base64": b64}
    except computer.ComputerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/computers/{name}/click", dependencies=[Depends(require_token)])
def click(name: str, req: ClickRequest):
    try:
        return computer.click(name, req.x, req.y, req.button)
    except computer.ComputerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/computers/{name}/type", dependencies=[Depends(require_token)])
def type_text(name: str, req: TypeRequest):
    try:
        return computer.type_text(name, req.text)
    except computer.ComputerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/computers/{name}/key", dependencies=[Depends(require_token)])
def press_key(name: str, req: KeyRequest):
    try:
        return computer.press_key(name, req.key)
    except computer.ComputerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---- Dashboard (static) -------------------------------------------------
# Served at /dashboard so the API routes above stay clean. The dashboard JS
# asks for the shared token in the browser and stores it in localStorage.
if os.path.isdir(DASHBOARD_DIR):
    app.mount("/dashboard", StaticFiles(directory=DASHBOARD_DIR, html=True), name="dashboard")


@app.get("/")
def root():
    index = os.path.join(DASHBOARD_DIR, "index.html")
    if os.path.exists(index):
        return FileResponse(index)
    return JSONResponse({"service": "dan-cloud-computer", "dashboard": "/dashboard"})
