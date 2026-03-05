#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-8787}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"
DB_NAME="${DB_NAME:-agentic_wallet_db}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-30}"
WRANGLER_LOG="${WRANGLER_LOG:-/tmp/agentic-wallet-asset-model-e2e-wrangler.log}"

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

echo "[1/7] Applying local D1 migrations..."
npx wrangler d1 migrations apply "$DB_NAME" --local >/tmp/agentic-wallet-asset-model-e2e-migrate.log

echo "[2/7] Seeding local test user + session..."
USER_ID="$(node -e "console.log(require('crypto').randomUUID())")"
TOKEN="$(node -e "console.log(require('crypto').randomUUID())")"
NOW_ISO="$(node -e "console.log(new Date().toISOString())")"
EXP_ISO="$(node -e "const d=new Date(Date.now()+2*60*60*1000); console.log(d.toISOString())")"
HANDLE="test_${USER_ID%%-*}"

npx wrangler d1 execute "$DB_NAME" --local --command \
  "INSERT OR REPLACE INTO users (id, handle, display_name, created_at) VALUES ('$USER_ID', '$HANDLE', 'Asset Model E2E User', '$NOW_ISO');
   INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at) VALUES ('$TOKEN', '$USER_ID', '$EXP_ISO', '$NOW_ISO');" \
  >/tmp/agentic-wallet-asset-model-e2e-seed.log

echo "[3/7] Starting wrangler dev on port ${PORT}..."
npx wrangler dev src/index.ts --persist-to .wrangler/state --port "$PORT" >"$WRANGLER_LOG" 2>&1 &
DEV_PID=$!

echo "[4/7] Waiting for local server..."
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

AUTH_HEADER="Authorization: Bearer ${TOKEN}"

echo "[5/7] Checking resolve + resolve(batch)..."
resolve_status_and_body="$(request_json POST "${BASE_URL}/v1/assets/resolve" '{"chain":"eth","contract":"native","marketType":"spot","symbol":"ETH"}' "$AUTH_HEADER")"
RESOLVE_STATUS="$(printf '%s\n' "$resolve_status_and_body" | sed -n '1p')"
RESOLVE_BODY="$(printf '%s\n' "$resolve_status_and_body" | sed -n '2,$p')"
assert_eq "$RESOLVE_STATUS" "200" "resolve status"

RESOLVED_ASSET_ID="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(String(p.asset_id||""));' "$RESOLVE_BODY")"
RESOLVED_INSTRUMENT_ID="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(String(p.instrument_id||""));' "$RESOLVE_BODY")"
RESOLVED_MARKET_TYPE="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(String(p.market_type||""));' "$RESOLVE_BODY")"

if [[ -z "$RESOLVED_ASSET_ID" || -z "$RESOLVED_INSTRUMENT_ID" ]]; then
  echo "resolve response missing asset_id/instrument_id: $RESOLVE_BODY" >&2
  exit 1
fi
assert_eq "$RESOLVED_MARKET_TYPE" "spot" "resolve market_type"

batch_payload="$(node -e '
  const instrumentId = process.argv[1];
  process.stdout.write(JSON.stringify({
    items: [
      { chain: "eth", contract: "native", marketType: "spot", symbol: "ETH" },
      { itemId: "hyperliquid:BTC", marketType: "perp" },
      { itemId: instrumentId },
      { itemId: "unsupported:foo" }
    ]
  }));
' "$RESOLVED_INSTRUMENT_ID")"
batch_status_and_body="$(request_json POST "${BASE_URL}/v1/assets/resolve/batch" "$batch_payload" "$AUTH_HEADER")"
BATCH_STATUS="$(printf '%s\n' "$batch_status_and_body" | sed -n '1p')"
BATCH_BODY="$(printf '%s\n' "$batch_status_and_body" | sed -n '2,$p')"
assert_eq "$BATCH_STATUS" "200" "resolve batch status"

node -e '
  const payload = JSON.parse(process.argv[1]);
  const results = payload.results || [];
  if (results.length !== 4) {
    throw new Error(`unexpected batch size: ${results.length}`);
  }
  if (!results[0]?.ok || results[0]?.result?.market_type !== "spot") {
    throw new Error("batch[0] should resolve spot");
  }
  if (!results[1]?.ok || results[1]?.result?.market_type !== "perp") {
    throw new Error("batch[1] should resolve perp");
  }
  if (!results[2]?.ok || !String(results[2]?.result?.instrument_id || "").startsWith("ins:")) {
    throw new Error("batch[2] should resolve by instrument itemId");
  }
  if (results[3]?.ok !== false) {
    throw new Error("batch[3] should fail for unsupported itemId");
  }
' "$BATCH_BODY"

echo "[6/7] Checking asset/instrument fetch APIs..."
asset_status_and_body="$(request_json GET "${BASE_URL}/v1/assets/${RESOLVED_ASSET_ID}" "" "$AUTH_HEADER")"
ASSET_STATUS="$(printf '%s\n' "$asset_status_and_body" | sed -n '1p')"
ASSET_BODY="$(printf '%s\n' "$asset_status_and_body" | sed -n '2,$p')"
assert_eq "$ASSET_STATUS" "200" "asset summary status"

DEFAULT_INSTRUMENT_ID="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(String(p.defaultInstrumentId||""));' "$ASSET_BODY")"
if [[ -z "$DEFAULT_INSTRUMENT_ID" ]]; then
  echo "asset summary missing defaultInstrumentId: $ASSET_BODY" >&2
  exit 1
fi

market_status_and_body="$(request_json GET "${BASE_URL}/v1/markets/${DEFAULT_INSTRUMENT_ID}" "" "$AUTH_HEADER")"
MARKET_STATUS="$(printf '%s\n' "$market_status_and_body" | sed -n '1p')"
MARKET_BODY="$(printf '%s\n' "$market_status_and_body" | sed -n '2,$p')"
assert_eq "$MARKET_STATUS" "200" "market by instrument status"

node -e '
  const payload = JSON.parse(process.argv[1]);
  if (!payload.instrument?.instrument_id || !payload.asset?.asset_id) {
    throw new Error("market payload missing instrument/asset");
  }
' "$MARKET_BODY"

echo "[7/7] Checking top-assets includes identity fields..."
top_assets_status_and_body="$(request_json GET "${BASE_URL}/v1/market/top-assets?source=coingecko&name=marketCap&limit=5&chains=eth" "" "$AUTH_HEADER")"
TOP_ASSETS_STATUS="$(printf '%s\n' "$top_assets_status_and_body" | sed -n '1p')"
TOP_ASSETS_BODY="$(printf '%s\n' "$top_assets_status_and_body" | sed -n '2,$p')"
assert_eq "$TOP_ASSETS_STATUS" "200" "top-assets status"

node -e '
  const payload = JSON.parse(process.argv[1]);
  const assets = payload.assets || [];
  if (assets.length === 0) {
    throw new Error("top-assets empty");
  }
  for (const asset of assets) {
    if (!asset.asset_id || !asset.instrument_id) {
      throw new Error("top-assets item missing asset_id/instrument_id");
    }
  }
' "$TOP_ASSETS_BODY"

echo "asset model e2e checks passed."
echo "user_id=${USER_ID}"
echo "token=${TOKEN}"
echo "wrangler_log=${WRANGLER_LOG}"
