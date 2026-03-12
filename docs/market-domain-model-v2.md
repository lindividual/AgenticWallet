# Market Domain Model v2

## 1. Summary

这版方案不再追求把 `coin / perps / prediction` 全部压成一套抽象一致的身份模型，而是明确拆成三类：

1. `coin`
   - 包括 native coin 和 token
   - 使用 `coingecko asset id + chain + contract(如有)`
2. `perps`
   - 直接沿用 Hyperliquid 的 id
3. `prediction`
   - 直接沿用 Polymarket 的 id

这样拆的原因很直接：

- `coin` 需要 canonical asset id 来做跨链聚合
- `perps` 的真实身份是交易所 market
- `prediction` 的真实身份是预测市场条目

不应该再强行创造一个抽象统一但语义不自然的“万能 market id”。

---

## 2. Core Decision

### 2.1 Coin

`coin` 的身份拆成两层：

- `asset_id`
  - 表示“这是什么资产”
  - 用于聚合
- `chain + contract`
  - 表示“这个资产在什么链上的哪个实例”
  - 用于交易、转账、余额、详情、K 线

推荐形式：

- 优先：
  - `asset_id = coingecko:<coin_id>`
- fallback：
  - `asset_id = chain:<chain>:<contract_or_native>`
- `coin_ref = { asset_id, chain, contract? }`

例子：

- Ethereum 主网原生 ETH
  - `asset_id = coingecko:ethereum`
  - `chain = eth`
  - `contract = native`
- Base 原生 ETH
  - `asset_id = coingecko:ethereum`
  - `chain = base`
  - `contract = native`
- Ethereum 主网 USDC
  - `asset_id = coingecko:usd-coin`
  - `chain = eth`
  - `contract = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`

### 2.2 Perps

`perps` 直接使用上游交易所 id，不再试图映射成 asset-first 身份。

推荐形式：

- `perp_id = hyperliquid:<market_id>`

如果 Hyperliquid 当前稳定 id 就是 symbol，也可以暂时直接使用：

- `hyperliquid:BTC`
- `hyperliquid:ETH`

前提是：

- 这个 id 在 Hyperliquid 内是稳定的
- 页面、K 线、详情、下单都可以用它唯一定位

### 2.3 Prediction

`prediction` 直接使用 Polymarket 的 id。

推荐形式：

- `prediction_id = polymarket:<id>`

这里的 `<id>` 必须选择你们在产品里真正用来打开详情、获取 K 线、下单或切换市场的那一个稳定 id。

注意：

- 不要把 prediction outcome 映射成 `asset_id`
- prediction 不属于资产域

---

## 3. Why Coin Needs `asset_id + chain + contract`

这是这版方案里最重要的设计点。

### 3.1 Why `asset_id` is needed

`coin` 需要 `asset_id`，是因为你们要做资产聚合。

比如 ETH：

- Ethereum 原生 ETH
- Base 原生 ETH
- 未来其他链上的 canonical ETH 表示

这些都应该聚合成一个资产视角：

- `asset_id = coingecko:ethereum`

这样：

- 钱包总资产可以按 ETH 聚合
- 推荐和内容可以按 ETH 聚合
- trade 列表可以只显示一个 ETH 入口

### 3.2 Why `chain + contract` is still needed

只用 `asset_id` 不够，因为交易和余额必须落到具体实例上。

比如：

- `coingecko:ethereum + eth + native`
- `coingecko:ethereum + base + native`

两者的 underlying 相同，但：

- 所在链不同
- 余额不同
- 转账路径不同
- 可交互协议不同
- 流动性和执行环境不同

所以 coin 的真实业务 identity 不是单独一个字段，而是：

- 聚合 identity: `asset_id`
- 实例 identity: `asset_id + chain + contract`

---

## 4. Recommended Identity Model

### 4.1 Coin identity

#### Asset-level

优先规则：

- `asset_id = coingecko:<coin_id>`

fallback 规则：

- `asset_id = chain:<chain>:<contract_or_native>`

例子：

- `coingecko:ethereum`
- `coingecko:bitcoin`
- `coingecko:usd-coin`
- `coingecko:solana`
- `chain:base:0x1234...`
- `chain:sol:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

#### Instance-level

推荐定义为：

- `coin_instance_key = <asset_id>|<chain>|<contract_or_native>`

例子：

- `coingecko:ethereum|eth|native`
- `coingecko:ethereum|base|native`
- `coingecko:usd-coin|eth|0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`
- `coingecko:usd-coin|sol|EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

这个 key 不一定要单独暴露成产品文案中的“id 字符串”，但在后端内部应该能 deterministic 地构造出来。

### 4.1.1 What if CoinGecko does not know the coin

如果一个 coin 没有被 CoinGecko 收录，不应该让整个模型失败。

处理规则：

1. 先尝试获取 `coingecko:<coin_id>`
2. 如果没有可信 CoinGecko 映射，则回退为链上 asset id：
   - `chain:eth:<contract>`
   - `chain:base:<contract>`
   - `chain:bnb:<contract>`
   - `chain:sol:<mint>`
3. native coin 仍然优先使用显式内置 canonical 映射
4. 没有 CoinGecko id 的 coin，先不做自动跨链聚合

这意味着：

- 交易、K 线、详情、余额不会受影响
- 资产聚合仍然可用，但通常只在单链内高置信成立
- 当未来出现 CoinGecko 映射或人工映射时，再把 `chain:*` asset 迁移到 canonical asset

### 4.2 Perp identity

- `perp_id = hyperliquid:<id>`

例子：

- `hyperliquid:BTC`
- `hyperliquid:ETH`

### 4.3 Prediction identity

- `prediction_id = polymarket:<id>`

例子：

- `polymarket:12345`

如果未来 Polymarket 里存在 event id、market id、token id 三层，需要只选一种作为产品主身份，不要混用。

标准是：

- 哪个 id 最适合打开详情、获取 K 线、下单，就用哪个

---

## 5. SOL / SVM Contract Rules

这是本方案里的硬规则。

### 5.1 Rule

SOL 的 token contract 绝对不能使用 EVM 风格的 normalize 逻辑。

也就是：

- 不能 lower-case
- 不能 hex 化
- 不能 slugify

### 5.2 Canonical form

SVM token contract 的 canonical form 应该是：

- `PublicKey(raw).toBase58()`

native SOL 使用：

- `native`

例子：

- USDC on Solana
  - `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Wrapped SOL mint
  - `So11111111111111111111111111111111111111112`
- Native SOL
  - `native`

### 5.3 Why

因为 Solana mint address 是 base58，大小写敏感。

如果套用 EVM 的 address normalize：

- 同一个 mint 会被错误改写
- 资产 identity 会直接损坏

所以 contract canonicalization 必须是链感知的：

- EVM
  - lowercase hex or `native`
- SVM
  - base58 canonical string or `native`

---

## 6. Trade Page Rule

### 6.1 Trade page is not driven by one universal key

Trade 页不应该再强求只有一个统一主键。

应该使用 discriminated union：

```ts
type TradeItemRef =
  | {
      kind: 'coin';
      asset_id: string;
      chain: string;
      contract: string | 'native';
    }
  | {
      kind: 'perp';
      perp_id: string;
    }
  | {
      kind: 'prediction';
      prediction_id: string;
    };
```

### 6.2 Coin in trade page

Trade 页里的 `coin` 有两层：

- 列表层
  - 以 `asset_id` 聚合
  - 默认显示一个 ETH、一个 BTC、一个 SOL
- 交易层 / 详情层
  - 落到具体 `chain + contract`

也就是说：

- 列表里显示一个 ETH
- 点进去之后再进入
  - Ethereum ETH
  - Base ETH
  - 其他链上对应实例

### 6.3 Perp in trade page

Perp 直接按 `perp_id` 展示和跳转。

### 6.4 Prediction in trade page

Prediction 直接按 `prediction_id` 展示和跳转。

---

## 7. Data Schema

### 7.1 `coin_assets`

- `asset_id` (PK)
- `coingecko_id` (nullable)
- `symbol`
- `name`
- `image`
- `status`
- `created_at`
- `updated_at`

约束：

- `asset_id` 允许两种形式：
  - `coingecko:<coin_id>`
  - `chain:<chain>:<contract_or_native>`
- `UNIQUE(coingecko_id)` for non-null rows

### 7.2 `coin_instances`

- `coin_instance_key` (PK)
- `asset_id` (FK -> coin_assets.asset_id)
- `chain`
- `protocol`
- `contract`
- `is_native`
- `decimals`
- `metadata_json`
- `created_at`
- `updated_at`

约束：

- `UNIQUE(asset_id, chain, contract)`

说明：

- 这里的 `contract` 对原生 coin 固定为 `native`
- 对 Solana token，必须存 canonical base58 mint

### 7.3 `perp_markets`

- `perp_id` (PK)
- `venue`
- `display_symbol`
- `name`
- `image`
- `base_asset_id` (nullable)
- `quote_asset_id` (nullable)
- `metadata_json`
- `created_at`
- `updated_at`

说明：

- `perp_id` 直接沿用 Hyperliquid id
- 如果需要，可以补 `base_asset_id`
- 但它不承担主身份职责

### 7.4 `prediction_markets`

- `prediction_id` (PK)
- `venue`
- `title`
- `description`
- `image`
- `url`
- `status`
- `metadata_json`
- `created_at`
- `updated_at`

说明：

- `prediction_id` 直接沿用 Polymarket id
- 不写入 `asset_id`

### 7.5 `subject_links`

- `source_type`
  - `perp | prediction`
- `source_id`
- `target_asset_id`
- `link_type`
  - `underlying | related | basket_member`
- `confidence`

用途：

- perp 关联到 underlying asset
- prediction 关联到 BTC / ETH / SOL / topic

这样推荐和内容系统还能跨域工作，但不会污染 coin 聚合模型。

---

## 8. API Shape

### 8.1 Coin APIs

- `GET /v1/coins/:assetId`
- `GET /v1/coins/:assetId/instances`
- `POST /v1/coins/resolve`
  - 输入：`chain + contract`
  - 输出：`asset_id + chain + contract`

### 8.2 Perp APIs

- `GET /v1/perps/:perpId`
- `GET /v1/perps/:perpId/candles`

### 8.3 Prediction APIs

- `GET /v1/predictions/:predictionId`
- `GET /v1/predictions/:predictionId/candles`

### 8.4 Trade feed API

- `GET /v1/trade/feed`

输出返回 discriminated union：

```ts
type TradeFeedItem =
  | {
      kind: 'coin';
      asset_id: string;
      symbol: string;
      name: string;
      image: string | null;
      preferred_instance: {
        chain: string;
        contract: string | 'native';
      } | null;
    }
  | {
      kind: 'perp';
      perp_id: string;
      symbol: string;
      name: string;
      image: string | null;
    }
  | {
      kind: 'prediction';
      prediction_id: string;
      title: string;
      image: string | null;
    };
```

---

## 9. External Data Flow Simplification

这版模型的一个重要收益，是可以显著简化外部数据获取流程。

当前复杂度的根源，不只是 provider 多，而是：

- 每个 route 都在临时做身份归一化
- 每个页面入口都在现场拼 detail / icon / fallback
- `coin / perps / prediction` 三类数据被迫走同一套抽象桥接逻辑

采用本方案后，外部数据流应改成“按域固定”，而不是“按页面临时拼”。

### 9.1 Core principle

把流程拆成三条固定 pipeline：

1. `coin pipeline`
2. `perp pipeline`
3. `prediction pipeline`

每条 pipeline 只负责：

- 抓取
- 标准化
- 落库 / 投影

route 层只读投影，不再现场重新做 identity stitching。

### 9.2 Coin pipeline

`coin` 的数据流分成两层：

#### Asset layer

职责：

- 提供 canonical asset metadata
- 提供 `coingecko asset id`
- 提供 symbol / name / image / 基础 rank

推荐来源：

- `CoinGecko`

产出：

- `coin_assets`

#### Instance layer

职责：

- 提供链上实例级 detail
- 提供价格、K 线、余额可定位的 `chain + contract`
- 提供 decimals / liquidity / holder metrics 等实例属性

推荐来源：

- EVM token detail / kline：`Bitget` 或其他链上 token provider
- Solana token detail / price：`Jupiter`
- Wallet balances：`SIM` + `Solana RPC`

产出：

- `coin_instances`

#### Coin route rule

route 层只做：

- 读 `coin_assets`
- 读 `coin_instances`
- 按请求场景返回数据

不再做：

- 现场 `resolve -> enrich -> fallback -> merge`

### 9.3 Perp pipeline

`perps` 不再经过 asset-first resolver。

职责：

- 直接抓 Hyperliquid market 列表
- 直接使用 Hyperliquid id
- 直接落 `perp_markets`

推荐来源：

- `Hyperliquid`

route 层只做：

- 读 `perp_markets`
- 返回 detail / candles / browse / search

如果需要 underlying 关联：

- 通过 `subject_links`
- 而不是把 perp 主身份改写成 coin identity

### 9.4 Prediction pipeline

`prediction` 不再经过 coin/asset resolver。

职责：

- 直接抓 Polymarket market 列表
- 直接使用 Polymarket id
- 直接落 `prediction_markets`

推荐来源：

- `Polymarket`

route 层只做：

- 读 `prediction_markets`
- 返回 detail / candles / browse / search

如果需要关联 BTC / ETH / SOL / topic：

- 通过 `subject_links`
- 而不是把 prediction outcome 伪装成 `asset_id`

### 9.5 Recommended provider ownership

建议明确 provider ownership，避免同一个字段在多个 route 中反复临时拼接。

#### Coin

- Canonical asset metadata：
  - `CoinGecko`
- EVM token detail：
  - `Bitget`
- EVM token candles：
  - `Bitget`
- EVM candle fallback：
  - `Binance Web3`
- Solana token metadata / price：
  - `Jupiter`
- EVM wallet balances：
  - `SIM`
- Solana wallet balances：
  - `Solana RPC`

#### Perps

- Browse / detail / candles：
  - `Hyperliquid`

#### Prediction

- Browse / detail / candles：
  - `Polymarket`

### 9.6 Route simplification target

重构后的理想状态是：

- `/v1/coins/*`
  - 只读 coin projection
- `/v1/perps/*`
  - 只读 perp projection
- `/v1/predictions/*`
  - 只读 prediction projection
- `/v1/trade/feed`
  - 从三套 projection 聚合列表，不做现场身份改写

### 9.7 What can be removed

按这个模型，很多“热路径上的临时统一化逻辑”都可以收敛掉：

- route 层批量 resolve identity
- route 层临时补 icon
- route 层把 provider id 先转成内部 id、再回退成 provider id
- prediction 进入 coin/asset 解析链路
- perp 先映射成统一资产模型、再回退到 venue id

### 9.8 Net result

最终外部数据流会从：

- “页面驱动的数据拼接”

变成：

- “领域驱动的数据投影”

这会带来三个直接收益：

1. route 更薄
2. provider 责任更清晰
3. `coin / perps / prediction` 的复杂度彼此隔离，不会相互污染

---

## 10. ETH Example

### 10.1 Asset-level

- ETH 的资产聚合 id：
  - `coingecko:ethereum`

### 10.2 Instance-level

- Ethereum native ETH
  - `asset_id = coingecko:ethereum`
  - `chain = eth`
  - `contract = native`
- Base native ETH
  - `asset_id = coingecko:ethereum`
  - `chain = base`
  - `contract = native`

这意味着：

- 钱包总览里，它们都可以聚合成 ETH
- trade 列表里，也可以先只显示一个 ETH
- 但交易和详情必须区分实例

---

## 11. Final Recommendation

最终推荐的落地方式就是你刚才提出的这版：

1. `coin`
   - `coingecko asset id + chain + contract`
2. `perps`
   - 沿用 Hyperliquid id
3. `prediction`
   - 沿用 Polymarket id

同时明确：

- `coin` 用 `asset_id` 做聚合
- `coin` 用 `chain + contract` 做实例定位
- `perps` 和 `prediction` 不再强行塞进 coin/asset 语义

这是比“统一抽象 market id”更合理、更简洁、也更符合当前数据源形态的方案。
