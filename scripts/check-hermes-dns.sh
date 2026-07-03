#!/usr/bin/env bash
# check-hermes-dns.sh — verify the DNS path to Hermes is intact.
#
# Catches the 2026-06 failure mode: domain nameservers silently switched from
# Cloudflare to Vercel, which removes the Cloudflare Tunnel (and Cloudflare
# Access) from the request path while the tunnel connector itself stays green.
#
# Intended to run from the Mac Mini or any host with unrestricted DNS/HTTPS,
# standalone or as part of dan-daily-repair. Exit 0 = healthy, non-zero =
# number of failed checks. See docs/hermes-dns-nameserver-recovery.md.

set -u

DOMAIN="thefinesthomesutah.com"
EXPECTED_NS_SUFFIX="ns.cloudflare.com"
SUBDOMAINS=("hermes" "app" "docs")
FAILURES=0

fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }
ok()   { echo "  ok:   $1"; }

echo "== 1. Authoritative nameservers for ${DOMAIN} =="
NS_RECORDS=$(dig +short NS "${DOMAIN}" 2>/dev/null)
if [[ -z "${NS_RECORDS}" ]]; then
  fail "could not resolve NS records for ${DOMAIN}"
elif echo "${NS_RECORDS}" | grep -q "vercel-dns"; then
  fail "nameservers point at Vercel — tunnel + Access are out of the path:"
  echo "${NS_RECORDS}" | sed 's/^/        /'
elif echo "${NS_RECORDS}" | grep -q "${EXPECTED_NS_SUFFIX}"; then
  ok "Cloudflare is authoritative ($(echo "${NS_RECORDS}" | tr '\n' ' '))"
else
  fail "unexpected nameservers: $(echo "${NS_RECORDS}" | tr '\n' ' ')"
fi

echo "== 2. hermes.${DOMAIN} is behind Cloudflare =="
SERVER_HEADER=$(curl -sI -m 15 "https://hermes.${DOMAIN}/" 2>/dev/null \
  | awk 'tolower($1) == "server:" {print tolower($2)}' | tr -d '\r')
if [[ "${SERVER_HEADER}" == *cloudflare* ]]; then
  ok "server header is cloudflare"
else
  fail "server header is '${SERVER_HEADER:-<none>}' — Cloudflare proxy not in path"
fi

echo "== 3. HTTP status of each hostname =="
for sub in "${SUBDOMAINS[@]}"; do
  host="${sub}.${DOMAIN}"
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "https://${host}/" 2>/dev/null)
  # 2xx/3xx healthy; 401/403 healthy too (Cloudflare Access challenge in path)
  case "${code}" in
    2*|3*|401|403) ok "${host} -> ${code}" ;;
    *)             fail "${host} -> ${code:-000}" ;;
  esac
done

root_code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "https://${DOMAIN}/" 2>/dev/null)
case "${root_code}" in
  2*|3*) ok "${DOMAIN} -> ${root_code}" ;;
  *)     fail "${DOMAIN} -> ${root_code:-000}" ;;
esac

echo
if [[ ${FAILURES} -eq 0 ]]; then
  echo "All checks passed — DNS path to Hermes is intact."
else
  echo "${FAILURES} check(s) failed — see docs/hermes-dns-nameserver-recovery.md"
fi
exit "${FAILURES}"
