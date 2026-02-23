#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-8787}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"
DB_NAME="${DB_NAME:-agentic_wallet_db}"
TOPIC="${TOPIC:-ETH生态观察}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-30}"
WRANGLER_LOG="${WRANGLER_LOG:-/tmp/agentic-wallet-wrangler-dev.log}"

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

echo "[1/8] Applying local D1 migrations..."
npx wrangler d1 migrations apply "$DB_NAME" --local >/tmp/agentic-wallet-d1-migrate.log

USER_ID="$(node -e "console.log(require('crypto').randomUUID())")"
TOKEN="$(node -e "console.log(require('crypto').randomUUID())")"
NOW_ISO="$(node -e "console.log(new Date().toISOString())")"
EXP_ISO="$(node -e "const d=new Date(Date.now()+2*60*60*1000); console.log(d.toISOString())")"
HANDLE="test_${USER_ID%%-*}"

echo "[2/8] Seeding local test user + session..."
npx wrangler d1 execute "$DB_NAME" --local --command \
  "INSERT OR REPLACE INTO users (id, handle, display_name, created_at) VALUES ('$USER_ID', '$HANDLE', 'Test User', '$NOW_ISO');
   INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at) VALUES ('$TOKEN', '$USER_ID', '$EXP_ISO', '$NOW_ISO');" \
  >/tmp/agentic-wallet-d1-seed.log

echo "[3/8] Starting wrangler dev on port ${PORT}..."
npx wrangler dev src/index.ts --persist-to .wrangler/state --port "$PORT" >"$WRANGLER_LOG" 2>&1 &
DEV_PID=$!

echo "[4/8] Waiting for local server..."
for ((i=0; i< TIMEOUT_SECONDS; i++)); do
  if curl -sS "${BASE_URL}/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -sS "${BASE_URL}/" >/dev/null 2>&1; then
  echo "server did not become ready within ${TIMEOUT_SECONDS}s. check log: ${WRANGLER_LOG}" >&2
  exit 1
fi

auth_header=(-H "Authorization: Bearer ${TOKEN}")
json_header=(-H "Content-Type: application/json")

echo "[5/8] Ingesting sample event..."
EVENT_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/events" "${auth_header[@]}" "${json_header[@]}" --data '{"type":"asset_viewed","payload":{"asset":"ETH","chain":"base"},"dedupeKey":"e2e-agent-local-evt-1"}')"
echo "$EVENT_RESPONSE"

echo "[6/8] Triggering agent jobs..."
DAILY_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/jobs/daily-digest/run" "${auth_header[@]}")"
RECO_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/jobs/recommendations/run" "${auth_header[@]}")"
TOPIC_PAYLOAD="$(printf '{"topic":"%s"}' "$TOPIC")"
TOPIC_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/jobs/topic/run" "${auth_header[@]}" "${json_header[@]}" --data "$TOPIC_PAYLOAD")"
echo "daily: $DAILY_RESPONSE"
echo "recommendations: $RECO_RESPONSE"
echo "topic: $TOPIC_RESPONSE"

echo "[7/8] Fetching generated outputs..."
ARTICLES_RESPONSE="$(curl -sS "${BASE_URL}/v1/agent/articles" "${auth_header[@]}")"
RECOMMENDATIONS_RESPONSE="$(curl -sS "${BASE_URL}/v1/agent/recommendations" "${auth_header[@]}")"
echo "articles: $ARTICLES_RESPONSE"
echo "recommendations: $RECOMMENDATIONS_RESPONSE"

DAILY_ARTICLE_ID="$(
  node -e '
    const payload = JSON.parse(process.argv[1]);
    const daily = (payload.articles || []).find((x) => x.type === "daily");
    process.stdout.write(daily?.id || "");
  ' "$ARTICLES_RESPONSE"
)"

if [[ -n "$DAILY_ARTICLE_ID" ]]; then
  ARTICLE_DETAIL_RESPONSE="$(curl -sS "${BASE_URL}/v1/agent/articles/${DAILY_ARTICLE_ID}" "${auth_header[@]}")"
  echo "daily detail: $ARTICLE_DETAIL_RESPONSE"
else
  echo "daily detail: skipped (no daily article found)"
fi

echo "[8/8] Done."
echo "user_id=${USER_ID}"
echo "token=${TOKEN}"
echo "wrangler_log=${WRANGLER_LOG}"
