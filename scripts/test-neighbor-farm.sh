#!/usr/bin/env bash
# Inline tests for POST /api/neighbor-farm
# Usage: bash scripts/test-neighbor-farm.sh [base_url]
# Defaults to localhost:3100 (vercel dev --listen 3100)

set -euo pipefail

BASE="${1:-http://localhost:3100}"
TOKEN="${MISSION_CONTROL_TOKEN:-$(cat ~/.secrets/mission-control-token 2>/dev/null || echo '')}"
PASS=0; FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $name"
    ((PASS++))
  else
    echo "  ✗ $name — expected $expected, got $actual"
    ((FAIL++))
  fi
}

echo "=== neighbor-farm tests against $BASE ==="
echo ""

# ── Test 1: 401 without bearer token ────────────────────────────────────────
echo "1. No auth → 401"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE/api/neighbor-farm" \
  -H "Content-Type: application/json" \
  -d '{"address":"123 Test St"}')
check "no-auth returns 401" "401" "$STATUS"

# ── Test 2: 400 missing address ──────────────────────────────────────────────
echo "2. Missing address → 400"
RESP=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE/api/neighbor-farm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Jordan"}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -1)
check "missing-address returns 400" "400" "$STATUS"
check "error message present" "1" "$(echo "$BODY" | grep -c '"error"' || true)"

# ── Test 3: 201 happy path ───────────────────────────────────────────────────
echo "3. Valid payload → 201"
RESP=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE/api/neighbor-farm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "address":"3239 South 840 East, St. George, UT 84790",
    "firstName":"Jordan",
    "lastName":"Barlow",
    "opportunityId":"sMzDiYUNaFO0F1NcKIdl",
    "triggerSource":"test-script"
  }')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -1)
check "good payload returns 201" "201" "$STATUS"
check "listName present" "1" "$(echo "$BODY" | grep -c '"listName"' || true)"
check "scheduledReminderAt present" "1" "$(echo "$BODY" | grep -c '"scheduledReminderAt"' || true)"
check "phase2 message present" "1" "$(echo "$BODY" | grep -c 'Phase 2' || true)"
echo "  Response: $BODY"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
