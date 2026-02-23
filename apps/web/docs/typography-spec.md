# 全应用字号规范（Typography）

## 1. 目标与范围
- 本文档是 Web 端唯一字号规范来源，适用于所有页面与组件。
- 页面文档只能做“映射示例”，不能定义新的字号体系。

## 2. 字体栈
- 使用全局字体栈（见 `apps/web/src/index.css`）：
  - `Inter, General Sans, Noto Sans SC, PingFang SC, Noto Sans Arabic, sans-serif`

## 3. 字号 Token（Tailwind 语义）
- `text-sm`（14px）
  - 用途：辅助信息、注释、弱化文案。
  - 常用搭配：`font-normal` + `text-base-content/50~60`。
- `text-base`（16px）
  - 用途：默认正文、通用按钮文案、列表主文案。
  - 常用搭配：正文 `font-normal`，重点值 `font-semibold`。
- `text-lg`（18px）
  - 用途：二级区块标题。
  - 常用搭配：`font-bold`。
- `text-xl`（20px）
  - 用途：一级区块标题、重要状态提示。
  - 常用搭配：标题 `font-bold`；状态 `font-medium`/`font-semibold`。
- `text-2xl`（24px）
  - 用途：页面主标题。
  - 常用搭配：`font-bold`。
- `text-4xl`（36px）
  - 用途：核心指标大数字（如总资产、总额）。
  - 常用搭配：`font-bold leading-none`。

## 4. 字重规范
- `font-bold`：页面标题、区块标题、关键数值。
- `font-semibold`：按钮文案、列表主信息、强调值。
- `font-normal`：常规正文。

## 5. 行高与字距
- 大数字（`text-4xl`）：使用 `leading-none`。
- 正文（`text-base`）：默认行高；较长段落可用 `leading-snug`。
- 标题：默认 tracking；页面主标题可使用 `tracking-tight`。

## 6. 使用规则
- 单一信息块最多使用 2 种字号，减少层级噪音。
- 非关键文案不超过 `text-base`。
- 辅助文案统一 `text-sm`，避免混用 `text-xs`。
- 新需求优先复用上述 token；若要新增字号级别，需先更新本规范。

## 7. 响应式建议
- 默认保持 token 不变，仅在极小屏（<=375px）收紧间距与组件尺寸。
- 不建议按页面单独缩放字号，优先通过布局与留白调整可读性。
