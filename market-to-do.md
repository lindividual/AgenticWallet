# Market Roadmap TODO

## Phase 2: 个性化重排（持仓 + 行为）

### 目标
- 在不改变货架定义的前提下，对每个货架内 token 做用户级排序。
- 支持可解释打分，便于后续 A/B 和回溯。

### 后端任务
- [ ] 新增用户偏好聚合服务：按用户计算 `chain/sector/risk/capTier` 偏好分。
- [ ] 从已有数据源提取用户信号并加权：
- 持仓快照（portfolio snapshots）信号。
- 行为事件（`asset_viewed`, `asset_favorited`, `trade_buy`, `trade_sell`）信号。
- [ ] 新增偏好快照表（建议）：
- `user_preference_profile(user_id, profile_json, computed_at)`。
- [ ] 在 `fetchMarketShelves` 增加可选 `userId` 入参并做重排。
- [ ] 为每个推荐资产返回 `score_breakdown`（例如 `affinity/momentum/liquidity/riskPenalty`）。
- [ ] 新增开关（env）：`MARKET_PERSONALIZATION_ENABLED=true|false`。

### API 任务
- [ ] 扩展 `GET /v1/market/shelves`：
- 支持 `personalized=true`（默认 true，匿名或关闭时回退 false）。
- 响应增加 `rankingMode`（`personalized|market_only`）。
- [ ] 新增调试接口（仅开发）：`GET /v1/market/shelves/debug-score` 查看打分明细。

### 前端任务
- [ ] Trade 页货架请求改为 `personalized=true`。
- [ ] 在卡片上增加轻量解释文案（如“Based on your Base + Meme preference”）。
- [ ] 增加“关闭个性化”开关（用于对照体验和排障）。

### 验证任务
- [ ] 单元/集成测试：无行为用户、重度行为用户、仅持仓用户三类 case。
- [ ] 埋点校验：点击率、详情页打开率、买卖点击率。
- [ ] A/B 方案：`market_only` vs `personalized`。

### 交付标准
- [ ] 同一用户重复请求 30 分钟内排序稳定（无重大抖动）。
- [ ] 个性化模式相对基线 CTR 提升达到预期阈值（由产品确认）。

## Phase 3: 社区语言与地域细分货架（zh/ja/en）

### 目标
- 支持“中文 meme / 日本社区 meme / 某链 meme / 主流 DeFi”等更细分货架。
- 标签来源可追踪、可回滚。

### 数据与标签任务
- [ ] 扩展 `token_taxonomy` 使用方式：
- `sector`：meme/defi/l1/ai 等。
- `language`：zh/ja/en/unknown。
- `tags_json`：`community:cn`, `community:jp`, `narrative:*` 等。
- [ ] 建立标签流水线（每日/每小时）：
- CoinGecko 项目元数据。
- OpenNews / OpenTwitter 文本信号（现有接入）。
- 规则 + LLM 双通道判别并输出置信度。
- [ ] 新增标签回填任务：把热门 token 的 `token_taxonomy` 补齐。

### 货架扩展任务
- [ ] 在 `market_shelf_configs` 新增细分货架 seed：
- `meme_cn_trending`
- `meme_jp_trending`
- `defi_bluechips_eth`
- `defi_bluechips_base`
- [ ] 支持按 taxonomy 过滤（不仅是 CoinGecko `category`）。
- [ ] 支持“主榜单候选 + taxonomy 二次筛选 + 个性化重排”三段式流水。

### 风控与质量任务
- [ ] 新增质量阈值过滤：最小流动性、最小 24h 成交量、最小池龄（如可得）。
- [ ] 高风险 token 标记降权或出货架。
- [ ] 增加异常监控：空货架率、标签漂移、语言误判率。

### 前端任务
- [ ] Trade 页支持折叠/展开更多细分货架。
- [ ] 货架标题与副标题本地化（zh/en/ar 至少覆盖当前语言包）。
- [ ] 细分货架可配置展示顺序（按用户偏好或运营配置）。

### 验证任务
- [ ] 标签准确率抽样评估（zh/ja/en）。
- [ ] 细分货架点击/转化对比通用货架。
- [ ] 线上回滚预案：一键退回 Phase 2 仅个性化模式。

### 交付标准
- [ ] 细分货架覆盖主流语言社区并稳定出数。
- [ ] 标签与推荐链路可解释、可审计、可回滚。
