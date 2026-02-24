import { safeJsonParse } from '../utils/json';

export type EventSummary = {
  counts: Record<string, number>;
  topAssets: string[];
};

export type RecommendationDraft = {
  category: string;
  asset: string;
  reason: string;
  score: number;
};

export function normalizeSqlString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  return null;
}

export function normalizeSqlNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function sanitizeLimit(input: number, min: number, max: number): number {
  if (!Number.isFinite(input)) return min;
  const normalized = Math.floor(input);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

export function normalizeOccurredAt(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function tomorrowDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return isoDate(d);
}

export function nextUtcHour(now: Date, hour: number): Date {
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

export function retryBackoffMs(retryCount: number): number {
  const base = 15_000;
  return base * Math.pow(2, retryCount - 1);
}

export function isRecommendationTriggerEvent(eventType: string): boolean {
  return new Set([
    'asset_holding_snapshot',
    'asset_viewed',
    'asset_favorited',
    'trade_buy',
    'trade_sell',
  ]).has(eventType);
}

export function summarizeEvents(events: Array<{ event_type: string; payload_json: string }>): EventSummary {
  const counts: Record<string, number> = {};
  const assetCounts: Record<string, number> = {};

  for (const event of events) {
    counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
    const payload = safeJsonParse<Record<string, unknown>>(event.payload_json) ?? {};
    const candidates = [payload.asset, payload.symbol, payload.token]
      .map((value) => (typeof value === 'string' ? value.trim().toUpperCase() : ''))
      .filter((value) => value.length >= 2 && value.length <= 16);
    for (const asset of candidates) {
      assetCounts[asset] = (assetCounts[asset] ?? 0) + 1;
    }
  }

  const topAssets = Object.entries(assetCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([asset]) => asset);

  return {
    counts,
    topAssets,
  };
}

export function buildFallbackDailyDigestMarkdown(date: string, eventSummary: EventSummary): string {
  const items = Object.entries(eventSummary.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => `- ${key}: ${count}`)
    .join('\n');

  const assets = eventSummary.topAssets.length ? eventSummary.topAssets.join(' / ') : '暂无明显偏好资产';

  return [
    `# 每日专属日报 ${date}`,
    '',
    '## 今日摘要',
    items || '- 今日暂无关键行为变化',
    '',
    '## 关注资产',
    `- ${assets}`,
    '',
    '## 可执行动作',
    '- 检查高频关注资产的波动与流动性。',
    '- 若计划转账，优先确认链与资产网络一致。',
    '- 若今日无交易计划，可先设置价格提醒。',
  ].join('\n');
}

export function buildFallbackTopicMarkdown(date: string, topic: string, eventSummary: EventSummary): string {
  const topAssets = eventSummary.topAssets.slice(0, 5).join(' / ') || '暂无';
  const majorEvents = Object.entries(eventSummary.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => `- ${name}: ${count}`)
    .join('\n');

  return [
    `# ${topic}（${date}）`,
    '',
    '## 核心观点',
    `- 当前用户行为集中在：${topAssets}。`,
    '',
    '## 机会与风险',
    majorEvents || '- 今日无显著新增行为数据。',
    '- 机会：围绕高频关注资产进行分批策略。',
    '- 风险：跨链与网络选择错误造成资金损耗。',
    '',
    '## 用户可执行动作',
    '- 在交易前先确认链、资产、滑点和手续费。',
    '- 对高波动资产设置分层价格提醒与仓位上限。',
  ].join('\n');
}

export function buildFallbackRecommendations(
  tradeAsset: string,
  receiveAsset: string,
  sendAsset: string,
): RecommendationDraft[] {
  return [
    {
      category: 'trade',
      asset: tradeAsset,
      reason: `${tradeAsset} 在你的近期行为中关注度最高，适合优先交易观察。`,
      score: 0.82,
    },
    {
      category: 'receive',
      asset: receiveAsset,
      reason: `${receiveAsset} 作为接收资产可提升后续资金归集效率。`,
      score: 0.75,
    },
    {
      category: 'send',
      asset: sendAsset,
      reason: `${sendAsset} 在你常用链路中流动性较好，适合作为发送资产。`,
      score: 0.7,
    },
  ];
}

export function parseLlmRecommendations(text: string): RecommendationDraft[] {
  const cleaned = extractJsonArray(text);
  if (!cleaned) return [];
  const parsed = safeJsonParse<unknown[]>(cleaned);
  if (!parsed || !Array.isArray(parsed)) return [];

  const normalized = parsed
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null;
      const row = item as Record<string, unknown>;
      const category = typeof row.category === 'string' ? row.category.trim() : '';
      const asset = typeof row.asset === 'string' ? row.asset.trim().toUpperCase() : '';
      const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
      const score = typeof row.score === 'number' ? row.score : Number(row.score ?? 0);
      if (!['trade', 'receive', 'send'].includes(category)) return null;
      if (!asset || !reason || !Number.isFinite(score)) return null;
      return {
        category,
        asset,
        reason,
        score: Math.max(0, Math.min(1, score)),
      };
    })
    .filter((item): item is RecommendationDraft => Boolean(item));

  const byCategory = new Map<string, RecommendationDraft>();
  for (const item of normalized) {
    if (!byCategory.has(item.category)) {
      byCategory.set(item.category, item);
    }
  }
  return ['trade', 'receive', 'send']
    .map((category) => byCategory.get(category))
    .filter((item): item is RecommendationDraft => Boolean(item));
}

export function buildArticleR2Key(
  userId: string,
  dateKey: string,
  type: 'daily' | 'topic',
  articleId: string,
  topic?: string,
): string {
  if (type === 'daily') {
    return `articles/${userId}/${dateKey}-daily-${articleId}.md`;
  }
  const topicPart = topic ? `-${slugify(topic)}` : '';
  return `articles/${userId}/${dateKey}-topic${topicPart}-${articleId}.md`;
}

export function normalizeR2Key(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('inline://')) {
    return value.slice('inline://'.length);
  }
  return value;
}

function extractJsonArray(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
