import type { MarketTopAsset } from '../services/bitgetWallet';
import type { SqlStorage } from './userAgentContentTypes';

type PortfolioSnapshotRow = {
  bucket_hour_utc?: string;
  total_usd?: number;
  holdings_json?: string;
};

type RecommendationAssetSnapshot = {
  assetId: string;
  symbol: string;
  chain: string | null;
  contract: string | null;
  name: string | null;
  image: string | null;
  priceChange24h: number | null;
};

export type DailyLanguage = {
  localeCode: 'zh' | 'en' | 'ar';
  outputLanguage: string;
  maxLengthRule: string;
  focusPoints: string;
};

export type RecommendationLanguage = {
  localeCode: 'zh' | 'en' | 'ar';
  outputLanguage: string;
  reasonLengthHint: string;
};

function pickPreferredMarketAsset(
  assets: MarketTopAsset[],
  preferredChain?: string | null,
): MarketTopAsset | null {
  if (assets.length === 0) return null;
  const normalizedPreferred = (preferredChain ?? '').trim().toLowerCase();
  const chainRank = new Map<string, number>([
    ['eth', 0],
    ['base', 1],
    ['bnb', 2],
  ]);
  const sorted = [...assets].sort((a, b) => {
    const aChainRank = chainRank.get((a.chain ?? '').trim().toLowerCase()) ?? 9;
    const bChainRank = chainRank.get((b.chain ?? '').trim().toLowerCase()) ?? 9;
    if (aChainRank !== bChainRank) return aChainRank - bChainRank;
    const aMarketCapRank = Number(a.market_cap_rank ?? Number.POSITIVE_INFINITY);
    const bMarketCapRank = Number(b.market_cap_rank ?? Number.POSITIVE_INFINITY);
    if (aMarketCapRank !== bMarketCapRank) return aMarketCapRank - bMarketCapRank;
    return Number(b.market_cap ?? 0) - Number(a.market_cap ?? 0);
  });
  if (!normalizedPreferred) return sorted[0];
  return sorted.find((asset) => (asset.chain ?? '').trim().toLowerCase() === normalizedPreferred) ?? sorted[0];
}

function getLatestPortfolioSnapshot(sql: SqlStorage): PortfolioSnapshotRow | null {
  const rows = sql
    .exec(
      `SELECT bucket_hour_utc, total_usd, holdings_json
       FROM portfolio_snapshots_hourly
       ORDER BY bucket_hour_utc DESC
       LIMIT 1`,
    )
    .toArray() as PortfolioSnapshotRow[];
  return rows[0] ?? null;
}

function getPortfolioChange24h(sql: SqlStorage): { currentUsd: number; previousUsd: number; changePercent: number } | null {
  const rows = sql
    .exec(
      `SELECT total_usd
       FROM portfolio_snapshots_hourly
       ORDER BY bucket_hour_utc DESC
       LIMIT 24`,
    )
    .toArray() as Array<{ total_usd?: number }>;
  if (rows.length < 2) return null;
  const current = Number(rows[0]?.total_usd ?? 0);
  const oldest = Number(rows[rows.length - 1]?.total_usd ?? 0);
  if (oldest === 0) return null;
  return {
    currentUsd: current,
    previousUsd: oldest,
    changePercent: ((current - oldest) / oldest) * 100,
  };
}

export function buildPortfolioContext(sql: SqlStorage): string {
  const snapshot = getLatestPortfolioSnapshot(sql);
  if (!snapshot) return 'Portfolio data: unavailable (new user or no portfolio sync yet).';

  const totalUsd = Number(snapshot.total_usd ?? 0);
  let holdingsSummary = '';
  try {
    const holdings = JSON.parse(snapshot.holdings_json ?? '[]') as Array<{
      symbol?: string;
      name?: string;
      chain_id?: number;
      value_usd?: number;
      amount?: string;
    }>;
    const top5 = holdings
      .filter((h) => Number(h.value_usd ?? 0) > 0)
      .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0))
      .slice(0, 5);
    if (top5.length > 0) {
      holdingsSummary = top5
        .map((h) => `${h.symbol ?? h.name ?? '???'}: $${Number(h.value_usd ?? 0).toFixed(2)}`)
        .join(', ');
    }
  } catch {
    // Ignore parse errors.
  }

  const change = getPortfolioChange24h(sql);
  const changeLine = change
    ? `24h change: ${change.changePercent >= 0 ? '+' : ''}${change.changePercent.toFixed(2)}% ($${change.previousUsd.toFixed(2)} → $${change.currentUsd.toFixed(2)})`
    : '24h change: insufficient data';

  return [
    `Total portfolio value: $${totalUsd.toFixed(2)}`,
    holdingsSummary ? `Top holdings: ${holdingsSummary}` : 'Top holdings: N/A',
    changeLine,
  ].join('\n');
}

export function buildRecommendationAssetLookup(marketAssets: MarketTopAsset[]): Map<string, RecommendationAssetSnapshot> {
  const bySymbol = new Map<string, MarketTopAsset[]>();
  for (const asset of marketAssets) {
    const symbol = (asset.symbol ?? '').trim().toUpperCase();
    if (!symbol) continue;
    const bucket = bySymbol.get(symbol);
    if (bucket) {
      bucket.push(asset);
    } else {
      bySymbol.set(symbol, [asset]);
    }
  }

  const lookup = new Map<string, RecommendationAssetSnapshot>();
  for (const [symbol, candidates] of bySymbol) {
    const selected = pickPreferredMarketAsset(candidates);
    if (!selected) continue;
    lookup.set(symbol, {
      assetId: selected.asset_id,
      symbol,
      chain: selected.chain ?? null,
      contract: selected.contract ?? null,
      name: selected.name ?? symbol,
      image: selected.image ?? null,
      priceChange24h: selected.price_change_percentage_24h ?? null,
    });
  }
  return lookup;
}

export function getPortfolioHoldings(
  sql: SqlStorage,
  supportedChains: Array<'eth' | 'base' | 'bnb'>,
): Array<{ symbol: string; valueUsd: number }> {
  const snapshot = getLatestPortfolioSnapshot(sql);
  if (!snapshot?.holdings_json) return [];
  const chainIdAllowlist = new Set<number>(
    supportedChains.map((chain) => (chain === 'eth' ? 1 : chain === 'base' ? 8453 : 56)),
  );
  try {
    const holdings = JSON.parse(snapshot.holdings_json) as Array<{
      symbol?: string;
      value_usd?: number;
      chain_id?: number;
    }>;
    return holdings
      .filter((h) => {
        const chainId = Number(h.chain_id ?? 0);
        return h.symbol && Number(h.value_usd ?? 0) > 0 && chainIdAllowlist.has(chainId);
      })
      .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0))
      .slice(0, 10)
      .map((h) => ({
        symbol: (h.symbol ?? '').toUpperCase(),
        valueUsd: Number(h.value_usd ?? 0),
      }));
  } catch {
    return [];
  }
}

export function resolveDailyLanguage(locale: string | null): DailyLanguage {
  const normalized = (locale ?? '').toLowerCase();
  if (normalized.startsWith('zh')) {
    return {
      localeCode: 'zh',
      outputLanguage: 'Simplified Chinese',
      maxLengthRule: 'approximately 400–600 Chinese characters',
      focusPoints: 'portfolio performance, market trends, news synthesis, social sentiment, user asset behavior, actionable suggestions, and risk awareness',
    };
  }
  if (normalized.startsWith('ar')) {
    return {
      localeCode: 'ar',
      outputLanguage: 'Arabic',
      maxLengthRule: 'approximately 300–450 words',
      focusPoints: 'portfolio performance, market trends, news synthesis, social sentiment, user asset behavior, actionable suggestions, and risk awareness',
    };
  }
  return {
    localeCode: 'en',
    outputLanguage: 'English',
    maxLengthRule: 'approximately 300–450 words',
    focusPoints: 'portfolio performance, market trends, news synthesis, social sentiment, user asset behavior, actionable suggestions, and risk awareness',
  };
}

export function resolveRecommendationLanguage(locale: string | null): RecommendationLanguage {
  const normalized = (locale ?? '').toLowerCase();
  if (normalized.startsWith('zh')) {
    return {
      localeCode: 'zh',
      outputLanguage: 'Simplified Chinese',
      reasonLengthHint: '每条不超过60个中文字符',
    };
  }
  if (normalized.startsWith('ar')) {
    return {
      localeCode: 'ar',
      outputLanguage: 'Arabic',
      reasonLengthHint: 'under 45 words each',
    };
  }
  return {
    localeCode: 'en',
    outputLanguage: 'English',
    reasonLengthHint: 'under 35 words each',
  };
}

export function buildDailyTitle(dateKey: string, localeCode: 'zh' | 'en' | 'ar'): string {
  if (localeCode === 'zh') return `日报 ${dateKey}`;
  if (localeCode === 'ar') return `التقرير اليومي ${dateKey}`;
  return `Daily ${dateKey}`;
}

export function buildDailySummary(markdown: string, localeCode: 'zh' | 'en' | 'ar'): string {
  const cleaned = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    if (localeCode === 'zh') return '今日日报已生成，点击查看详情。';
    if (localeCode === 'ar') return 'تم إنشاء تقرير اليوم. افتح القراءة للتفاصيل.';
    return "Today's daily is ready. Open to read details.";
  }

  const maxLength = localeCode === 'zh' ? 48 : localeCode === 'ar' ? 90 : 110;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength).trimEnd()}…`;
}
