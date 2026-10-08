#!/usr/bin/env bash
# Knowvia deploy smoke test. Usage: scripts/deploy/smoke.sh https://<host> [--retries N]
# Read-only HTTP checks; sends no credentials and no personal data.
set -euo pipefail

BASE_URL="${1:-}"
RETRIES=12
if [[ "${2:-}" == "--retries" ]]; then RETRIES="${3:-12}"; fi
if [[ -z "$BASE_URL" || "$BASE_URL" != http*://* ]]; then
  echo "usage: $0 <base-url, e.g. https://knowvia-staging-api-123.asia-south1.run.app> [--retries N]" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

failures=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*" >&2; failures=$((failures + 1)); }

status_of() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo 000; }

expect_status() { # label expected-regex url [curl args...]
  local label="$1" want="$2" url="$3"; shift 3
  local got; got="$(status_of "$@" "$url")"
  if [[ "$got" =~ ^($want)$ ]]; then pass "$label -> $got"; else fail "$label -> $got (wanted $want)"; fi
}

# /live: retry while a fresh revision warms up.
live=000
for ((i = 1; i <= RETRIES; i++)); do
  live="$(status_of "$BASE_URL/live")"
  [[ "$live" == 200 ]] && break
  sleep 5
done
if [[ "$live" == 200 ]]; then pass "GET /live -> 200"; else fail "GET /live -> $live"; fi

expect_status "GET /ready (database reachable)" "200" "$BASE_URL/ready"

# UI served same-origin with a CSP header.
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
headers="$(curl -sS -D - -o "$body_file" --max-time 15 "$BASE_URL/" 2>/dev/null || true)"
root_status="$(printf '%s' "$headers" | awk 'toupper($1) ~ /^HTTP/ {code=$2} END {print code}')"
content_type="$(printf '%s' "$headers" | grep -i '^content-type:' | tail -1 | tr -d '\r' || true)"
if [[ "$root_status" == 200 ]] && grep -qi 'text/html' <<<"$content_type" && grep -qi '<html' "$body_file" 2>/dev/null; then
  pass "GET / -> 200 HTML"
else
  fail "GET / -> ${root_status:-?} ($content_type), expected 200 HTML"
fi
if printf '%s' "$headers" | grep -qi '^content-security-policy:'; then pass "GET / has Content-Security-Policy"; else fail "GET / is missing Content-Security-Policy"; fi

# Unauthenticated API must be refused, never a 500.
expect_status "GET /api/v1/integrations (unauthenticated)" "401|403" "$BASE_URL/api/v1/integrations"
expect_status "POST /api/v1/cases (unauthenticated)" "401|403" "$BASE_URL/api/v1/cases" -X POST -H 'content-type: application/json' --data '{}'

# Analytics proxy: no consent cookie -> events are dropped with 204.
expect_status "POST /ingest/e/ without consent cookie" "204" "$BASE_URL/ingest/e/" -X POST -H 'content-type: text/plain' --data '{}'

if (( failures > 0 )); then echo "Smoke test FAILED ($failures check(s))." >&2; exit 1; fi
echo "Smoke test passed."
