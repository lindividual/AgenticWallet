# Stablecoin Abstraction

本文定义 Agentic Wallet 的稳定币抽象与跨网络转账方案，目标是让用户优先关注“对方最终收到什么”，同时保留必要的网络控制权与风险确认。

## 1. 目标

我们要解决的问题不是单纯的 bridge，也不是单纯的 transfer，而是：

1. 用户希望给某个地址发送稳定币。
2. 用户希望明确“最终到账网络”。
3. 用户不希望被迫先理解 source chain、bridge route、fee token、approve、settlement 这些中间概念。
4. 系统需要根据用户资产情况自动判断：
   - 是否可以同链直转
   - 是否需要单源跨链
   - 是否需要多源归集
   - 是否根本余额不足

## 2. 产品原则

### 2.1 用户优先选择目标网络

主流程应以 destination-first 组织：

1. 输入收款地址
2. 选择目标网络
3. 选择目标资产
4. 输入到账金额或支出金额
5. 系统给出推荐资金来源
6. 用户确认或手动修改来源网络

原因：

- 用户更关心“对方最后在哪里收到”。
- 对钱包用户来说，“转出网络”通常是手段，不是目标。
- 错误链转账的主要风险发生在目标网络而不是源网络。

### 2.2 网络不能硬隐藏

虽然系统负责抽象复杂度，但网络必须在两个阶段明确展示：

1. 用户选择目标网络时
2. 最终确认页

确认页至少要明确写出：

- 最终到账网络
- 最终到账币种
- 实际扣款网络
- 预估到账数量
- 手续费承担方式
- 预计到账时间

### 2.3 单源/多源不由用户先选

单源还是多源不应该是首屏决策，而应是系统的规划结果。

系统根据资产情况输出：

- `direct`
- `single_source_bridge`
- `multi_source_bridge`
- `insufficient_balance`

## 3. 稳定币抽象层

### 3.1 Canonical Asset

系统内部不应只把稳定币视为“某条链上的某个合约地址”，而应同时维护：

1. `canonicalAsset`
   - 例如 `USDT`
   - 例如 `USDC`
2. `networkAsset`
   - 例如 `ethereum-mainnet / USDT / 0xdAC17...`
   - 例如 `arbitrum-mainnet / USDT / 0xFd086...`
3. `holding`
   - 用户在某网络资产上的真实可用余额

也就是说：

- `USDT` 是抽象资产
- `Arbitrum USDT` 是目标交付资产
- `Ethereum USDT` / `BNB USDT` 是潜在 source assets

### 3.2 Canonical Mapping

第一版建议只覆盖最常用稳定币：

1. `USDT`
2. `USDC`

并维护一个 canonical mapping 表：

| canonical | networkKey | contract |
| --- | --- | --- |
| USDT | ethereum-mainnet | `0xdAC17F...` |
| USDT | arbitrum-mainnet | `0xFd086...` |
| USDT | bnb-mainnet | `0x55d398...` |
| USDC | ethereum-mainnet | `0xA0b869...` |
| USDC | arbitrum-mainnet | `0xaf88d0...` |
| USDC | bnb-mainnet | `0x8AC76a...` |

后续可以扩展到：

- Base
- Optimism
- Polygon
- USDT0 / bridged variants / canonical variants

## 4. 用户体验模型

### 4.1 用户输入

建议新增一条独立于当前 `/transfer` 的意图式流程：

- 收款地址
- 目标网络
- 目标稳定币
- 金额
- 可选：来源网络

说明：

- “来源网络”默认由系统推荐。
- 用户可以展开手动修改。
- 若用户不改，系统自动使用推荐值。

### 4.2 结果表达

quote 返回给用户时，应按“最终到账”来组织，而不是按 bridge route 来组织。

推荐展示：

1. 对方将收到：`100 USDT on Arbitrum`
2. 系统将从：`Ethereum USDT` 扣款
3. 路径：`Bridge + settle`
4. 预计时间：`2-6 min`
5. 费用：`sponsored` 或 `paid in USDT`

当系统进入多源模式时，再展开展示：

- `60 USDT from Ethereum`
- `40 USDT from BNB Chain`

## 5. Planner 设计

### 5.1 输入

```ts
type StablecoinTransferIntent = {
  toAddress: string;
  destinationNetworkKey: string;
  destinationToken: 'USDT' | 'USDC';
  amount: string;
  preferredSourceNetworkKey?: string;
};
```

### 5.2 输出

```ts
type StablecoinTransferPlan = {
  executionMode: 'direct' | 'single_source_bridge' | 'multi_source_bridge' | 'insufficient_balance';
  destination: {
    networkKey: string;
    tokenSymbol: string;
    amountRaw: string;
  };
  recommendedSourceNetworkKey: string | null;
  sources: Array<{
    networkKey: string;
    tokenAddress: string;
    amountRaw: string;
  }>;
  estimatedReceiveRaw: string;
  shortfallRaw: string;
  routeSummary: string[];
};
```

### 5.3 决策顺序

Planner 应按以下顺序决策：

1. 目标链余额是否足够
   - 是：`direct`
2. 是否存在一个单一来源链可以独立覆盖
   - 是：`single_source_bridge`
3. 是否多个来源链合计可以覆盖
   - 是：`multi_source_bridge`
4. 否则
   - `insufficient_balance`

### 5.4 优先级

当存在多个候选 source network 时，建议按以下顺序排序：

1. 用户显式指定的来源网络
2. 目标链本地余额
3. 已支持 sponsor / fee abstraction 的路线
4. 总成本最低
5. 到账时间最短
6. 成功率最高

## 6. 执行策略

### 6.1 第一阶段 MVP

第一阶段只真正执行：

1. `direct`
2. `single_source_bridge`

对于 `multi_source_bridge`：

- 第一版先允许 planner 识别
- 先向用户展示“需要多来源归集”
- 暂不自动执行

原因：

- 多源执行的状态跟踪复杂度远高于单源
- 一旦有多条腿，失败恢复、到账确认、UI 文案都会复杂很多
- 不适合和第一版跨链转账一起上线

### 6.2 第二阶段

第二阶段再支持：

- `multi_source_bridge`
- 多腿状态跟踪
- 多腿失败重试
- 汇总级父任务状态

## 7. 推荐执行引擎

### 7.1 主方案：Biconomy

推荐主方案使用 Biconomy 的 cross-chain intent / supertransaction 能力。

原因：

1. 当前项目已经在 EVM 钱包层接入 Biconomy：
   - multichain account
   - MEE / 7702
2. 可以延续现有账号模型
3. 更容易支持 sponsor 或 fee token 支付
4. 对用户来说更接近“无需准备原生 gas”

适合的执行模式：

- 优先 sponsorship
- 次选 fee token

### 7.2 备选方案：Bitget Wallet Order Mode

Bitget Wallet 可作为第二执行引擎或 fallback。

原因：

1. 项目中已经接了 Bitget Wallet 的 market/security API
2. 同一供应商扩展成本较低
3. 对跨链 swap / transfer 也有成熟能力

但它更适合作为：

- fallback route provider
- 某些链或稳定币对的补充支持

不建议在第一版里同时把 Biconomy 和 Bitget 都做成同级主路线。

## 8. 后端接口建议

### 8.1 新增领域，不复用旧 `/transfer`

不要把跨链稳定币转账硬塞进现有 `/v1/transfer/*`。

建议新增：

1. `POST /v1/stablecoin-transfer/plan`
2. `POST /v1/stablecoin-transfer/submit`
3. `GET /v1/stablecoin-transfer/:id`

### 8.2 Plan 接口

输入：

- 目标网络
- 目标币种
- 金额
- 收款地址
- 可选来源网络

输出：

- `executionMode`
- 推荐来源网络
- 估计到账数
- 费用
- 时间
- 是否可直接提交

### 8.3 Submit 接口

第一阶段提交仅允许：

- `direct`
- `single_source_bridge`

若 planner 结果是 `multi_source_bridge`，返回：

- 需要多来源归集
- 当前版本不可直接执行

## 9. 状态模型

建议引入父任务模型：

```ts
type StablecoinTransferJob = {
  id: string;
  status: 'planned' | 'submitted' | 'settling' | 'completed' | 'failed';
  executionMode: 'direct' | 'single_source_bridge' | 'multi_source_bridge';
};
```

并在其下挂 legs：

```ts
type StablecoinTransferLeg = {
  id: string;
  jobId: string;
  sourceNetworkKey: string;
  destinationNetworkKey: string;
  status: 'created' | 'submitted' | 'source_confirmed' | 'settled' | 'failed';
  txHash: string | null;
};
```

关键点：

- bridge 不能只看 source tx submitted
- 父任务完成条件应是 destination settle 完成

## 10. 风险与确认

以下场景必须强确认：

1. 收款地址是 CEX 充值地址
2. 目标网络与地址类型不匹配
3. 多源归集
4. 预计到账金额与目标金额偏差过大
5. 费用不是 sponsor，而是从稳定币中扣取

## 11. UI 建议

### 11.1 默认展示

- 收款地址
- 最终到账网络
- 最终到账稳定币
- 到账数量
- 推荐来源网络
- 预计到账时间

### 11.2 高级展开

- 实际来源网络
- bridge provider
- sponsor / fee token 策略
- 预估 source 扣款数量
- slippage / minimum receive

### 11.3 文案建议

避免直接对用户说：

- “你要 bridge 吗？”
- “请选择 source chain”
- “请选择 fee token”

建议改成：

- “对方最终在哪条链收到？”
- “系统建议从 Ethereum USDT 扣款”
- “预计 2-6 分钟到账”
- “手续费由系统赞助” 或 “手续费将从 USDT 中扣除”

## 12. 分阶段落地建议

### Phase 1

1. 实现 canonical stablecoin mapping
2. 实现 destination-first planner
3. 实现 `direct` + `single_source_bridge`
4. UI 中加入目标网络优先流程

### Phase 2

1. 支持 `multi_source_bridge`
2. 支持多腿状态跟踪
3. 支持失败腿重试
4. 优化路线比较与智能推荐

### Phase 3

1. 支持更多稳定币
2. 支持目标到账优先与成本优先两种模式
3. 对常用联系人记住目标网络偏好

## 13. 最终建议

最终建议是：

1. 产品层采用 destination-first
2. 网络不硬隐藏，但只让用户显式决定必要网络
3. 单源/多源由系统规划，不由用户先选
4. 第一版先支持 `direct` 和 `single_source_bridge`
5. 主执行引擎优先选择 Biconomy
6. Bitget Wallet 作为备选或 fallback

这样既能减少用户理解成本，又不会牺牲资金安全与可解释性。
