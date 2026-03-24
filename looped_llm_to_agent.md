# Looped LLM To Agent

## Goal

将当前“单轮 LLM 问答 + 少量特判动作”的聊天能力，演进为一个真正可多轮思考、多轮工具调用、最终再返回用户答案的 Agent runtime。

目标不是让模型输出显式的 `Thought -> Action -> Observation` 文本，也不是依赖 prompt 里的固定流程，而是让服务端提供一个隐藏的运行时循环：

- 模型按需决定是否调用工具
- 服务端执行工具并回灌结果
- 模型继续下一轮判断
- 在合适的时候输出最终回复和用户可见的 UI actions


## Design Principles

- 不暴露内部思考过程给用户
- 不把内部工具协议泄漏到聊天界面
- 不把所有动态数据都默认塞进 prompt
- 默认上下文只保留“轻量、稳定、常用”的信息
- 大而动态的数据通过工具按需读取
- 用户可点击选项属于 UI actions，不属于工具
- 有副作用的操作必须显式确认，不能由 loop 自动执行到底


## Non-Goal

- 不做显式 ReAct 文本协议
- 不让模型把 `Thought`、`Observation` 显示给用户
- 不把所有前端交互都改成工具
- 不把完整钱包、完整持仓、完整转账记录每轮默认注入


## Current State

当前项目中，Agent chat 的核心后端在：

- `apps/api/src/durableObjects/userAgentDO.ts`

当前已经有一个初步的 looped runtime 雏形：

- 模型每轮返回两种结构之一：
  - `tool_call`
  - `final`
- 服务端最多执行有限步数的循环
- 工具结果只进入隐藏上下文，不直接显示给用户
- 当前已接入的工具只有 `read_article`

这说明系统已经从“单次调用 + 补丁式特判”迈向“真正的多轮 runtime”，但仍然只是第一步。


## Runtime Model

### Internal Loop

建议统一采用服务端控制的隐藏循环：

1. 构造基础 system prompt
2. 注入轻量 ambient context
3. 把历史用户消息加入上下文
4. 调用模型
5. 解析模型输出
6. 如果输出是 `tool_call`，执行工具并将工具结果追加回隐藏上下文
7. 继续下一轮
8. 如果输出是 `final`，返回给前端
9. 超过最大步数时走兜底回复

### Runtime Output Contract

模型每轮只允许输出以下两类 JSON：

```json
{"type":"tool_call","tool":"tool_name","arguments":{}}
```

或：

```json
{"type":"final","reply":"string","actions":[]}
```

说明：

- `tool_call` 是模型和服务端 runtime 的内部协议
- `final.actions` 是服务端返回给前端的用户可见协议
- 两者必须严格分层，不能混用


## ReAct Position

本设计不是显式 ReAct。

这里不要求模型输出：

- `Thought`
- `Action`
- `Observation`

这些文本标签。

原因：

- 会增加格式脆弱性
- 容易把内部协议泄漏到 UI
- 用户不需要看到思考过程
- 我们真正需要的是 runtime 能力，而不是文字游戏

可以理解为：

- 保留 ReAct 的“多轮工具调用”能力
- 放弃 ReAct 的“显式文本思考协议”


## Context Strategy

不是所有上下文都应该变成工具。

建议把上下文分为三层：

### 1. Ambient Context

默认随每轮注入的轻量上下文。

适合放：

- 当前页面类型
- 当前实体标识
- 当前语言
- 当前交互模式
- 少量稳定且高频会用到的信息

例子：

- `page`
- `articleId`
- `tokenChain`
- `tokenContract`
- `tokenSymbol`
- `marketType`
- `marketItemId`
- `receiveMode`

原则：

- 小
- 稳定
- 高频
- 每轮几乎都值得带

### 2. Tool-Fetched Context

按需读取的动态上下文。

适合放：

- 正文类长文本
- 完整钱包数据
- 完整持仓明细
- 最近转账明细
- 历史行为明细
- token 深度数据
- 市场深度数据

原则：

- 大
- 动态
- 昂贵
- 不是每轮都需要

### 3. User-Facing UI Actions

不是上下文，也不是工具，而是最终答复里给前端展示的结构。

适合放：

- `quick_replies`
- `transfer_preview`
- 未来可能的 selector / confirm 类 action


## What Should Stay In Default Context

以下内容建议继续保留为默认上下文或轻量摘要：

- 当前页面和当前实体标识
- 当前 token 的基础身份信息
- receive flow 的基础模式信息
- 用户当前语言
- 支持的链和协议边界
- 少量用户画像摘要

这些信息是 Agent 理解当前语境的基础，不需要每次靠工具取。


## What Should Move To Tools

### Article Content

已验证适合工具化：

- 文章标题
- 摘要
- 相关资产
- 正文摘录

工具：

- `read_article`

### Token Deep Context

建议工具化：

- 实时价格
- 24h 变化
- watchlist 状态
- 风险审计
- K 线摘要
- 用户对该 token 的持仓情况

建议合并为一个统一工具：

- `read_token_context`

建议这个工具一次性返回：

- token 基础身份信息
- 实时价格与 24h 变化
- watchlist 状态
- 风险审计摘要
- K 线/走势摘要
- 用户当前仓位与持仓占比

原因：

- token 对话通常会同时需要价格、风险、走势、仓位
- 拆成多个工具会导致同一轮推理反复调用，增加延迟和 token 成本
- 对 Agent 来说，“读某个 token 的完整上下文”比“分别读价格、风险、仓位”更符合任务边界

只有当未来某些 token 子能力明显更重、更新频率明显不同、或权限边界不同，再考虑拆分独立工具

### Wallet / Address Context

建议工具化：

- 多链地址
- 余额明细
- 持仓列表
- 最近转账
- 地址间映射

候选工具：

- `read_wallet_context`
- `read_receive_addresses`
- `read_recent_transfers`

### Market Detail

建议工具化：

- 某个市场条目的完整详情
- 某个预测/合约/现货条目的扩展信息

候选工具：

- `read_market_item`


## Transfer Strategy

转账不能简单地全部做成内部工具然后自动完成。

建议拆两层：

### Internal Tools

用于获取或计算：

- `read_wallet_context`
- `read_receive_addresses`
- `resolve_asset`
- `quote_transfer`

### User-Facing Action

用于最终确认：

- `transfer_preview`

建议原则：

- Agent 可以自己查信息、补全参数、做报价
- 真正提交转账前，必须回到用户显式确认
- 不允许 loop 在没有用户确认的情况下直接执行有副作用的链上操作


## UI Actions Are Not Tools

UI actions 必须继续作为 `final.actions` 的一部分存在。

模型需要在 prompt 中被明确告知：

- 哪些 action 可用
- 在什么场景下该使用 action
- action 的 JSON 结构是什么
- action 只用于前端展示
- 内部工具不能伪装成 action

这意味着系统有两套协议：

### Internal Agent Runtime Protocol

用于模型和服务端之间：

- `tool_call`
- `final`

### Frontend UI Protocol

用于服务端和前端之间：

- `quick_replies`
- `transfer_preview`

两层协议不能混淆。


## User Summary Strategy

余额、持仓、最近转账、历史行为，不建议完整默认注入。

建议采用：

- 默认注入“用户摘要”
- 按需工具读取“用户明细”

### Summary Should Be Structured

不要先做自然语言摘要，建议先维护结构化对象，例如：

```json
{
  "generatedAt": "2026-03-24T10:00:00Z",
  "totalValueUsd": 12450,
  "topHoldings": [
    {"symbol":"ETH","weight":0.42},
    {"symbol":"USDC","weight":0.28},
    {"symbol":"BTC","weight":0.17}
  ],
  "stablecoinWeight": 0.31,
  "recentTransferCount7d": 3,
  "recentTradeCount7d": 5,
  "watchlistTopSymbols": ["ETH", "SOL", "ENA"],
  "behaviorTags": ["active_trader", "holds_large_eth_position"]
}
```

聊天时只把它压缩成几行 prompt，避免每轮现算和现写。

### Summary Refresh Strategy

建议使用“事件驱动 + 定时兜底”的混合模式。

#### Event-Driven Update

在以下事件后增量更新摘要：

- 交易完成
- 转账完成
- 收藏资产
- 查看资产
- 持仓快照写入

#### Scheduled Refresh

在以下维度定时刷新：

- 价格相关摘要
- 持仓占比相关摘要
- 行为标签整理

建议频率：

- 价格相关：1 到 6 小时
- 行为/偏好标签：6 到 24 小时

### Summary vs Detail

建议边界：

- 默认 context 里放摘要
- 工具里放明细

即：

- 默认让 LLM 对用户“有感觉”
- 需要细节时再查


## Suggested First Tool Set

第一批建议做成工具的内容：

1. `read_article`
2. `read_token_context`
3. `read_wallet_context`
4. `read_receive_addresses`
5. `read_market_item`
6. `quote_transfer`
7. `read_recent_transfers`

优先级建议：

### P1

- `read_token_context`
- `read_wallet_context`
- `read_receive_addresses`

### P2

- `quote_transfer`
- `read_recent_transfers`
- `read_market_item`

### P3

- `read_user_activity`
- `read_watchlist_detail`


## Safety Rules

- 最大 loop 步数必须有限制
- 工具失败时必须有兜底回复
- 不允许内部协议出现在用户 UI
- 不允许内部工具伪装成用户可点击 action
- 有副作用的操作必须显式确认
- 大文本工具结果必须截断
- 工具结果进入隐藏上下文，不进入聊天消息列表


## Implementation Direction

### Phase 1

完成基础 runtime：

- `tool_call / final` 双结构
- 服务端 loop
- 工具注册表
- 工具执行分发
- UI action 和内部工具分层

### Phase 2

扩展只读工具：

- token
- wallet
- receive addresses
- market item
- recent transfers

### Phase 3

扩展有副作用但需确认的工具链：

- 参数补全
- transfer quote
- preview generation
- explicit confirm

### Phase 4

引入用户摘要状态：

- 结构化用户画像
- 事件驱动更新
- 定时价格刷新
- 聊天层按需读取摘要


## Final Recommendation

Agent 的长期方向应当是：

- 默认依赖轻量 ambient context
- 通过 runtime 按需读取工具
- 用 `final.actions` 驱动前端交互
- 用结构化用户摘要提供稳定的用户画像

不要继续把越来越多动态数据硬塞进 system prompt，也不要用显式 ReAct 文本协议来模拟思考过程。

我们要构建的是一个真正的 Agent runtime，而不是一个“提示词里写了很多流程”的聊天机器人。
