#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-8787}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"
DB_NAME="${DB_NAME:-agentic_wallet_db}"
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

echo "[1/10] Applying local D1 migrations..."
npx wrangler d1 migrations apply "$DB_NAME" --local >/tmp/agentic-wallet-d1-migrate.log

USER_ID="$(node -e "console.log(require('crypto').randomUUID())")"
TOKEN="$(node -e "console.log(require('crypto').randomUUID())")"
NOW_ISO="$(node -e "console.log(new Date().toISOString())")"
EXP_ISO="$(node -e "const d=new Date(Date.now()+2*60*60*1000); console.log(d.toISOString())")"
HANDLE="test_${USER_ID%%-*}"

echo "[2/10] Seeding local test user + session..."
npx wrangler d1 execute "$DB_NAME" --local --command \
  "INSERT OR REPLACE INTO users (id, handle, display_name, created_at) VALUES ('$USER_ID', '$HANDLE', 'Test User', '$NOW_ISO');
   INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at) VALUES ('$TOKEN', '$USER_ID', '$EXP_ISO', '$NOW_ISO');" \
  >/tmp/agentic-wallet-d1-seed.log

echo "[3/10] Starting wrangler dev on port ${PORT}..."
npx wrangler dev src/index.ts --persist-to .wrangler/state --port "$PORT" >"$WRANGLER_LOG" 2>&1 &
DEV_PID=$!

echo "[4/10] Waiting for local server..."
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

echo "[5/10] Ingesting sample events..."
EVENT_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/events" "${auth_header[@]}" "${json_header[@]}" --data '{"type":"asset_viewed","payload":{"asset":"ETH","chain":"base","source":"e2e_trade_shelf"},"dedupeKey":"e2e-agent-local-evt-1"}')"
FAVORITE_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/events" "${auth_header[@]}" "${json_header[@]}" --data '{"type":"asset_favorited","payload":{"asset":"ETH","chain":"eth","contract":"","source":"e2e_trade_shelf"},"dedupeKey":"e2e-agent-local-evt-2"}')"
TRADE_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/events" "${auth_header[@]}" "${json_header[@]}" --data '{"type":"trade_buy","payload":{"asset":"ETH","buyToken":"ETH","sellToken":"USDC","source":"e2e_trade_shelf"},"dedupeKey":"e2e-agent-local-evt-3"}')"
echo "view: $EVENT_RESPONSE"
echo "favorite: $FAVORITE_RESPONSE"
echo "trade: $TRADE_RESPONSE"

echo "[6/10] Triggering agent jobs..."
DAILY_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/jobs/daily-digest/run" "${auth_header[@]}")"
RECO_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/jobs/recommendations/run" "${auth_header[@]}")"
TRADE_SHELF_REFRESH_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/jobs/trade-shelf/run" "${auth_header[@]}")"
echo "daily: $DAILY_RESPONSE"
echo "recommendations: $RECO_RESPONSE"
echo "trade_shelf: $TRADE_SHELF_REFRESH_RESPONSE"

echo "[7/10] Fetching generated outputs..."
ARTICLES_RESPONSE="$(curl -sS "${BASE_URL}/v1/agent/articles" "${auth_header[@]}")"
RECOMMENDATIONS_RESPONSE="$(curl -sS "${BASE_URL}/v1/agent/recommendations" "${auth_header[@]}")"
TRADE_SHELF_RESPONSE="$(curl -sS "${BASE_URL}/v1/market/trade-shelf" "${auth_header[@]}")"
TRADE_BROWSE_RESPONSE="$(curl -sS "${BASE_URL}/v1/market/trade-browse" "${auth_header[@]}")"
echo "articles: $ARTICLES_RESPONSE"
echo "recommendations: $RECOMMENDATIONS_RESPONSE"
echo "trade_shelf: $TRADE_SHELF_RESPONSE"
echo "trade_browse: $TRADE_BROWSE_RESPONSE"

echo "[8/10] Validating trade shelf acceptance..."
node -e '
  const shelf = JSON.parse(process.argv[1]);
  if (!Array.isArray(shelf.sections) || shelf.sections.length < 1) {
    throw new Error("trade_shelf_sections_missing");
  }
  const nonEmptySections = shelf.sections.filter((section) => Array.isArray(section.items) && section.items.length > 0);
  if (nonEmptySections.length < 1) {
    throw new Error("trade_shelf_non_empty_section_missing");
  }
  const behaviorSection = shelf.sections.find((section) => section.id === "behavior");
  if (!behaviorSection || !Array.isArray(behaviorSection.items) || behaviorSection.items.length === 0) {
    throw new Error("trade_shelf_behavior_section_missing");
  }
  const hasBehaviorReason = behaviorSection.items.some((item) => (
    item.reasonTag === "Recently viewed" || item.reasonTag === "Recently traded"
  ));
  if (!hasBehaviorReason) {
    throw new Error("trade_shelf_behavior_reason_missing");
  }
  if (!shelf.refreshState || shelf.refreshState.dirty !== false) {
    throw new Error("trade_shelf_not_clean_after_refresh");
  }
' "$TRADE_SHELF_RESPONSE"

node -e '
  const browse = JSON.parse(process.argv[1]);
  const hasAnyPublicShelf = ["topMovers", "trendings", "perps", "predictions"].some((key) => Array.isArray(browse[key]));
  if (!hasAnyPublicShelf) {
    throw new Error("trade_browse_response_missing_sections");
  }
' "$TRADE_BROWSE_RESPONSE"

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

echo "[9/10] Triggering portfolio snapshot job for regression coverage..."
PORTFOLIO_JOB_RESPONSE="$(curl -sS -X POST "${BASE_URL}/v1/agent/jobs/portfolio-snapshot/run" "${auth_header[@]}")"
echo "portfolio_snapshot: $PORTFOLIO_JOB_RESPONSE"

echo "[10/10] Done."
echo "user_id=${USER_ID}"
echo "token=${TOKEN}"
echo "wrangler_log=${WRANGLER_LOG}"
