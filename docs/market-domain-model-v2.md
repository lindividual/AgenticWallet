# Market Domain Model v2

## 1. Summary

这版方案的核心结论是：

- `spot` 和 `perp` 仍然属于“资产驱动”的市场，应该保留在 `asset` 语义之下。
- `prediction` 不属于资产域，而属于“事件结果市场”域，不应该再映射成伪 `asset_id`。
- 全站真正需要统一的主键不是 `asset_id`，而是 `market_id`。
- `asset_id` 只服务于 underlying 聚合、钱包持仓、资产推荐。
- `market_id` 服务于详情页、K 线、交易、watchlist、搜索和持仓明细。

一句话：

`asset` 表示“是什么”，`market` 表示“在哪里被定价/交易”，`prediction` 表示“某个事件结果的交易市场”。

---

## 2. Why the Current Model Breaks on Prediction

当前模型把 `spot / perp / prediction` 全部压进同一套 `asset_id + instrument_id` 语义里，这对 `prediction` 会出现结构性错位：

1. `spot` 和 `perp` 的核心对象是 underlying asset。
2. `prediction` 的核心对象是 event / contract / option，而不是 underlying asset。
3. 预测市场中的 “YES / NO / Candidate A / Candidate B” 是结果选项，不是 canonical asset。
4. 把 outcome 写成 `asset_id` 会污染资产图谱，也会让聚合、推荐、风控语义变形。

因此，`prediction` 应从资产域中拆出，成为平行域模型。

---

## 3. Design Principles

### 3.1 Domain boundaries

- `Asset domain`: 真实经济标的。
- `Market domain`: 可展示、可交易、可收藏的统一市场入口。
- `Prediction domain`: 事件、市场合同、结果选项。

### 3.2 Identity principles

1. 名称和 symbol 不能作为主身份键。
2. 所有主键都必须 deterministic。
3. `asset_id` 和 `market_id` 不能混用。
4. `prediction` 的身份必须建立在 event/contract/option 或 execution key 之上。
5. 合约地址的 canonicalization 必须链级别区分，不能全局统一处理。

### 3.3 API principles

- 资产相关页面用 `asset_id`。
- 市场相关页面统一用 `market_id`。
- prediction 详情页通过 `prediction_event_id` 或 `market_id` 进入，不经过伪 `asset_id`。

---

## 4. Bounded Contexts

### 4.1 Asset Domain

`assets`

- `asset_id` (PK)
- `asset_class`
  - `crypto | fiat | equity | index`
- `symbol`
- `name`
- `logo_uri`
- `status`
- `created_at`
- `updated_at`

说明：

- 不再允许 `event_outcome` 作为 `asset_class`。
- `assets` 里只放真实 underlying。

建议的 `asset_id` 形式：

- `ast:crypto:cg:bitcoin`
- `ast:crypto:chain:eth:0xa0b8...`
- `ast:fiat:usd`
- `ast:equity:us:aapl`
- `ast:index:sp500`

规则：

- 优先使用高置信度、稳定的 canonical namespace。
- 如果没有可信 canonical mapping，则退回链上 identity。

### 4.2 Market Domain

`markets`

- `market_id` (PK)
- `market_type`
  - `spot | perp | prediction`
- `asset_id` (nullable)
- `display_symbol`
- `display_name`
- `image`
- `venue`
- `status`
- `created_at`
- `updated_at`

说明：

- `spot` / `perp` 的 `asset_id` 非空。
- `prediction` 的 `asset_id` 为空。
- `markets` 是所有前台入口的统一主表。

### 4.3 Spot Market Domain

`spot_markets`

- `market_id` (PK, FK -> markets.market_id)
- `asset_id` (FK -> assets.asset_id)
- `protocol`
  - `evm | svm`
- `chain`
  - `eth | base | bnb | sol | ...`
- `contract_key`
- `is_native`
- `decimals`

唯一约束：

- `UNIQUE(protocol, chain, contract_key)`

### 4.4 Perp Market Domain

`perp_markets`

- `market_id` (PK, FK -> markets.market_id)
- `venue`
- `market_key`
- `base_asset_id`
- `quote_asset_id`
- `settlement_asset_id`
- `symbol`
- `contract_type`
- `metadata_json`

唯一约束：

- `UNIQUE(venue, market_key)`

### 4.5 Prediction Domain

`prediction_events`

- `prediction_event_id` (PK)
- `venue`
- `event_key`
- `title`
- `description`
- `image`
- `url`
- `start_time`
- `end_time`
- `resolution_time`
- `status`
- `metadata_json`

唯一约束：

- `UNIQUE(venue, event_key)`

`prediction_contracts`

- `prediction_contract_id` (PK)
- `prediction_event_id` (FK)
- `venue`
- `contract_key`
- `title`
- `layout`
  - `binary | multi_option`
- `status`
- `url`
- `metadata_json`

唯一约束：

- `UNIQUE(venue, contract_key)`

`prediction_option_markets`

- `market_id` (PK, FK -> markets.market_id)
- `prediction_contract_id` (FK)
- `option_key`
- `label`
- `option_index`
- `trade_ref`
- `status`
- `metadata_json`

唯一约束：

- `UNIQUE(prediction_contract_id, option_key)`
- `UNIQUE(trade_ref)` when provider guarantees global uniqueness

说明：

- 这里的每一行都是真正可交易的 prediction market entry。
- 二元市场也不要再把 `YES/NO` 打包成一行；应该拆成两个 option market。
- 这样 `prediction` 就和 `spot/perp` 一样，都可以用 `market_id` 做详情页、K 线、watchlist、持仓明细。

---

## 5. Contract Key Canonicalization

这一节是强约束，不是实现细节。

### 5.1 `contract_key` is chain-specific

`contract_key` 不是“统一格式字符串”，而是“链级 canonical key”。

不同链的规则必须分开定义。

### 5.2 EVM rules

EVM `contract_key` 规则：

1. 去除首尾空格。
2. 校验为 20-byte hex address。
3. 统一转小写。
4. 原生 gas token 使用字面值 `native`。
5. 零地址不应作为 token contract；如果业务上表示原生资产，直接落 `native`。

例子：

- `0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`
  ->
  `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`
- Ethereum native
  ->
  `native`

### 5.3 SVM rules

SVM `contract_key` 规则：

1. 去除首尾空格。
2. 必须通过 `PublicKey` 校验。
3. 使用 `PublicKey(raw).toBase58()` 作为 canonical form。
4. 绝对不能 lower-case。
5. 绝对不能 slugify。
6. 原生 SOL 使用字面值 `native`。

这是因为：

- Solana mint address 是 base58，大小写敏感。
- 对 SOL token 做 `toLowerCase()` 会直接破坏 identity。

例子：

- `So11111111111111111111111111111111111111112`
  ->
  `So11111111111111111111111111111111111111112`
- SOL native
  ->
  `native`

### 5.4 Recommendation

建议把当前“contract normalize”从单函数语义改成：

- `canonicalizeContractKey(protocol, chain, raw)`

而不是：

- `normalizeContract(raw)`

因为后者容易误导成“所有链都能一样处理”。

---

## 6. `market_id` Definition

### 6.1 Design goals

`market_id` 的定义必须满足：

1. 稳定，可重复计算。
2. 表示“可展示/可交易对象”。
3. 不依赖文案标题。
4. 不依赖临时排序。
5. 能直接映射到一条 detail / kline / watchlist / position 记录。

### 6.2 Core rule

`market_id` 统一定义为：

- `mkt:<market_type>:<namespace>:<stable_key>`

其中：

- `<market_type>` 取值 `spot | perp | prediction`
- `<namespace>` 是该市场类型的身份域
- `<stable_key>` 是该市场在该身份域内的稳定键

### 6.3 Spot market ID

Spot 的 market identity 就是链上 token instance 本身。

格式：

- `mkt:spot:<chain>:<contract_key>`

例子：

- Ethereum native ETH
  ->
  `mkt:spot:eth:native`
- Base USDC
  ->
  `mkt:spot:base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Solana USDC
  ->
  `mkt:spot:sol:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

说明：

- Spot market 不应该以 provider 为身份来源。
- 同一个链上 token 在不同行情源下，仍然是同一个 `market_id`。

### 6.4 Perp market ID

Perp 的 identity 是 venue 内的合约市场。

格式：

- `mkt:perp:<venue>:<market_key>`

建议：

- 优先使用 venue 官方稳定 market key。
- 如果 provider 没有 market key，再用稳定 symbol。

例子：

- Hyperliquid BTC perp
  ->
  `mkt:perp:hyperliquid:BTC`

说明：

- `BTC-PERP` / `BTC-USD` 这类 display symbol 可以变，但 `market_key` 不应该跟着 UI 文案走。

### 6.5 Prediction market ID

Prediction 的 `market_id` 应该落在“可交易 option”上，而不是 event 或 contract 上。

优先规则：

1. 如果 provider 暴露稳定 execution key，例如 `token_id`、orderbook token key：
   - `market_id = mkt:prediction:<venue>:<execution_key>`
2. 如果没有 execution key，但有稳定的 `contract_key + option_key`：
   - `market_id = mkt:prediction:<venue>:<contract_key>:<option_key>`

例子：

- Polymarket YES option with token id
  ->
  `mkt:prediction:polymarket:1234567890`
- Generic prediction option fallback
  ->
  `mkt:prediction:somevenue:election-2028-president:yes`

为什么不用 `event_id`：

- 一个 event 下通常有多个 contract。
- 一个 contract 下通常有多个 option。
- 真正下单和画 K 线的对象是 option，不是 event。

### 6.6 Non-tradable prediction IDs

为了保持语义清晰，event 和 contract 也要有独立 ID，但它们不是 `market_id`。

建议形式：

- `prediction_event_id = pre:<venue>:<event_key>`
- `prediction_contract_id = prc:<venue>:<contract_key>`

这样：

- `prediction_event_id` 用于事件页
- `prediction_contract_id` 用于合同级聚合
- `market_id` 用于 option 详情、交易、K 线

---

## 7. Reference Tables

建议把当前 `instrument_refs` 拆成更清晰的两类：

### 7.1 `asset_refs`

- `provider`
- `provider_key`
- `asset_id`
- `confidence`

用途：

- CoinGecko coin id -> `asset_id`
- 链上 `(chain, contract_key)` -> `asset_id`

### 7.2 `market_refs`

- `provider`
- `provider_key`
- `market_id`
- `confidence`

用途：

- `hyperliquid + BTC` -> perp `market_id`
- `binance-stock + alpha_id` -> stock token `market_id`
- `polymarket + token_id` -> prediction `market_id`

---

## 8. Cross-Domain Linking

Prediction 仍然需要和资产域发生联系，但方式不应该是“伪装成资产”。

建议增加：

`subject_links`

- `source_type`
  - `prediction_event | prediction_contract | market`
- `source_id`
- `target_type`
  - `asset | topic`
- `target_id`
- `link_type`
  - `primary_subject | related_subject | hedge_candidate | basket_member`
- `confidence`

例子：

- 某个 BTC 价格预测事件
  ->
  link 到 `ast:crypto:cg:bitcoin`
- 某个 AI 板块选举类预测市场
  ->
  link 到多个资产或 topic

这样推荐和内容系统仍然可以跨域工作，但不会污染 `assets` 主表。

---

## 9. API Shape

### 9.1 Asset APIs

- `POST /v1/assets/resolve`
  - 只解析真实资产输入
  - 不再处理 prediction
- `GET /v1/assets/:assetId`
- `GET /v1/assets/:assetId/markets`

### 9.2 Market APIs

- `POST /v1/markets/resolve`
  - 输入任意 tradable source key
  - 输出 `market_id`
- `GET /v1/markets/:marketId`
- `GET /v1/markets/:marketId/candles`

### 9.3 Prediction APIs

- `GET /v1/prediction-events/:predictionEventId`
- `GET /v1/prediction-contracts/:predictionContractId`
- `GET /v1/prediction-events/:predictionEventId/markets`

说明：

- 前端详情路由统一落在 `market_id`
- prediction 事件页使用 `prediction_event_id`

---

## 10. Position Model

### 10.1 Wallet holdings

钱包资产持仓只面向真实资产：

- `asset_id`
- `market_id`
- `chain`
- `contract_key`
- `amount`
- `value_usd`

### 10.2 Prediction positions

预测仓位不并入 canonical asset holdings，而应单独存：

- `market_id`
- `prediction_contract_id`
- `prediction_event_id`
- `position_size`
- `avg_entry_price`
- `current_probability`
- `pnl`

这样：

- 钱包总资产聚合不会混入 event outcome
- prediction 账户仍可有独立资产页和 PnL 视图

---

## 11. Migration Direction

这不是“最小重构”，而是目标态重构方向。

### 11.1 Remove

- 从资产域中移除 `event_outcome`
- 移除 `prediction` 参与 `asset_id` resolve
- 移除 `prediction` 通过伪 `asset_id` 进入 `/v1/assets/*`

### 11.2 Introduce

- `markets`
- `spot_markets`
- `perp_markets`
- `prediction_events`
- `prediction_contracts`
- `prediction_option_markets`
- `asset_refs`
- `market_refs`
- `subject_links`

### 11.3 Route simplification

- 所有详情页统一走 `market_id`
- 所有 K 线统一走 `market_id`
- 资产聚合只走 `asset_id`
- prediction 事件页只走 prediction domain

---

## 12. Final Recommendation

推荐采用下面这套最简洁、长期可扩展的身份层次：

1. `asset_id`
   - 只表示真实 underlying
2. `market_id`
   - 只表示可交易市场对象
3. `prediction_event_id`
   - 只表示事件容器
4. `prediction_contract_id`
   - 只表示事件下合同

其中：

- `spot market` 是链上 token instance
- `perp market` 是 venue contract
- `prediction market` 是 option-level tradable outcome

最终统一原则：

- **资产统一看 `asset_id`**
- **交易统一看 `market_id`**
- **预测统一看 `prediction_event_id / prediction_contract_id / market_id`**

这比“所有东西都压成 asset/instrument”更合理，也更简洁。
