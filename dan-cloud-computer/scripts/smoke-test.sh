#!/usr/bin/env bash
# Dan Cloud Computers - end-to-end smoke test.
# Verifies: spawn -> noVNC reachable -> whoami -> screenshot -> click/type -> stop -> destroy.
#
# Usage:
#   DCC_API_TOKEN=dev-secret-token ./scripts/smoke-test.sh [name]
set -euo pipefail

API="${DCC_API_URL:-http://localhost:8000}"
TOKEN="${DCC_API_TOKEN:-dev-secret-token}"
NAME="${1:-smoke1}"
H=(-H "X-API-Token: ${TOKEN}" -H "Content-Type: application/json")

say() { printf "\n=== %s ===\n" "$1"; }

say "1. Spawn computer '${NAME}'"
curl -fsS "${H[@]}" -X POST "${API}/computers" -d "{\"name\":\"${NAME}\",\"notes\":\"smoke test\"}" | tee /tmp/dcc_spawn.json
PORT=$(python3 -c "import json;print(json.load(open('/tmp/dcc_spawn.json'))['host_port'])")

say "2. Wait for desktop to boot, then check noVNC on port ${PORT}"
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/vnc.html" -o /dev/null; then
    echo "noVNC is reachable: http://localhost:${PORT}/vnc.html"
    break
  fi
  sleep 1
done

say "3. Run whoami inside the computer"
curl -fsS "${H[@]}" -X POST "${API}/computers/${NAME}/bash" -d '{"command":"whoami && uname -a"}'

say "4. Take a screenshot (base64 length shown)"
curl -fsS "${H[@]}" "${API}/computers/${NAME}/screenshot" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('png base64 bytes:',len(d['base64']))"

say "5. Click + type into the desktop (opens a terminal via keyboard)"
curl -fsS "${H[@]}" -X POST "${API}/computers/${NAME}/click" -d '{"x":640,"y":400}'
curl -fsS "${H[@]}" -X POST "${API}/computers/${NAME}/type" -d '{"text":"echo hello from dan cloud"}'
curl -fsS "${H[@]}" -X POST "${API}/computers/${NAME}/key" -d '{"key":"Return"}'

say "6. Status"
curl -fsS "${H[@]}" "${API}/computers/${NAME}/status"

say "7. Stop computer"
curl -fsS "${H[@]}" -X POST "${API}/computers/${NAME}/stop"

say "8. Destroy computer"
curl -fsS "${H[@]}" -X DELETE "${API}/computers/${NAME}"

say "Smoke test complete."
