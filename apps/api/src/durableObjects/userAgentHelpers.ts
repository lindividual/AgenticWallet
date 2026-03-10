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

export function mergePreferredAssets(
  eventAssets: string[],
  watchlistAssets: string[] = [],
  limit = 10,
): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const asset of [...watchlistAssets, ...eventAssets]) {
    const normalized = asset.trim().toUpperCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

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

export function buildFallbackDailyDigestMarkdown(
  date: string,
  eventSummary: EventSummary,
  localeCode: 'zh' | 'en' | 'ar' = 'zh',
  watchlistAssets: string[] = [],
): string {
  const items = Object.entries(eventSummary.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => `- ${key}: ${count}`)
    .join('\n');

  const mergedAssets = mergePreferredAssets(eventSummary.topAssets, watchlistAssets, 10);
  const assets = mergedAssets.length ? mergedAssets.join(' / ') : '';

  if (localeCode === 'ar') {
    return [
      `# التقرير اليومي ${date}`,
      '',
      '## ملخص اليوم',
      items || '- لا توجد تغييرات سلوكية ملحوظة اليوم',
      '',
      '## الأصول المتابعة',
      `- ${assets || 'لا توجد أصول مفضلة واضحة'}`,
      '',
      '## الإجراءات المقترحة',
      '- راقب تقلبات الأصول الأكثر متابعة.',
      '- تأكد من توافق الشبكة قبل التحويل.',
      '- فكر في إعداد تنبيهات الأسعار.',
    ].join('\n');
  }

  if (localeCode === 'en') {
    return [
      `# Daily Brief ${date}`,
      '',
      '## Today\'s Summary',
      items || '- No notable activity changes today',
      '',
      '## Watched Assets',
      `- ${assets || 'No clear asset preference yet'}`,
      '',
      '## Suggested Actions',
      '- Check volatility and liquidity of your most-watched assets.',
      '- Verify chain and network compatibility before transfers.',
      '- Consider setting price alerts if no trades are planned.',
    ].join('\n');
  }

  return [
    `# 每日专属日报 ${date}`,
    '',
    '## 今日摘要',
    items || '- 今日暂无关键行为变化',
    '',
    '## 关注资产',
    `- ${assets || '暂无明显偏好资产'}`,
    '',
    '## 可执行动作',
    '- 检查高频关注资产的波动与流动性。',
    '- 若计划转账，优先确认链与资产网络一致。',
    '- 若今日无交易计划，可先设置价格提醒。',
  ].join('\n');
}

export function buildFallbackRecommendations(
  userTopAssets: string[],
  portfolioHoldings: Array<{ symbol: string; valueUsd: number }>,
  marketAssets: Array<{
    symbol?: string;
    price_change_percentage_24h?: number | null;
    chain?: string;
  }>,
): RecommendationDraft[] {
  const recs: RecommendationDraft[] = [];
  const used = new Set<string>();

  const trendingCoin = marketAssets.find((a) => a.symbol && !used.has(a.symbol.toUpperCase()));
  if (trendingCoin?.symbol) {
    const sym = trendingCoin.symbol.toUpperCase();
    used.add(sym);
    const pct = trendingCoin.price_change_percentage_24h;
    const changeStr = pct != null ? `24h涨幅${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '近期表现活跃';
    recs.push({
      category: 'trending',
      asset: sym,
      reason: `${sym} 市场热门，${changeStr}，值得关注。`,
      score: 0.85,
    });
  }

  const topHolding = portfolioHoldings.find((h) => !used.has(h.symbol));
  if (topHolding) {
    used.add(topHolding.symbol);
    recs.push({
      category: 'portfolio',
      asset: topHolding.symbol,
      reason: `${topHolding.symbol} 是你持仓中价值最高的资产，建议持续关注走势。`,
      score: 0.82,
    });
  }

  const interest = userTopAssets.find((a) => !used.has(a));
  if (interest) {
    used.add(interest);
    recs.push({
      category: 'interest',
      asset: interest,
      reason: `${interest} 在你的近期行为中关注度最高，适合优先观察。`,
      score: 0.78,
    });
  }

  const secondTrending = marketAssets.find((a) => a.symbol && !used.has(a.symbol.toUpperCase()));
  if (secondTrending?.symbol) {
    const sym = secondTrending.symbol.toUpperCase();
    used.add(sym);
    recs.push({
      category: 'momentum',
      asset: sym,
      reason: `${sym} 在市场排行中表现突出，可作为短期交易机会。`,
      score: 0.75,
    });
  }

  const defaults = ['ETH', 'BNB', 'USDC', 'USDT', 'BTC'];
  const diversify = defaults.find((d) => !used.has(d));
  if (diversify) {
    used.add(diversify);
    recs.push({
      category: 'diversify',
      asset: diversify,
      reason: `${diversify} 是主流资产，适合用于分散投资组合风险。`,
      score: 0.72,
    });
  }

  while (recs.length < 5) {
    const fallback = defaults.find((d) => !used.has(d)) ?? 'ETH';
    used.add(fallback);
    recs.push({
      category: 'diversify',
      asset: fallback,
      reason: `${fallback} 是成熟的加密资产，适合纳入投资观察。`,
      score: 0.65,
    });
  }

  return recs.slice(0, 5);
}

const VALID_RECOMMENDATION_CATEGORIES = new Set([
  'trade', 'receive', 'send',
  'trending', 'portfolio', 'interest', 'diversify', 'momentum',
]);

export function parseLlmRecommendations(text: string): RecommendationDraft[] {
  const cleaned = extractJsonArray(text);
  if (!cleaned) return [];
  const parsed = safeJsonParse<unknown[]>(cleaned);
  if (!parsed || !Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const results: RecommendationDraft[] = [];

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const category = typeof row.category === 'string' ? row.category.trim().toLowerCase() : '';
    const asset = typeof row.asset === 'string' ? row.asset.trim().toUpperCase() : '';
    const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
    const score = typeof row.score === 'number' ? row.score : Number(row.score ?? 0);
    if (!VALID_RECOMMENDATION_CATEGORIES.has(category)) continue;
    if (!asset || !reason || !Number.isFinite(score)) continue;
    if (seen.has(asset)) continue;
    seen.add(asset);
    results.push({
      category,
      asset,
      reason,
      score: Math.max(0, Math.min(1, score)),
    });
    if (results.length >= 5) break;
  }

  return results;
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
