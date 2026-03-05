# Asset Identity Domain Model (Token / Perps / Prediction)

## TL;DR

是的，**分开存会更好**：

- `tokens`：链上现货资产实例（同一币跨链会有多个 token instance）。
- `perps`：永续合约实例（按交易所/合约维度唯一）。
- `prediction_markets`：预测市场可交易 outcome 实例。
- `assets`：统一的“经济标的”主表（内部 canonical asset）。

然后用映射关系把三类 instrument 关联到同一个 `asset_id`（或 underlying `asset_id`）。这样保留每种市场的特性，同时能做组合级聚合与推荐。

---

## Why split storage by market type

把 token/perps/prediction 硬塞进同一张“扁平资产表”会带来很多空字段和语义冲突，例如：

- token 需要 `chain_id + contract_address`，prediction 需要 `event_id + outcome`。
- perps 有 `funding_rate/open_interest`，token 没有。
- prediction 有 `resolution_time/outcome_probability`，perps 没有。

**分表存 instrument，统一 asset 主表聚合**，可以做到：

1. 数据模型更清晰，避免一张表承载三种语义。
2. 接入外部行情/交易源时更稳定（每类有独立解析器）。
3. 上层功能（钱包、日报、推荐）继续只依赖 `asset_id` 聚合。

---

## Recommended model

### 1) Canonical assets

`assets`（统一主键）

- `asset_id` (PK): `ast:<domain>:<slug>`
- `asset_class`: `crypto | event_outcome | fiat | index`
- `symbol`, `name`, `status`

> 这个表是“是什么”，不关心在哪交易。

### 2) Market-specific instruments

#### `token_instruments`

- `instrument_id` (PK): `ins:spot:<chain_id>:<address_or_native>`
- `asset_id` (FK -> assets)
- `chain_id`, `contract_address`, `decimals`, `is_native`
- `coingecko_id` / `cmc_id` (optional alias)

#### `perp_instruments`

- `instrument_id` (PK): `ins:perp:<venue>:<symbol_or_contract>`
- `underlying_asset_id` (FK -> assets)
- `quote_asset_id` (FK -> assets)
- `venue`, `symbol`, `contract_type`, `settlement_asset_id`

#### `prediction_instruments`

- `instrument_id` (PK): `ins:pred:<venue>:<market_id>:<outcome_id>`
- `asset_id` (FK -> assets)  // 建议一个 outcome 一个 asset
- `event_id`, `market_id`, `outcome_id`, `close_time`, `resolution_source`

### 3) Link table for cross-market relationships

`asset_links`

- `source_asset_id`
- `target_asset_id`
- `link_type`: `underlying_of | quote_of | hedge_pair | correlated`
- `confidence`, `source`

用途：把 `BTC` 和各 venue 的 `BTC-PERP`、`BTC prediction outcome basket` 做软关联，不强制一对一。

---

## Handling “same token on multiple chains”

对于 USDC 这种情况：

- 统一 canonical：`ast:crypto:usdc`
- 多个 token instruments：
  - `ins:spot:1:0xa0b8...` (Ethereum)
  - `ins:spot:8453:0x8335...` (Base)
  - `ins:spot:56:0x8ac7...` (BNB)

仓位明细按 `instrument_id` 展示，净值/风险按 `asset_id` 聚合。

---

## API shape after split

1. `POST /v1/assets/resolve`
   - 输入可为 `{chain_id, contract_address}` / `{venue, symbol}` / `{prediction_market, outcome}`
   - 输出 `{asset_id, instrument_id, market_type, confidence}`

2. `GET /v1/assets/:assetId`
   - 返回 canonical 信息 + 聚合行情

3. `GET /v1/assets/:assetId/instruments`
   - 返回该 asset 下的 token/perp/prediction 实例

4. `GET /v1/instruments/:instrumentId`
   - 返回 instrument-specific 字段与行情

---

## Migration strategy (low-risk)

1. 保留现有 `assetIdentity.buildAssetId` 逻辑作为 fallback。
2. 先引入 `instrument_id` 字段到持仓/行情缓存表。
3. 逐步把读取路径改为：`input -> resolve -> instrument -> asset`。
4. 旧接口继续收 symbol/contract，但内部统一走 resolve。
5. 等覆盖率足够后再收敛旧逻辑。

---

## Recommendation for current codebase

当前 `apps/api/src/services/assetIdentity.ts` 已经有基础 asset id 规则，建议下一步不是继续堆 if/else，而是升级为：

- **Resolver service**：统一解析三类输入到 `asset_id + instrument_id`。
- **Per-market adapters**：spot/perps/prediction 分别实现 schema 与行情抓取。
- **Portfolio aggregation layer**：统一按 `asset_id` 汇总，按 `instrument_id`下钻。

这样能最大化复用你现有 market/wallet/agent 的链路，并减少未来接入新 venue 的改动面。
