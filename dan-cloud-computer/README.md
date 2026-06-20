# Dan Cloud Computers

A private, local-first **cloud computer** layer: spawn isolated Linux XFCE
desktop containers, view them in your browser over noVNC, and control them
(bash, screenshot, click, type, key) through a small API — built from scratch
and structured for future Hermes/MCP agent control.

> Internal MVP. No billing, auth tiers, teams, or marketplace. One shared
> internal API token guards everything. Built independently — it does **not**
> use any third-party proprietary code, UI, API, or branding.

---

## What you get

- **One container per computer** — Ubuntu + XFCE desktop, Google Chrome,
  noVNC browser access, and a persistent per-computer volume.
- **Control API (FastAPI)** — spawn / list / status / bash / screenshot /
  click / type / key / stop / destroy.
- **JSON registry** — `data/computers.json` (name, container_id, status,
  created_at, notes, vnc_url, volume_path, host_port).
- **Dashboard** — list, spawn, open desktop, stop/destroy, live status.
- **MCP-ready** — `mcp/server.py` exposes the control primitives as MCP tools.

```
dan-cloud-computer/
  docker/
    Dockerfile.desktop      # XFCE + noVNC + Chrome + xdotool/scrot
    Dockerfile.agent        # FastAPI control API container
    supervisord.conf        # runs Xvnc + xfce + novnc
    start-xfce.sh
    chrome-wrapper.sh
  agent/
    main.py                 # FastAPI app + auth + routes
    computer.py             # docker lifecycle + control primitives
    registry.py             # JSON registry
  dashboard/
    index.html / app.js / style.css
  mcp/
    server.py               # MCP tools (placeholder, functional)
  data/
    computers.json          # registry (seeded empty)
    volumes/<name>/         # per-computer persistent data (created at runtime)
  scripts/
    smoke-test.sh           # end-to-end verification
  docker-compose.yml
  requirements.txt
  .env.example
  README.md
```

---

## Prerequisites

- Docker (Engine + CLI) running locally
- Python 3.10+ (only if you run the API directly on the host)

---

## Setup

### 1. Build the desktop image (once)

```bash
cd dan-cloud-computer
docker compose build desktop
# (equivalent) docker build -t dan-cloud-computer/desktop:latest -f docker/Dockerfile.desktop docker
```

### 2. Configure the shared token

```bash
cp .env.example .env
# edit DCC_API_TOKEN to taste
export DCC_API_TOKEN=dev-secret-token
```

### 3. Start the control API

**Option A — directly on the host (simplest, recommended for dev):**

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DCC_API_TOKEN=dev-secret-token
uvicorn agent.main:app --reload --port 8000
```

**Option B — fully via Docker Compose:**

```bash
docker compose build desktop      # build the desktop image first
DCC_API_TOKEN=dev-secret-token docker compose up agent
```

The compose `agent` service mounts the Docker socket so it can spawn sibling
desktop containers, and passes `DCC_HOST_DATA_DIR` so per-computer volumes
bind-mount from the correct host path.

### 4. Open the dashboard

Visit **http://localhost:8000/**, paste your token into the token box, click
**Save token**, then spawn a computer.

---

## Using the API

All requests need the token header: `-H "X-API-Token: dev-secret-token"`
(or `Authorization: Bearer ...`). Interactive docs at
**http://localhost:8000/docs**.

| Action            | Method & path                          |
|-------------------|----------------------------------------|
| Spawn             | `POST /computers` `{"name","notes"}`   |
| List              | `GET /computers`                       |
| Status            | `GET /computers/{name}/status`         |
| Run bash          | `POST /computers/{name}/bash` `{"command"}` |
| Screenshot (PNG)  | `GET /computers/{name}/screenshot` → base64 |
| Click x/y         | `POST /computers/{name}/click` `{"x","y","button"}` |
| Type text         | `POST /computers/{name}/type` `{"text"}` |
| Press key         | `POST /computers/{name}/key` `{"key"}` |
| Stop              | `POST /computers/{name}/stop`          |
| Start (resume)    | `POST /computers/{name}/start`         |
| Destroy           | `DELETE /computers/{name}`             |

Open a desktop directly at the `vnc_url` returned by spawn, e.g.
`http://localhost:6080/vnc.html?autoconnect=1&resize=scale`.

---

## Verifying it works

Run the bundled end-to-end test (spawn → noVNC → whoami → screenshot →
click/type → stop → destroy):

```bash
DCC_API_TOKEN=dev-secret-token ./scripts/smoke-test.sh box1
```

Or step through manually:

```bash
TOKEN=dev-secret-token
H='-H X-API-Token:'"$TOKEN"' -H Content-Type:application/json'

# 1. spawn
curl -s $H -X POST localhost:8000/computers -d '{"name":"box1"}'

# 2. open noVNC in a browser (port from the spawn response, default 6080)
#    http://localhost:6080/vnc.html

# 3. whoami
curl -s $H -X POST localhost:8000/computers/box1/bash -d '{"command":"whoami"}'

# 4. screenshot (base64 PNG)
curl -s $H localhost:8000/computers/box1/screenshot

# 5. click + type on the desktop
curl -s $H -X POST localhost:8000/computers/box1/click -d '{"x":640,"y":400}'
curl -s $H -X POST localhost:8000/computers/box1/type  -d '{"text":"hello"}'
curl -s $H -X POST localhost:8000/computers/box1/key   -d '{"key":"Return"}'

# 6. stop + destroy
curl -s $H -X POST localhost:8000/computers/box1/stop
curl -s $H -X DELETE localhost:8000/computers/box1
```

---

## MCP server (agent-ready)

`mcp/server.py` exposes the control primitives as MCP tools:
`computer_spawn`, `computer_bash`, `computer_screenshot`, `computer_click`,
`computer_type`, `computer_key`, `computer_status`, `computer_destroy`.

```bash
pip install "mcp[cli]" httpx
export DCC_API_URL=http://localhost:8000
export DCC_API_TOKEN=dev-secret-token
python mcp/server.py        # stdio transport for an MCP client
```

### Where future Hermes/MCP control connects

- `agent/computer.py` — control primitives (`screenshot`, `click`,
  `type_text`, `press_key`) are the perception/action surface. Add an
  `act(goal)` perceive→reason→act loop here.
- `mcp/server.py` — add a `computer_act(name, goal)` tool that screenshots,
  asks a vision model for the next action, and applies it via the existing
  click/type/key tools.

---

## How it works

- Each computer is a Docker container named `dcc_<name>`. Inside,
  `supervisord` runs **Xtigervnc** (display `:1`), the **XFCE** session, and
  **noVNC/websockify** (port 6080, mapped to a unique host port per computer).
- The API drives desktops from the host via `docker exec`: `scrot` for
  screenshots and `xdotool` for click/type/key against `DISPLAY=:1`.
- Browser sessions/files persist in `data/volumes/<name>` (bind-mounted to
  `/root/persist`; Chrome's profile lives there too).

## Notes & limits

- Chrome runs with `--no-sandbox` (required in a container) — fine for an
  internal sandbox, not for untrusted multi-tenant use.
- Ports are handed out starting at `DCC_BASE_PORT` (6080), one per computer.
- `destroy` removes the container but leaves the volume directory on disk so
  you don't lose data by accident; delete `data/volumes/<name>` manually to
  reclaim space.
