# Agent Implementation TODO Plan & Spec

## 1. TODO Plan

### Phase 0: 基础设施准备（1-2 天）
1. 在 Worker 中新增 `UserAgentDO` 绑定与 migrations 配置。
2. 约定 `user_id -> Durable Object ID` 映射：`idFromName(user_id)`。
3. 定义统一事件入口：`/v1/agent/events`（持仓、访问、收藏、买卖、阅读、页面停留）。
4. 定义 Agent 输出目录规范（R2 或对象路径风格）：`articles/{user_id}/{yyyy-mm-dd}-{type}.md`。

### Phase 1: 专属文章能力（日报 + 专题）（4-6 天）
1. 实现 `ContentPipeline`：新闻抓取、去重、打标、摘要、生成 Markdown。
2. 每日定时触发日报（Cron -> DO RPC），DO 内写入文章索引与状态。
3. 事件驱动专题（大行情/用户关注资产异动/热点主题）。
4. 提供文章查询 API：列表、详情、已读、收藏。
5. 前端接入“日报卡片 + 专题流 + Markdown 渲染”。

### Phase 2: 资产推荐能力（3-4 天）
1. 在 DO 内实现推荐引擎输入聚合（持仓、访问、收藏、买卖）。
2. 输出三类推荐：`trade`、`receive`、`send`，附推荐理由与分数。
3. 实现“最快每日更新；用户无新活动则跳过更新”策略。
4. 提供推荐查询 API 与推荐反馈 API（不感兴趣/已持有/已交易）。

### Phase 3: 页面停留引导 + 对话（4-5 天）
1. 前端上报页面停留事件（超过 2s 触发 evaluate）。
2. DO 基于页面 + 支持链 + 用户上下文生成引导文案。
3. 建立实时通道（优先 WebSocket）推送引导消息。
4. 接入多轮会话（同一 DO 保存用户会话上下文与最近意图）。

### Phase 4: 稳定性与增长验证（3-5 天）
1. 增加幂等、重试、去重与限流。
2. 补充监控指标（生成成功率、推送成功率、CTR、转化）。
3. 加 A/B 开关（不同提示词、推荐策略、触发阈值）。
4. 完成压测与回归测试，准备灰度上线。

## 2. Spec（设计文档）

### 2.1 目标与范围
1. 每个用户有一个专属 Agent 实例（逻辑隔离、状态隔离、请求隔离）。
2. Agent 提供三项能力：专属文章、资产推荐、实时指引与对话。
3. 输出以 Markdown 与结构化数据存储，前端可拉取可订阅。

### 2.2 架构总览
1. `API Worker (Hono)`：鉴权、HTTP 路由、事件接收、转发到 DO。
2. `UserAgentDO`：每用户唯一实例，负责该用户的状态机、调度、规则与实时会话。
3. `News Ingest Worker/Cron`：周期拉取行业新闻，做清洗与主题归类。
4. `Storage`：
   - DO SQLite：用户级强一致状态与近期输出索引。
   - R2：Markdown 正文（日报/专题）。
   - D1（可选 V1.5+）：跨用户统计与运营分析索引。
5. `Realtime`：WebSocket（主）+ SSE（可选只读推送）。

### 2.3 用户隔离策略
1. DO ID 规则：`env.USER_AGENT.idFromName(user_id)`。
2. 所有用户行为和输出只进入对应 DO。
3. Worker 层做鉴权，禁止任意 `user_id` 越权访问。

### 2.4 功能规格

#### 2.4.1 专属文章
1. 输入：持有资产、访问资产、收藏资产、阅读记录、文章收藏记录、行业新闻流。
2. 输出：
   - 每日日报（每天至少一次）。
   - 不定期专题（事件驱动）。
   - 格式为 Markdown。
3. 更新策略：
   - 日报：每日固定时刻生成。
   - 专题：当事件阈值触发或用户相关度达到阈值。
4. 存储：
   - 正文在 R2：`articles/{user_id}/{date}-daily.md`、`articles/{user_id}/{date}-topic-{slug}.md`。
   - DO SQLite 保存元数据：标题、摘要、标签、来源、生成时间、版本、状态。

#### 2.4.2 资产推荐
1. 输入：持有、访问、收藏、买入、卖出。
2. 输出：推荐资产列表，字段包含 `asset_name`、`recommend_reason`、`category`、`score`。
3. 分类：`trade`、`receive`、`send`。
4. 更新策略：
   - 最快每天更新一次。
   - 若用户无新增活动且市场无显著变化，则不更新。

#### 2.4.3 页面指引与对话
1. 触发：用户在页面停留超过 2 秒且无操作。
2. 输入：当前页面、钱包支持链、最近上下文。
3. 输出：引导提示（可进一步对话）。
4. 对话：同一用户会话上下文保存在该用户 DO，支持连续提问。

### 2.5 DO 内部数据模型（SQLite）
1. `user_profile`：`user_id`, `risk_level`, `preferred_chains`, `updated_at`。
2. `user_events`：`event_id`, `type`, `payload_json`, `occurred_at`, `dedupe_key`。
3. `article_index`：`article_id`, `type(daily|topic)`, `title`, `summary`, `r2_key`, `tags`, `created_at`, `status`。
4. `article_interactions`：`article_id`, `read_at`, `is_favorited`。
5. `recommendations`：`rec_id`, `category`, `asset`, `reason`, `score`, `generated_at`, `valid_until`。
6. `guide_prompts`：`prompt_id`, `page`, `content`, `created_at`, `expires_at`。
7. `chat_messages`：`msg_id`, `role`, `content`, `ts`, `session_id`。
8. `jobs`：`job_id`, `job_type`, `run_at`, `status`, `retry_count`（用于单 alarm 队列）。

### 2.6 API 契约（V1）
1. `POST /v1/agent/events`：写入用户行为事件。
2. `GET /v1/agent/articles?type=daily|topic&cursor=`：文章列表。
3. `GET /v1/agent/articles/:articleId`：文章详情（返回 md_url 或直出内容）。
4. `POST /v1/agent/articles/:articleId/favorite`：文章收藏。
5. `GET /v1/agent/recommendations`：当前推荐。
6. `POST /v1/agent/recommendations/feedback`：推荐反馈。
7. `POST /v1/agent/guide/evaluate`：传入页面停留信息，返回是否触发引导。
8. `GET /v1/agent/ws`：WebSocket 实时通道（指引推送 + 对话）。
9. `POST /v1/agent/chat`：HTTP 兜底对话（无 WS 时）。

### 2.7 实时通信协议（WebSocket）
1. 客户端上行事件：`heartbeat`, `page_dwell`, `chat_user_message`, `ack`。
2. 服务端下行事件：`guide_prompt`, `chat_agent_message`, `article_ready`, `recommendation_ready`, `error`。
3. 必带字段：`event_id`, `timestamp`, `trace_id`，支持幂等与重放保护。

### 2.8 调度与任务模型
1. 每 DO 仅一个 alarm，采用 `jobs` 最小堆/最早时间队列模式。
2. 定时任务类型：`daily_digest`, `recommendation_refresh`, `cleanup`。
3. 失败重试：指数退避，超过阈值写 dead-letter 标记。

### 2.9 一致性与可靠性
1. 幂等键：事件写入与任务执行都带 `dedupe_key`。
2. 生成任务状态机：`queued -> running -> succeeded|failed`。
3. 外部依赖失败时降级：返回最近一次成功推荐/指引模板。

### 2.10 安全与合规
1. API 必须鉴权并校验 `user_id` 与 token 绑定关系。
2. 敏感字段加密或脱敏存储。
3. 对话与推荐结果保留审计字段：`trace_id`, `model_version`, `prompt_version`。

### 2.11 监控指标
1. 内容：日报生成成功率、打开率、阅读时长、收藏率。
2. 推荐：点击率、交易转化率、反馈负向率。
3. 指引：触发率、交互率、完成率。
4. 系统：DO 错误率、队列积压、生成延迟、WS 在线数。

### 2.12 验收标准（DoD）
1. 每个登录用户可稳定拿到专属日报与推荐。
2. 页面停留超过 2 秒可触发可解释的引导。
3. 同一用户的状态和输出不会串到其他用户。
4. API、WS、定时任务均有可观测性与重试机制。
