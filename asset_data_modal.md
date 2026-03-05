# Asset Data Model Final Plan

## 1. Goals

This design is optimized for current data sources and frontend page shapes:

- Keep a strict identity split between `asset_id` and `instrument_id`.
- Treat stock tokens as normal spot tokens, while preserving equity semantics via metadata.
- Make Home, Trade, and Detail pages query stable IDs, not source-specific keys.
- Let new market/data providers plug in without changing page contracts.

## 2. Identity Model

### 2.1 Core Concepts

- `asset_id`: canonical economic target ("what it is"), used for aggregation.
- `instrument_id`: tradable instance ("where/how to trade"), used for pricing, kline, execution, and watchlist granularity.

### 2.2 Main Rules

1. Symbol/name is never an identity key.
2. EVM spot identity = `chain + contract` (or `native` for gas token).
3. Perp identity = `venue + symbol` (plus metadata for quote/settlement).
4. Prediction identity = `venue + market_id + outcome_id`.
5. Stock token is modeled as `spot` instrument, with `asset_class=equity_exposure` and `underlying_ticker` metadata.
6. Native assets (ETH/BNB) are modeled with `contract_key=native`.

## 3. Data Schema

### 3.1 `assets`

- `asset_id` (PK)
- `asset_class` (`crypto | equity_exposure | event_outcome | fiat | index`)
- `symbol`, `name`, `logo_uri`
- `status` (`active | inactive`)
- `source`, `created_at`, `updated_at`

### 3.2 `instruments`

- `instrument_id` (PK)
- `asset_id` (FK)
- `market_type` (`spot | perp | prediction`)
- `venue`, `symbol`
- `chain`, `contract_key`
- `source`, `source_item_id`
- `metadata_json` (market-specific extension fields)
- `status`, `created_at`, `updated_at`

### 3.3 `instrument_refs`

- `provider`, `provider_key` (PK pair)
- `instrument_id` (FK)
- `confidence`
- `created_at`, `updated_at`

Used to map source keys like:

- `coingecko + ethereum:0xa0...`
- `hyperliquid + BTC`
- `polymarket + market_id:outcome_id`

### 3.4 `asset_links`

- `source_asset_id`, `target_asset_id`, `link_type` (PK triple)
- `confidence`, `source`
- `created_at`, `updated_at`

Used for soft relationships (`underlying_of`, `correlated`, `hedge_pair`, `possible_duplicate`).

## 4. Merge Policy (Same Symbol / Cross-Chain)

### 4.1 Auto-merge (strong evidence)

Allowed when:

- contract-level mapping is confirmed by trusted source mapping (CoinGecko platforms / maintained mapping),
- mapping is stable across refreshes,
- no conflict with existing canonical mapping.

### 4.2 Weak link only

When only symbol/name is matched, create `asset_links.possible_duplicate` and do not merge `asset_id`.

### 4.3 Native Assets

Use explicit chain-native mapping:

- `ins:spot:1:native` -> `ast:crypto:ethereum`
- `ins:spot:8453:native` -> `ast:crypto:ethereum`
- `ins:spot:56:native` -> `ast:crypto:binancecoin`

## 5. API Contract

### 5.1 Core Identity APIs

1. `POST /v1/assets/resolve`
   - Input supports:
     - `{ chain, contract }`
     - `{ itemId }` for source IDs (`hyperliquid:*`, `polymarket:*`, `binance-stock:*`)
     - explicit market input (`marketType/venue/symbol/marketId/outcomeId`)
   - Output:
     - `{ asset_id, instrument_id, market_type, confidence }`

2. `POST /v1/assets/resolve/batch`
   - Input:
     - `{ items: ResolveInput[] }` (up to 500)
   - Output:
     - `{ results: [{ ok: true, result }, { ok: false, error }] }`
   - Preserves input order and supports partial success.

3. `GET /v1/assets/:assetId`
   - Canonical asset payload.

4. `GET /v1/assets/:assetId/instruments`
   - Tradable instances under one asset.

### 5.2 Unified Market APIs

5. `GET /v1/markets/:instrumentId`
   - Unified market detail by `instrument_id`.

6. `GET /v1/markets/:instrumentId/candles?period=1h&size=60&optionTokenId=...`
   - Unified kline endpoint.

## 6. Frontend Request Plan

### 6.1 Home

- Primary feed can stay current for now.
- Any click-through to market/detail should carry `instrument_id` if available.
- If only chain/contract is known, call `/v1/assets/resolve` first.
- `/v1/market/top-assets` should server-side normalize `asset_id/instrument_id` via batch resolve
  so homepage/article entry points can directly reuse canonical IDs.

### 6.2 Trade

- Browse/search cards should carry `{ asset_id, instrument_id, market_type }`.
- Backend browse API should use batch resolve + dedupe to fill IDs in one pass.
- Detail page navigation should use `instrument_id` as routing payload.

### 6.3 Detail

- Detail data: `GET /v1/markets/:instrumentId`
- Kline: `GET /v1/markets/:instrumentId/candles`
- Related market switcher: `GET /v1/assets/:assetId/instruments`

## 7. Implementation Phases

### Phase 1 (this implementation start)

- Add schema tables (`assets`, `instruments`, `instrument_refs`, `asset_links`).
- Add core resolve/asset/markets routes.
- Add spot/perp/prediction/native ID builders and resolver logic.

### Phase 2

- Feed `instrument_id` through Trade/Home payloads.
- Add projection jobs for browse/detail caching.
- Add stronger merge confidence and conflict tooling.

### Phase 3

- Switch frontend routing to `instrument_id` first.
- Add richer `asset_links` usage and recommendation graph features.

## 8. Operational Notes

- Resolver is deterministic and idempotent.
- Writes use UPSERT semantics.
- Route-level fallback preserves provider resilience by reusing existing market services.
