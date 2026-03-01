#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-8787}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"
DB_NAME="${DB_NAME:-agentic_wallet_db}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-30}"
WRANGLER_LOG="${WRANGLER_LOG:-/tmp/agentic-wallet-auth-e2e-wrangler.log}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_cmd npx
require_cmd curl
require_cmd node

cleanup() {
  if [[ -n "${DEV_PID:-}" ]] && kill -0 "${DEV_PID}" >/dev/null 2>&1; then
    kill "${DEV_PID}" >/dev/null 2>&1 || true
    wait "${DEV_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

d1_exec_json() {
  local sql="$1"
  npx wrangler d1 execute "$DB_NAME" --local --json --command "$sql"
}

d1_scalar() {
  local sql="$1"
  local column="$2"
  local raw
  raw="$(d1_exec_json "$sql")"
  node -e '
    const data = JSON.parse(process.argv[1]);
    const first = Array.isArray(data) ? (data[0] ?? {}) : data;
    const rows = first.results ?? first.rows ?? [];
    const row = rows[0] ?? {};
    const col = process.argv[2];
    const value = row[col] ?? Object.values(row)[0] ?? "";
    process.stdout.write(String(value));
  ' "$raw" "$column"
}

assert_eq() {
  local got="$1"
  local expect="$2"
  local msg="$3"
  if [[ "$got" != "$expect" ]]; then
    echo "assertion failed: ${msg}. got='${got}', expect='${expect}'" >&2
    exit 1
  fi
}

request_json() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local auth_header="${4:-}"
  local tmp
  tmp="$(mktemp)"
  local status
  if [[ -n "$body" && -n "$auth_header" ]]; then
    status="$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$url" -H "Content-Type: application/json" -H "$auth_header" --data "$body")"
  elif [[ -n "$body" ]]; then
    status="$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$url" -H "Content-Type: application/json" --data "$body")"
  elif [[ -n "$auth_header" ]]; then
    status="$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$url" -H "$auth_header")"
  else
    status="$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$url")"
  fi
  local body_out
  body_out="$(cat "$tmp")"
  rm -f "$tmp"
  printf '%s\n%s\n' "$status" "$body_out"
}

echo "[1/6] Applying local D1 migrations..."
npx wrangler d1 migrations apply "$DB_NAME" --local >/tmp/agentic-wallet-auth-e2e-migrate.log

echo "[2/6] Seeding expired challenge + logout session..."
EXPIRED_CHALLENGE_ID="expired-auth-challenge-e2e"
USER_ID="$(node -e "console.log(require('crypto').randomUUID())")"
TOKEN="$(node -e "console.log(require('crypto').randomUUID())")"
NOW_ISO="$(node -e "console.log(new Date().toISOString())")"
EXPIRED_ISO="$(node -e "console.log(new Date(Date.now()-60_000).toISOString())")"
FUTURE_ISO="$(node -e "console.log(new Date(Date.now()+2*60*60*1000).toISOString())")"
HANDLE="test_${USER_ID%%-*}"

d1_exec_json "DELETE FROM auth_challenges WHERE id = '${EXPIRED_CHALLENGE_ID}';
INSERT OR REPLACE INTO auth_challenges (id, user_id, ceremony, challenge, expires_at, created_at) VALUES ('${EXPIRED_CHALLENGE_ID}', NULL, 'registration', 'stale-challenge', '${EXPIRED_ISO}', '${NOW_ISO}');
INSERT OR REPLACE INTO users (id, handle, display_name, created_at) VALUES ('${USER_ID}', '${HANDLE}', 'Auth E2E User', '${NOW_ISO}');
INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at) VALUES ('${TOKEN}', '${USER_ID}', '${FUTURE_ISO}', '${NOW_ISO}');" >/tmp/agentic-wallet-auth-e2e-seed.log

echo "[3/6] Starting wrangler dev on port ${PORT}..."
npx wrangler dev src/index.ts --persist-to .wrangler/state --port "$PORT" >"$WRANGLER_LOG" 2>&1 &
DEV_PID=$!

echo "[4/6] Waiting for local server..."
for ((i=0; i<TIMEOUT_SECONDS; i++)); do
  if curl -sS "${BASE_URL}/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -sS "${BASE_URL}/" >/dev/null 2>&1; then
  echo "server did not become ready within ${TIMEOUT_SECONDS}s. check log: ${WRANGLER_LOG}" >&2
  exit 1
fi

echo "[5/6] Verifying registration orphan cleanup + challenge GC..."
register_options_status_and_body="$(request_json POST "${BASE_URL}/v1/auth/register/options" "{}")"
REGISTER_OPTIONS_STATUS="$(printf '%s\n' "$register_options_status_and_body" | sed -n '1p')"
REGISTER_OPTIONS_BODY="$(printf '%s\n' "$register_options_status_and_body" | sed -n '2,$p')"
assert_eq "$REGISTER_OPTIONS_STATUS" "200" "register options status"

REGISTER_USER_ID="$(node -e 'const payload = JSON.parse(process.argv[1]); process.stdout.write(payload.userId || "");' "$REGISTER_OPTIONS_BODY")"
REGISTER_CHALLENGE_ID="$(node -e 'const payload = JSON.parse(process.argv[1]); process.stdout.write(payload.challengeId || "");' "$REGISTER_OPTIONS_BODY")"

bad_verify_payload="$(node -e 'const userId=process.argv[1]; const challengeId=process.argv[2]; process.stdout.write(JSON.stringify({ userId, challengeId, response: {} }));' "$REGISTER_USER_ID" "$REGISTER_CHALLENGE_ID")"
register_verify_status_and_body="$(request_json POST "${BASE_URL}/v1/auth/register/verify" "$bad_verify_payload")"
REGISTER_VERIFY_STATUS="$(printf '%s\n' "$register_verify_status_and_body" | sed -n '1p')"
REGISTER_VERIFY_BODY="$(printf '%s\n' "$register_verify_status_and_body" | sed -n '2,$p')"
assert_eq "$REGISTER_VERIFY_STATUS" "400" "register verify invalid payload status"

ORPHAN_COUNT="$(d1_scalar "SELECT COUNT(*) AS c FROM users WHERE id = '${REGISTER_USER_ID}'" "c")"
assert_eq "$ORPHAN_COUNT" "0" "orphan user should not exist after failed verify"

EXPIRED_COUNT="$(d1_scalar "SELECT COUNT(*) AS c FROM auth_challenges WHERE id = '${EXPIRED_CHALLENGE_ID}'" "c")"
assert_eq "$EXPIRED_COUNT" "0" "expired challenges should be cleaned up"

echo "[6/6] Verifying logout invalidates session..."
ME_BEFORE="$(request_json GET "${BASE_URL}/v1/me" "" "Authorization: Bearer ${TOKEN}")"
ME_BEFORE_STATUS="$(printf '%s\n' "$ME_BEFORE" | sed -n '1p')"
assert_eq "$ME_BEFORE_STATUS" "200" "me before logout status"

LOGOUT="$(request_json POST "${BASE_URL}/v1/auth/logout" "{}" "Authorization: Bearer ${TOKEN}")"
LOGOUT_STATUS="$(printf '%s\n' "$LOGOUT" | sed -n '1p')"
assert_eq "$LOGOUT_STATUS" "200" "logout status"

ME_AFTER="$(request_json GET "${BASE_URL}/v1/me" "" "Authorization: Bearer ${TOKEN}")"
ME_AFTER_STATUS="$(printf '%s\n' "$ME_AFTER" | sed -n '1p')"
assert_eq "$ME_AFTER_STATUS" "401" "me after logout status"

echo "auth e2e checks passed."
echo "register_verify_body=${REGISTER_VERIFY_BODY}"
echo "wrangler_log=${WRANGLER_LOG}"
