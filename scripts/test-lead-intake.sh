#!/usr/bin/env bash
# Inline tests for POST /api/lead (speed-to-lead intake).
# Usage: bash scripts/test-lead-intake.sh [base_url]
# Defaults to localhost:3100 (vercel dev --listen 3100)
#
# Auth: uses MISSION_CONTROL_TOKEN as a bearer if set, otherwise
# LEAD_WEBHOOK_SECRET via the x-webhook-secret header.

set -euo pipefail

BASE="${1:-http://localhost:3100}"
TOKEN="${MISSION_CONTROL_TOKEN:-$(cat ~/.secrets/mission-control-token 2>/dev/null || echo '')}"
SECRET="${LEAD_WEBHOOK_SECRET:-}"
PASS=0; FAIL=0

auth_args=()
if [[ -n "$TOKEN" ]]; then
  auth_args=(-H "Authorization: Bearer $TOKEN")
elif [[ -n "$SECRET" ]]; then
  auth_args=(-H "x-webhook-secret: $SECRET")
fi

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $name"; ((PASS++))
  else
    echo "  ✗ $name — expected $expected, got $actual"; ((FAIL++))
  fi
}

echo "=== speed-to-lead tests against $BASE ==="
echo ""

# ── Test 1: missing identity → 400 ──────────────────────────────────────────
echo "1. Empty body → 400"
RESP=$(curl -s -w "\n%{http_code}" "${auth_args[@]}" \
  -X POST "$BASE/api/lead" -H "Content-Type: application/json" -d '{}')
STATUS=$(echo "$RESP" | tail -1)
check "empty body returns 400" "400" "$STATUS"

# ── Test 2: hot buyer lead → 201 with plan ──────────────────────────────────
echo "2. Hot buyer lead → 201"
RESP=$(curl -s -w "\n%{http_code}" "${auth_args[@]}" \
  -X POST "$BASE/api/lead?source=zillow" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName":"Jamie","lastName":"Rivera",
    "email":"jamie@example.com","phone":"(435) 555-0142",
    "message":"We are pre-approved and need to buy ASAP. Can we tour 742 Evergreen Terrace this week?",
    "propertyAddress":"742 Evergreen Terrace, St. George, UT"
  }')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "hot lead returns 201" "201" "$STATUS"
check "score present" "1" "$(echo "$BODY" | grep -c '"score"' || true)"
check "firstResponse present" "1" "$(echo "$BODY" | grep -c '"firstResponse"' || true)"
check "cadence present" "1" "$(echo "$BODY" | grep -c '"cadence"' || true)"
check "routed to Buyer Pipeline" "1" "$(echo "$BODY" | grep -c 'Buyer Pipeline' || true)"
check "priority hot" "1" "$(echo "$BODY" | grep -c '"priority":"hot"' || true)"

# ── Test 3: seller DM lead → 201 routed to listing pipeline ─────────────────
echo "3. Seller DM lead → 201"
RESP=$(curl -s -w "\n%{http_code}" "${auth_args[@]}" \
  -X POST "$BASE/api/lead?source=instagram_dm" \
  -H "Content-Type: application/json" \
  -d '{"name":"Pat Lee","message":"Curious what my home is worth, thinking about selling next year."}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "seller lead returns 201" "201" "$STATUS"
check "routed to listing pipeline" "1" "$(echo "$BODY" | grep -c 'Seller / Listing Pipeline' || true)"

# ── Test 4: form-encoded payload → 201 ──────────────────────────────────────
echo "4. Form-encoded payload → 201"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${auth_args[@]}" \
  -X POST "$BASE/api/lead?source=website" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "name=Sam Form" \
  --data-urlencode "email=sam@example.com" \
  --data-urlencode "message=Interested in a showing")
check "form payload returns 201" "201" "$STATUS"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
