import { generateWithLlm, getLlmErrorInfo, getLlmStatus } from '../services/llm';
import type { MarketTopAsset } from '../services/bitgetWallet';
import { getSupportedMarketChains } from '../config/appConfig';
import { fetchTopMarketAssets } from '../services/marketTopAssets';
import { fetchOpenNewsCryptoNews, fetchOpenTwitterCryptoTweets, type NewsItem, type TweetItem } from '../services/openNews';
import {
  buildArticleR2Key,
  isoDate,
  mergePreferredAssets,
  summarizeEvents,
  tomorrowDate,
} from './userAgentHelpers';
import {
  buildDailySummary,
  buildDailyTitle,
  buildPortfolioContext,
  resolveDailyLanguage,
  type DailyLanguage,
} from './userAgentContentHelpers';
import { fetchNewsHeadlines } from './userAgentRss';
import { putArticleMarkdownContent } from './userAgentArticleContentStore';
import type { ContentDeps } from './userAgentContentTypes';

const MARKET_DISCOVERY_NEWS_KEYWORDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'crypto',
  'stablecoin',
  'etf',
  'fed',
  'rates',
];
const MARKET_DISCOVERY_TWITTER_KEYWORDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'crypto',
  'etf',
  'stablecoin',
  'risk-on',
  'risk-off',
];
const STABLECOIN_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'USDS', 'TUSD', 'FRAX', 'PYUSD']);
const BLUECHIP_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'TRX', 'AVAX', 'LINK', 'TON']);
const MEME_SYMBOLS = new Set([
  'DOGE',
  'SHIB',
  'PEPE',
  'WIF',
  'BONK',
  'FLOKI',
  'BRETT',
  'MOG',
  'POPCAT',
  'BOME',
  'TURBO',
  'TRUMP',
  'FARTCOIN',
]);

type PortfolioHolding = {
  symbol: string;
  name: string;
  valueUsd: number;
  chainId: number | null;
};

type AssetClass = 'stable' | 'major' | 'meme' | 'alt';

type UserContextSignals = {
  contextStrength: 'strong' | 'partial' | 'weak';
  summary: string;
  facts: string[];
  stableShare: number;
  majorShare: number;
  highBetaShare: number;
  topHoldingShare: number;
  tradeCount: number;
  viewCount: number;
  favoriteCount: number;
  articleReadCount: number;
};

type LocaleContext = {
  preferredLocale: string;
  outputLanguage: string;
  regionHint: string;
  timezoneHint: string;
  localeConfidence: 'explicit' | 'fallback';
};

type OpportunityCandidate = {
  symbol: string;
  chain: string;
  assetClass: AssetClass;
  currentPrice: number | null;
  change24h: number | null;
  score: number;
  isHeld: boolean;
  isWatchlisted: boolean;
  isInteracted: boolean;
  isDiscovery: boolean;
  sourceTags: string[];
  reason: string;
};

type RiskSignal = {
  title: string;
  detail: string;
};

export async function generateDailyDigestContent(_payload: Record<string, unknown>, deps: ContentDeps): Promise<void> {
  const ownerUserId = deps.getOwnerUserId();
  if (!ownerUserId) {
    throw new Error('owner_user_not_initialized');
  }

  const now = new Date();
  const dateKey = isoDate(now);
  const hasTodayArticle = deps.sql
    .exec(
      `SELECT id
       FROM article_index
       WHERE article_type = 'daily'
         AND created_at >= ?
         AND created_at < ?
       LIMIT 1`,
      `${dateKey}T00:00:00.000Z`,
      `${tomorrowDate(dateKey)}T00:00:00.000Z`,
    )
    .toArray()[0];

  if (hasTodayArticle) return;

  const recentEvents = deps.getLatestEvents(80);
  const eventSummary = summarizeEvents(recentEvents);
  const watchlistSymbols = (deps.getWatchlistAssets?.(30) ?? [])
    .map((item) => item.symbol.trim().toUpperCase())
    .filter(Boolean);
  const preferredAssets = mergePreferredAssets(eventSummary.topAssets, watchlistSymbols, 10);
  const preferredLocale = deps.getPreferredLocale?.() ?? null;
  const language = resolveDailyLanguage(preferredLocale);
  const localeContext = buildLocaleContext(preferredLocale, language);
  const portfolioContext = buildPortfolioContext(deps.sql);
  const llmStatus = getLlmStatus(deps.env);
  const supportedChains = getSupportedMarketChains();
  const holdings = getPortfolioHoldingsFromSnapshot(deps.sql);
  const topHoldingSymbols = holdings.slice(0, 8).map((item) => item.symbol);

  const userCoins = mergePreferredAssets(preferredAssets, topHoldingSymbols, 8).slice(0, 6);
  const searchKeywords = userCoins.length > 0 ? userCoins : ['bitcoin', 'ethereum', 'crypto'];

  const [
    newsHeadlinesResult,
    userNewsResult,
    marketNewsResult,
    userTwitterResult,
    marketTwitterResult,
    topGainersResult,
    topLosersResult,
    trendingResult,
    marketCapResult,
  ] = await Promise.allSettled([
    fetchNewsHeadlines(deps.env),
    fetchOpenNewsCryptoNews(deps.env, { keywords: searchKeywords, limit: 8 }),
    fetchOpenNewsCryptoNews(deps.env, { keywords: MARKET_DISCOVERY_NEWS_KEYWORDS, limit: 10 }),
    fetchOpenTwitterCryptoTweets(deps.env, { keywords: searchKeywords, limit: 6 }),
    fetchOpenTwitterCryptoTweets(deps.env, { keywords: MARKET_DISCOVERY_TWITTER_KEYWORDS, limit: 6 }),
    fetchTopMarketAssets(deps.env, { name: 'topGainers', limit: 12, source: 'auto', chains: supportedChains }),
    fetchTopMarketAssets(deps.env, { name: 'topLosers', limit: 8, source: 'auto', chains: supportedChains }),
    fetchTopMarketAssets(deps.env, { name: 'trending', limit: 12, source: 'auto', chains: supportedChains }),
    fetchTopMarketAssets(deps.env, { name: 'marketCap', limit: 40, source: 'auto', chains: supportedChains }),
  ]);

  const newsHeadlines = newsHeadlinesResult.status === 'fulfilled' ? newsHeadlinesResult.value : [];
  const userNewsItems = dedupeNewsItems(userNewsResult.status === 'fulfilled' ? userNewsResult.value : []);
  const marketNewsItems = dedupeNewsItems(marketNewsResult.status === 'fulfilled' ? marketNewsResult.value : []);
  const twitterItems = dedupeTweetItems([
    ...(userTwitterResult.status === 'fulfilled' ? userTwitterResult.value : []),
    ...(marketTwitterResult.status === 'fulfilled' ? marketTwitterResult.value : []),
  ]);
  const topGainers = topGainersResult.status === 'fulfilled' ? topGainersResult.value : [];
  const topLosers = topLosersResult.status === 'fulfilled' ? topLosersResult.value : [];
  const trendingAssets = trendingResult.status === 'fulfilled' ? trendingResult.value : [];
  const marketCapAssets = marketCapResult.status === 'fulfilled' ? marketCapResult.value : [];
  const metadataAssets = dedupeMarketAssets([...topGainers, ...topLosers, ...trendingAssets, ...marketCapAssets]);
  const assetLookup = buildMarketAssetLookup(metadataAssets);
  const userSignals = buildUserContextSignals({
    holdings,
    watchlistSymbols,
    eventSummary,
    assetLookup,
  });
  const opportunityCandidates = buildOpportunityCandidates({
    topGainers,
    trendingAssets,
    marketCapAssets,
    holdings,
    watchlistSymbols,
    eventSummary,
    userSignals,
    assetLookup,
  });
  const riskSignals = buildRiskSignals({
    topLosers,
    holdings,
    watchlistSymbols,
    userSignals,
    assetLookup,
  });

  let markdown = buildDailyDigestFallbackMarkdown({
    dateKey,
    language,
    userSignals,
    portfolioContext,
    eventSummary,
    watchlistSymbols,
    userNewsItems,
    marketNewsItems,
    newsHeadlines,
    opportunityCandidates,
    riskSignals,
  });
  if (llmStatus.enabled && metadataAssets.length > 0) {
    try {
      const llmResult = await generateWithLlm(deps.env, {
        messages: [
          {
            role: 'system',
            content: buildDailyDigestSystemPrompt(language),
          },
          {
            role: 'user',
            content: buildDailyDigestUserPrompt(
              dateKey,
              ownerUserId,
              eventSummary,
              watchlistSymbols,
              newsHeadlines,
              portfolioContext,
              language,
              localeContext,
              userNewsItems,
              marketNewsItems,
              twitterItems,
              metadataAssets,
              holdings,
              userSignals,
              opportunityCandidates,
              riskSignals,
            ),
          },
        ],
        temperature: 0.5,
        maxTokens: 2000,
      });
      markdown = llmResult.text;
    } catch (error) {
      const llmError = getLlmErrorInfo(error);
      console.error('daily_digest_llm_failed', {
        ...llmError,
        llm: llmStatus,
      });
    }
  }

  const title = buildDailyTitle(dateKey, language.localeCode);
  const summary = buildDailySummary(markdown, language.localeCode);
  const articleId = crypto.randomUUID();
  const createdAt = now.toISOString();

  const r2Key = buildArticleR2Key(ownerUserId, dateKey, 'daily', articleId);
  await putArticleMarkdownContent(deps.env, articleId, r2Key, markdown);
  deps.sql.exec(
    `INSERT INTO article_index (
      id,
      article_type,
      title,
      summary,
      r2_key,
      tags_json,
      created_at,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    articleId,
    'daily',
    title,
    summary,
    r2Key,
    JSON.stringify(['daily', 'personalized']),
    createdAt,
    'ready',
  );
}

function buildDailyDigestSystemPrompt(language: DailyLanguage): string {
  return [
    `You are the senior editor of a crypto wallet daily brief.`,
    `Write entirely in ${language.outputLanguage}.`,
    ``,
    `Goal: help the user notice relevant market changes and possible new opportunities without sounding like an ad or a trading signal service.`,
    ``,
    `Guidelines:`,
    `- Write like a restrained market editor, not a salesperson and not a chatbot.`,
    `- First decide whether the available user context is strong, partial, or weak.`,
    `- If context is strong, write a personalized brief tied to the user's holdings, watchlist, or behavior.`,
    `- If context is partial, write a lightly personalized brief and be explicit that the signal is limited.`,
    `- If context is weak, write a starter market brief for a new or quiet user. Do not pretend to know the user's style.`,
    `- Lead with the single most relevant opportunity or market change for the level of context available.`,
    `- Always explain why the topic matters to this user when reliable evidence exists.`,
    `- Use locale context for language, timing, and relevance framing only.`,
    `- Do NOT infer investment style from region alone.`,
    `- Use editorial verbs like watch, track, compare, keep on the list, or pay attention to.`,
    `- Avoid explicit calls to buy, sell, ape, enter, exit, or chase.`,
    `- Synthesize across portfolio, market movers, news, and social signals instead of listing raw inputs.`,
    `- If evidence is mixed, say it is one to watch rather than forcing a strong recommendation.`,
    `- Keep the structure crisp and useful. No long market recap.`,
    `- Use markdown formatting naturally.`,
    `- Do NOT fabricate price data or percentages. Only reference data provided to you.`,
  ].join('\n');
}

function buildDailyDigestUserPrompt(
  dateKey: string,
  ownerUserId: string,
  eventSummary: { counts: Record<string, number>; topAssets: string[] },
  watchlistSymbols: string[],
  newsHeadlines: string[],
  portfolioContext: string,
  language: DailyLanguage,
  localeContext: LocaleContext,
  userNewsItems: NewsItem[] = [],
  marketNewsItems: NewsItem[] = [],
  twitterItems: TweetItem[] = [],
  marketAssets: MarketTopAsset[] = [],
  holdings: PortfolioHolding[] = [],
  userSignals: UserContextSignals,
  opportunityCandidates: OpportunityCandidate[] = [],
  riskSignals: RiskSignal[] = [],
): string {
  const eventLines = Object.entries(eventSummary.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, count]) => `  ${type}: ${count}`)
    .join('\n');

  const allNews = formatNewsLines([...userNewsItems, ...marketNewsItems], newsHeadlines, 12);

  const twitterSection = twitterItems.length > 0
    ? twitterItems
        .slice(0, 6)
        .map((t) => `- @${t.handle || t.author}: "${t.text.slice(0, 180)}" (❤${t.likes} 🔁${t.retweets})`)
        .join('\n')
    : '';

  const marketSection = marketAssets.length > 0
    ? marketAssets
        .slice(0, 8)
        .map((a) => {
          const change = a.price_change_percentage_24h != null
            ? ` (24h: ${Number(a.price_change_percentage_24h) >= 0 ? '+' : ''}${Number(a.price_change_percentage_24h).toFixed(2)}%)`
            : '';
          const price = a.current_price != null
            ? `$${Number(a.current_price).toPrecision(4)}`
            : 'Price N/A';
          return `- ${a.symbol}: ${price}${change}`;
        })
        .join('\n')
    : '';
  const holdingSection = holdings.length > 0
    ? holdings
        .slice(0, 6)
        .map((holding) => `- ${holding.symbol}: $${holding.valueUsd.toFixed(2)}`)
        .join('\n')
    : 'No recent holdings snapshot.';
  const signalSection = [
    `Context strength: ${userSignals.contextStrength}`,
    `Summary: ${userSignals.summary}`,
    `Stable share: ${(userSignals.stableShare * 100).toFixed(0)}%`,
    `Major share: ${(userSignals.majorShare * 100).toFixed(0)}%`,
    `Higher-beta share: ${(userSignals.highBetaShare * 100).toFixed(0)}%`,
    `Top holding share: ${(userSignals.topHoldingShare * 100).toFixed(0)}%`,
    `Trades: ${userSignals.tradeCount}, views: ${userSignals.viewCount}, favorites: ${userSignals.favoriteCount}, article reads: ${userSignals.articleReadCount}`,
    ...userSignals.facts.map((line) => `- ${line}`),
  ].join('\n');
  const opportunitySection = opportunityCandidates.length > 0
    ? opportunityCandidates
        .slice(0, 5)
        .map((item) => {
          const price = item.currentPrice != null ? `$${Number(item.currentPrice).toPrecision(4)}` : 'Price N/A';
          const change = item.change24h != null
            ? `${Number(item.change24h) >= 0 ? '+' : ''}${Number(item.change24h).toFixed(2)}%`
            : 'N/A';
          return `- ${item.symbol} (${item.chain}) | ${price} | 24h ${change} | ${item.reason}`;
        })
        .join('\n')
    : 'No clear opportunity candidates.';
  const riskSection = riskSignals.length > 0
    ? riskSignals.slice(0, 4).map((item) => `- ${item.title}: ${item.detail}`).join('\n')
    : 'No concentrated risk signal.';

  const sections = [
    `Date: ${dateKey}`,
    `User ID: ${ownerUserId}`,
    ``,
    `--- Locale Context ---`,
    `Preferred locale: ${localeContext.preferredLocale}`,
    `Output language: ${localeContext.outputLanguage}`,
    `Region hint: ${localeContext.regionHint}`,
    `Timezone hint: ${localeContext.timezoneHint}`,
    `Locale confidence: ${localeContext.localeConfidence}`,
    `Use locale context for language, timing, and relevance framing only.`,
    ``,
    `--- User Context Signals ---`,
    signalSection,
    ``,
    `--- Portfolio ---`,
    portfolioContext,
    holdingSection ? `Top holdings snapshot:\n${holdingSection}` : '',
    ``,
    `--- User Behavior (recent) ---`,
    eventLines || '  No recent activity recorded.',
    `Top interacted assets: ${eventSummary.topAssets.join(', ') || 'N/A'}`,
    `Watchlist assets: ${watchlistSymbols.join(', ') || 'N/A'}`,
  ];

  if (marketSection) {
    sections.push('', '--- Market Trending (CoinGecko + Bitget) ---', marketSection);
  }

  sections.push('', '--- Candidate Opportunities ---', opportunitySection);
  sections.push('', '--- Risk Signals ---', riskSection);
  sections.push(
    '',
    '--- User-Relevant News ---',
    userNewsItems.length > 0
      ? userNewsItems.slice(0, 6).map((item) => formatNewsLine(item)).join('\n')
      : 'No user-specific headlines available.',
    '',
    '--- Market-Emerging News ---',
    marketNewsItems.length > 0
      ? marketNewsItems.slice(0, 6).map((item) => formatNewsLine(item)).join('\n')
      : 'No market-wide headlines available.',
    '',
    '--- Combined News Context ---',
    allNews.length > 0
      ? allNews.join('\n')
      : 'No headlines available (skip news commentary).',
  );

  if (twitterSection) {
    sections.push('', '--- Social Buzz (Twitter/X) ---', twitterSection);
  }

  sections.push(
    '',
    '--- Output Requirements ---',
    `Length: ${language.maxLengthRule}.`,
    `Focus: opportunity discovery with the right level of personalization for the available context.`,
    `Format: Markdown.`,
    `Use this structure with localized headings:`,
    `1. A short title.`,
    `2. Section 1: today's most relevant opportunity or change.`,
    `3. Section 2: why this matters to the user.`,
    `4. Section 3: priority watch with exactly 3 bullets covering "continue tracking", "add to watch", and "raise caution".`,
    `5. Section 4: one-sentence risk note.`,
    `Keep the tone measured. No direct trade instructions.`,
  );

  return sections.join('\n');
}

function getPortfolioHoldingsFromSnapshot(sql: ContentDeps['sql']): PortfolioHolding[] {
  const row = sql
    .exec(
      `SELECT holdings_json
       FROM portfolio_snapshots_hourly
       ORDER BY bucket_hour_utc DESC
       LIMIT 1`,
    )
    .toArray()[0] as { holdings_json?: string } | undefined;

  if (!row?.holdings_json) return [];

  try {
    const holdings = JSON.parse(row.holdings_json) as Array<{
      symbol?: string;
      name?: string;
      value_usd?: number;
      chain_id?: number;
    }>;
    return holdings
      .map((item) => ({
        symbol: normalizeSymbol(item.symbol),
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : normalizeSymbol(item.symbol),
        valueUsd: Number(item.value_usd ?? 0),
        chainId: Number.isFinite(Number(item.chain_id)) ? Number(item.chain_id) : null,
      }))
      .filter((item) => item.symbol && item.valueUsd > 0)
      .sort((a, b) => b.valueUsd - a.valueUsd) as PortfolioHolding[];
  } catch {
    return [];
  }
}

function buildLocaleContext(locale: string | null, language: DailyLanguage): LocaleContext {
  const normalized = (locale ?? '').trim().toLowerCase();
  if (normalized.startsWith('zh')) {
    return {
      preferredLocale: normalized || 'zh',
      outputLanguage: language.outputLanguage,
      regionHint: 'Greater China / Chinese-speaking market context',
      timezoneHint: 'Asia timezones (for timing and framing only)',
      localeConfidence: normalized ? 'explicit' : 'fallback',
    };
  }
  if (normalized.startsWith('ar')) {
    return {
      preferredLocale: normalized || 'ar',
      outputLanguage: language.outputLanguage,
      regionHint: 'Arabic-speaking regions / MENA market context',
      timezoneHint: 'Middle East timezones (for timing and framing only)',
      localeConfidence: normalized ? 'explicit' : 'fallback',
    };
  }
  return {
    preferredLocale: normalized || 'en',
    outputLanguage: language.outputLanguage,
    regionHint: 'Global English-speaking market context',
    timezoneHint: 'Global market day framing',
    localeConfidence: normalized ? 'explicit' : 'fallback',
  };
}

function normalizeSymbol(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function dedupeNewsItems(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const output: NewsItem[] = [];
  for (const item of items) {
    const key = item.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function dedupeTweetItems(items: TweetItem[]): TweetItem[] {
  const seen = new Set<string>();
  const output: TweetItem[] = [];
  for (const item of items) {
    const key = `${item.handle}:${item.text.trim().toLowerCase()}`;
    if (!item.text.trim() || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function dedupeMarketAssets(items: MarketTopAsset[]): MarketTopAsset[] {
  const seen = new Set<string>();
  const output: MarketTopAsset[] = [];
  for (const item of items) {
    const key = `${normalizeSymbol(item.symbol)}:${item.chain}:${item.contract}`;
    if (!normalizeSymbol(item.symbol) || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function buildMarketAssetLookup(assets: MarketTopAsset[]): Map<string, MarketTopAsset> {
  const lookup = new Map<string, MarketTopAsset>();
  for (const asset of assets) {
    const symbol = normalizeSymbol(asset.symbol);
    if (!symbol) continue;
    const existing = lookup.get(symbol);
    if (!existing) {
      lookup.set(symbol, asset);
      continue;
    }
    const existingRank = Number(existing.market_cap_rank ?? Number.POSITIVE_INFINITY);
    const candidateRank = Number(asset.market_cap_rank ?? Number.POSITIVE_INFINITY);
    if (candidateRank < existingRank) {
      lookup.set(symbol, asset);
    }
  }
  return lookup;
}

function classifyAsset(symbol: string, asset: MarketTopAsset | null | undefined): AssetClass {
  if (STABLECOIN_SYMBOLS.has(symbol)) return 'stable';
  if (MEME_SYMBOLS.has(symbol)) return 'meme';
  if (BLUECHIP_SYMBOLS.has(symbol)) return 'major';
  if (asset?.risk_level && asset.risk_level.toLowerCase().includes('high')) return 'meme';
  if (typeof asset?.market_cap_rank === 'number' && asset.market_cap_rank <= 20) return 'major';
  if (typeof asset?.market_cap_rank === 'number' && asset.market_cap_rank >= 150) return 'meme';
  return 'alt';
}

function buildUserContextSignals(input: {
  holdings: PortfolioHolding[];
  watchlistSymbols: string[];
  eventSummary: { counts: Record<string, number>; topAssets: string[] };
  assetLookup: Map<string, MarketTopAsset>;
}): UserContextSignals {
  const totalValue = input.holdings.reduce((sum, item) => sum + item.valueUsd, 0);
  const stableShare = totalValue > 0
    ? input.holdings
        .filter((item) => classifyAsset(item.symbol, input.assetLookup.get(item.symbol)) === 'stable')
        .reduce((sum, item) => sum + item.valueUsd, 0) / totalValue
    : 0;
  const majorShare = totalValue > 0
    ? input.holdings
        .filter((item) => classifyAsset(item.symbol, input.assetLookup.get(item.symbol)) === 'major')
        .reduce((sum, item) => sum + item.valueUsd, 0) / totalValue
    : 0;
  const memeShare = totalValue > 0
    ? input.holdings
        .filter((item) => classifyAsset(item.symbol, input.assetLookup.get(item.symbol)) === 'meme')
        .reduce((sum, item) => sum + item.valueUsd, 0) / totalValue
    : 0;
  const topHoldingShare = totalValue > 0 ? (input.holdings[0]?.valueUsd ?? 0) / totalValue : 0;
  const buys = input.eventSummary.counts.trade_buy ?? 0;
  const sells = input.eventSummary.counts.trade_sell ?? 0;
  const views = input.eventSummary.counts.asset_viewed ?? 0;
  const favorites = input.eventSummary.counts.asset_favorited ?? 0;
  const reads = input.eventSummary.counts.article_read ?? 0;
  const tradeCount = buys + sells;
  const reliableSignalCount =
    (input.holdings.length > 0 ? 1 : 0)
    + (input.watchlistSymbols.length > 0 ? 1 : 0)
    + (tradeCount + views + favorites + reads > 0 ? 1 : 0);
  const contextStrength: UserContextSignals['contextStrength'] =
    reliableSignalCount >= 2 && (input.holdings.length > 0 || tradeCount + views + favorites + reads >= 4)
      ? 'strong'
      : reliableSignalCount >= 1
        ? 'partial'
        : 'weak';

  const facts = [
    totalValue > 0
      ? `Stablecoin share ${Math.round(stableShare * 100)}%, bluechip share ${Math.round(majorShare * 100)}%, higher-beta share ${Math.round(memeShare * 100)}%.`
      : 'Portfolio snapshot is limited, so behavior and watchlist signals carry more weight today.',
    `Recent activity: ${tradeCount} trades, ${views} asset views, ${favorites} favorites, ${reads} article reads.`,
    topHoldingShare >= 0.45 ? `Top holding concentration is high at roughly ${Math.round(topHoldingShare * 100)}%.` : 'Portfolio concentration looks moderate.',
    input.watchlistSymbols.length > 0
      ? `Watchlist currently leans toward ${input.watchlistSymbols.slice(0, 5).join(', ')}.`
      : 'No meaningful watchlist signal yet.',
  ];
  const summary = buildUserSignalSummary({
    contextStrength,
    stableShare,
    majorShare,
    highBetaShare: memeShare,
    tradeCount,
    viewCount: views,
    favoriteCount: favorites,
    articleReadCount: reads,
    topHoldingShare,
    hasHoldings: input.holdings.length > 0,
    hasWatchlist: input.watchlistSymbols.length > 0,
  });

  return {
    contextStrength,
    summary,
    facts,
    stableShare,
    majorShare,
    highBetaShare: memeShare,
    topHoldingShare,
    tradeCount,
    viewCount: views,
    favoriteCount: favorites,
    articleReadCount: reads,
  };
}

function buildUserSignalSummary(input: {
  contextStrength: UserContextSignals['contextStrength'];
  stableShare: number;
  majorShare: number;
  highBetaShare: number;
  tradeCount: number;
  viewCount: number;
  favoriteCount: number;
  articleReadCount: number;
  topHoldingShare: number;
  hasHoldings: boolean;
  hasWatchlist: boolean;
}): string {
  if (input.contextStrength === 'weak') {
    return 'User-specific evidence is weak, so today should read like a starter market brief rather than a strongly personalized one.';
  }
  if (!input.hasHoldings && input.hasWatchlist) {
    return 'There is some user intent from the watchlist, but holdings evidence is still limited.';
  }
  if (input.highBetaShare >= 0.3) {
    return 'Signals point to a user who can tolerate higher-beta ideas, but the brief should still stay measured.';
  }
  if (input.stableShare >= 0.5) {
    return 'Signals lean more defensive, so the brief should emphasize cleaner setups and capital preservation context.';
  }
  if (input.tradeCount + input.viewCount + input.favoriteCount + input.articleReadCount >= 8) {
    return 'There is enough recent behavior to tie today\'s market move back to what the user has been watching.';
  }
  return 'There is some usable user context, but the brief should avoid over-claiming and stay light on personality assumptions.';
}

function buildOpportunityCandidates(input: {
  topGainers: MarketTopAsset[];
  trendingAssets: MarketTopAsset[];
  marketCapAssets: MarketTopAsset[];
  holdings: PortfolioHolding[];
  watchlistSymbols: string[];
  eventSummary: { counts: Record<string, number>; topAssets: string[] };
  userSignals: UserContextSignals;
  assetLookup: Map<string, MarketTopAsset>;
}): OpportunityCandidate[] {
  const heldSymbols = new Set(input.holdings.map((item) => item.symbol));
  const watchlistSet = new Set(input.watchlistSymbols);
  const interactedSet = new Set(input.eventSummary.topAssets.map((item) => normalizeSymbol(item)));
  const marketCapSet = new Set(input.marketCapAssets.map((item) => normalizeSymbol(item.symbol)));
  const scoreBySymbol = new Map<string, OpportunityCandidate>();
  const pushAsset = (asset: MarketTopAsset, sourceTag: string) => {
    const symbol = normalizeSymbol(asset.symbol);
    if (!symbol || STABLECOIN_SYMBOLS.has(symbol)) return;
    const assetClass = classifyAsset(symbol, input.assetLookup.get(symbol));
    const isHeld = heldSymbols.has(symbol);
    const isWatchlisted = watchlistSet.has(symbol);
    const isInteracted = interactedSet.has(symbol);
    const isDiscovery = !isHeld && !isWatchlisted;
    let score = 0;
    score += sourceTag === 'gainers' ? 5 : sourceTag === 'trending' ? 4 : 2;
    score += asset.price_change_percentage_24h != null ? Math.min(6, Math.max(-2, asset.price_change_percentage_24h / 4)) : 0;
    score += isWatchlisted ? 4 : 0;
    score += isInteracted ? 3 : 0;
    score += isHeld ? 2 : 0;
    score += isDiscovery ? 2 : 0;
    score += input.userSignals.majorShare >= 0.55 && assetClass === 'major' ? 3 : 0;
    score += input.userSignals.highBetaShare >= 0.25 && (assetClass === 'meme' || assetClass === 'alt') ? 2 : 0;
    score += input.userSignals.stableShare >= 0.5 && assetClass === 'major' ? 2 : 0;
    score += input.userSignals.stableShare >= 0.5 && assetClass === 'meme' ? -3 : 0;
    score += input.userSignals.contextStrength === 'weak' && isDiscovery ? 2 : 0;
    score += marketCapSet.has(symbol) ? 1 : 0;

    const sourceTags = [sourceTag];
    if (isWatchlisted) sourceTags.push('watchlist');
    if (isInteracted) sourceTags.push('interaction');
    if (isHeld) sourceTags.push('holding');
    if (isDiscovery) sourceTags.push('new');
    const reasonBits = [
      sourceTag === 'gainers' ? 'showing strong short-term momentum' : sourceTag === 'trending' ? 'already pulling attention across the market' : 'still anchored by broader market relevance',
      isWatchlisted ? 'already on the user watchlist' : null,
      isInteracted ? 'linked to recent user behavior' : null,
      isDiscovery ? 'new relative to current portfolio/watchlist' : null,
    ].filter(Boolean);
    const candidate: OpportunityCandidate = {
      symbol,
      chain: asset.chain,
      assetClass,
      currentPrice: asset.current_price,
      change24h: asset.price_change_percentage_24h,
      score,
      isHeld,
      isWatchlisted,
      isInteracted,
      isDiscovery,
      sourceTags,
      reason: `${symbol} is ${reasonBits.join(', ')}.`,
    };
    const existing = scoreBySymbol.get(symbol);
    if (!existing || candidate.score > existing.score) {
      scoreBySymbol.set(symbol, candidate);
    } else if (!existing.sourceTags.includes(sourceTag)) {
      existing.sourceTags.push(sourceTag);
    }
  };

  for (const asset of input.topGainers) pushAsset(asset, 'gainers');
  for (const asset of input.trendingAssets) pushAsset(asset, 'trending');
  for (const asset of input.marketCapAssets.slice(0, 12)) pushAsset(asset, 'marketcap');

  return Array.from(scoreBySymbol.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function buildRiskSignals(input: {
  topLosers: MarketTopAsset[];
  holdings: PortfolioHolding[];
  watchlistSymbols: string[];
  userSignals: UserContextSignals;
  assetLookup: Map<string, MarketTopAsset>;
}): RiskSignal[] {
  const holdingsSet = new Set(input.holdings.map((item) => item.symbol));
  const watchlistSet = new Set(input.watchlistSymbols);
  const totalValue = input.holdings.reduce((sum, item) => sum + item.valueUsd, 0);
  const topHoldingShare = totalValue > 0 ? (input.holdings[0]?.valueUsd ?? 0) / totalValue : 0;
  const signals: RiskSignal[] = [];

  for (const asset of input.topLosers.slice(0, 6)) {
    const symbol = normalizeSymbol(asset.symbol);
    if (!symbol) continue;
    if (holdingsSet.has(symbol) || watchlistSet.has(symbol)) {
      const changeText = asset.price_change_percentage_24h != null
        ? `${asset.price_change_percentage_24h.toFixed(2)}%`
        : 'a sharp move';
      signals.push({
        title: `${symbol} volatility`,
        detail: `${symbol} is already relevant to the user and sits on the weaker side of today's tape (${changeText} over 24h).`,
      });
    }
  }

  if (topHoldingShare >= 0.5 && input.holdings[0]) {
    signals.push({
      title: 'concentration',
      detail: `${input.holdings[0].symbol} accounts for roughly ${Math.round(topHoldingShare * 100)}% of the latest portfolio snapshot.`,
    });
  }

  if (input.userSignals.highBetaShare >= 0.25) {
    signals.push({
      title: 'noise filter',
      detail: 'Higher-beta setups can look attractive early, but confirmation matters more than the first headline.',
    });
  }

  if (signals.length === 0) {
    signals.push({
      title: 'selectivity',
      detail: 'Opportunity is present, but the cleaner edge may come from waiting for follow-through rather than reacting to the first move.',
    });
  }

  return signals.slice(0, 4);
}

function formatNewsLine(item: NewsItem): string {
  const source = item.source ? ` (${item.source})` : '';
  const rating = item.rating != null ? ` [rating ${item.rating}]` : '';
  const summary = item.summary ? ` - ${item.summary.slice(0, 90)}` : '';
  return `- ${item.title}${source}${rating}${summary}`;
}

function formatNewsLines(newsItems: NewsItem[], rssHeadlines: string[], limit: number): string[] {
  const output = newsItems.slice(0, limit).map((item) => formatNewsLine(item));
  for (const title of rssHeadlines) {
    if (output.length >= limit) break;
    if (output.some((line) => line.toLowerCase().includes(title.slice(0, 24).toLowerCase()))) continue;
    output.push(`- ${title}`);
  }
  return output;
}

function buildDailyDigestFallbackMarkdown(input: {
  dateKey: string;
  language: DailyLanguage;
  userSignals: UserContextSignals;
  portfolioContext: string;
  eventSummary: { counts: Record<string, number>; topAssets: string[] };
  watchlistSymbols: string[];
  userNewsItems: NewsItem[];
  marketNewsItems: NewsItem[];
  newsHeadlines: string[];
  opportunityCandidates: OpportunityCandidate[];
  riskSignals: RiskSignal[];
}): string {
  const lead = input.opportunityCandidates[0];
  const watch = input.opportunityCandidates.find((item) => item.isDiscovery) ?? input.opportunityCandidates[1] ?? lead;
  const caution = input.riskSignals[0];
  const headline = lead
    ? `${lead.symbol} is the cleanest thing to keep near the top of the list today because it combines market momentum with a fit for this user's current style.`
    : 'The cleanest edge today is to stay selective and watch for alignment between user-relevant assets and broader market headlines.';
  const contextLines = [
    `- Context: ${formatUserSignalSummaryForFallback(input.userSignals, input.language.localeCode)}`,
    `- Portfolio: ${input.portfolioContext.split('\n')[0] ?? input.portfolioContext}`,
    `- Behavior: top interacted assets ${input.eventSummary.topAssets.slice(0, 4).join(', ') || 'N/A'}; watchlist ${input.watchlistSymbols.slice(0, 4).join(', ') || 'N/A'}.`,
  ];
  const headlineLines = formatNewsLines(
    [...input.userNewsItems.slice(0, 3), ...input.marketNewsItems.slice(0, 2)],
    input.newsHeadlines,
    4,
  );

  if (input.language.localeCode === 'zh') {
    return [
      `# 日报 ${input.dateKey}`,
      '',
      '## 今日最值得关注',
      lead
        ? `${lead.symbol} 更值得放在今天的优先观察位。它既有市场热度，也和你的当前风格、关注方向或持仓关系更近。`
        : '今天更适合做选择题，而不是追逐所有热点。优先看与你现有关注方向产生交集的主题。',
      '',
      '## 为什么这和你有关',
      ...contextLines,
      ...(headlineLines.length > 0 ? ['', '相关线索：', ...headlineLines] : []),
      '',
      '## 值得优先关注',
      `- 继续跟踪：${lead ? formatOpportunityForFallback(lead, 'zh') : headline}`,
      `- 纳入观察：${watch ? formatOpportunityForFallback(watch, 'zh') : '把与现有 watchlist 有交集的新主题纳入观察。'}`,
      `- 提高警惕：${caution ? formatRiskForFallback(caution, 'zh') : '先确认热点是否有持续扩散，而不是只停留在标题层面。'}`,
      '',
      '## 风险一句话',
      caution ? formatRiskForFallback(caution, 'zh') : '今天更适合确认延续性，而不是依据第一波情绪直接做判断。',
    ].join('\n');
  }

  if (input.language.localeCode === 'ar') {
    return [
      `# التقرير اليومي ${input.dateKey}`,
      '',
      '## أهم ما يستحق المتابعة اليوم',
      lead
        ? `${lead.symbol} يبدو أقرب فرصة تستحق المتابعة لأنه يجمع بين زخم السوق وملاءمته لأسلوب هذا المستخدم.`
        : 'الأفضل اليوم هو الانتقائية ومراقبة التقاطع بين اهتمامات المستخدم والموضوعات الساخنة في السوق.',
      '',
      '## لماذا يهمك هذا',
      ...contextLines,
      '',
      '## قائمة الأولويات',
      `- استمر في المتابعة: ${lead ? formatOpportunityForFallback(lead, 'ar') : headline}`,
      `- أضفه للمراقبة: ${watch ? formatOpportunityForFallback(watch, 'ar') : 'راقب أي موضوع جديد يرتبط بقائمة المتابعة الحالية.'}`,
      `- ارفع مستوى الحذر: ${caution ? formatRiskForFallback(caution, 'ar') : 'تحقق من الاستمرارية قبل الاعتماد على أول اندفاعة.'}`,
      '',
      '## ملاحظة مخاطر',
      caution ? formatRiskForFallback(caution, 'ar') : 'التأكيد أهم من رد الفعل السريع على أول موجة من العناوين.',
    ].join('\n');
  }

  return [
    `# Daily ${input.dateKey}`,
    '',
    '## Today\'s Most Relevant Angle',
    headline,
    '',
    '## Why This Matters To You',
    ...contextLines,
    ...(headlineLines.length > 0 ? ['', 'Context lines:', ...headlineLines] : []),
    '',
    '## Priority Watch',
    `- Continue tracking: ${lead ? formatOpportunityForFallback(lead, 'en') : headline}`,
    `- Add to watch: ${watch ? formatOpportunityForFallback(watch, 'en') : 'Add the next theme that overlaps with the current watchlist.'}`,
    `- Raise caution: ${caution ? formatRiskForFallback(caution, 'en') : 'Look for follow-through before reacting to the first headline.'}`,
    '',
    '## Risk Note',
    caution ? formatRiskForFallback(caution, 'en') : 'Selectivity matters more than reacting to the first burst of attention.',
  ].join('\n');
}

function formatUserSignalSummaryForFallback(
  userSignals: UserContextSignals,
  localeCode: DailyLanguage['localeCode'],
): string {
  if (localeCode === 'zh') {
    if (userSignals.contextStrength === 'weak') return '用户侧信号较弱，今天更适合写成市场观察版。';
    if (userSignals.contextStrength === 'partial') return '当前只有部分用户信号，适合轻度个性化，不适合写得过满。';
    return '用户侧信号较完整，可以明确解释热点与持仓、watchlist、最近行为的关系。';
  }

  if (localeCode === 'ar') {
    if (userSignals.contextStrength === 'weak') return 'إشارات المستخدم ضعيفة، لذا من الأفضل أن يكون التقرير أقرب إلى ملخص سوق تمهيدي.';
    if (userSignals.contextStrength === 'partial') return 'هناك بعض الإشارات فقط، لذلك من الأفضل إبقاء التخصيص خفيفاً.';
    return 'إشارات المستخدم كافية لربط الموضوعات بالسلوك أو المحفظة أو قائمة المتابعة.';
  }

  return userSignals.summary;
}

function formatOpportunityForFallback(
  candidate: OpportunityCandidate,
  localeCode: DailyLanguage['localeCode'],
): string {
  const marketReason = candidate.sourceTags.includes('gainers')
    ? 'strong short-term momentum'
    : candidate.sourceTags.includes('trending')
      ? 'broad market attention'
      : 'steady relevance';
  const userReason = candidate.isWatchlisted
    ? 'already on the watchlist'
    : candidate.isHeld
      ? 'already connected to the portfolio'
      : candidate.isInteracted
        ? 'tied to recent behavior'
        : 'still relatively new for this user';

  if (localeCode === 'zh') {
    const marketText = candidate.sourceTags.includes('gainers')
      ? '短线动能更强'
      : candidate.sourceTags.includes('trending')
        ? '全市场关注度在抬升'
        : '有更稳的市场相关性';
    const userText = candidate.isWatchlisted
      ? '已经在你的 watchlist 里'
      : candidate.isHeld
        ? '与你当前持仓直接相关'
        : candidate.isInteracted
          ? '和你最近的关注行为有关'
          : '对你来说仍然算新方向';
    return `${candidate.symbol}，${marketText}，而且${userText}。`;
  }

  if (localeCode === 'ar') {
    const marketText = candidate.sourceTags.includes('gainers')
      ? 'زخمه القصير الأجل أقوى'
      : candidate.sourceTags.includes('trending')
        ? 'يحصل على اهتمام أوسع في السوق'
        : 'يحافظ على صلة أوضح بالسوق';
    const userText = candidate.isWatchlisted
      ? 'وهو موجود بالفعل في قائمة المتابعة'
      : candidate.isHeld
        ? 'ويرتبط مباشرة بالمحفظة الحالية'
        : candidate.isInteracted
          ? 'ويرتبط بسلوك المستخدم الأخير'
          : 'ولا يزال موضوعاً جديداً نسبياً للمستخدم';
    return `${candidate.symbol}: ${marketText}، ${userText}.`;
  }

  return `${candidate.symbol}, ${marketReason}, and it is ${userReason}.`;
}

function formatRiskForFallback(signal: RiskSignal, localeCode: DailyLanguage['localeCode']): string {
  if (localeCode === 'zh') {
    if (signal.title === 'concentration') return '单一资产占比偏高，今天更要留意回撤放大。';
    if (signal.title === 'noise filter') return '高 beta 题材更容易放大噪音，确认持续性比追第一波更重要。';
    if (signal.title.toLowerCase().includes('volatility')) return '相关资产今天波动偏大，先确认是情绪宣泄还是趋势延续。';
    return '先看确认信号，再决定是否提高关注级别。';
  }

  if (localeCode === 'ar') {
    if (signal.title === 'concentration') return 'تركيز المحفظة مرتفع نسبياً، لذا قد يتسع أثر أي تراجع اليوم.';
    if (signal.title === 'noise filter') return 'في الأصول عالية البيتا، تأكيد الاستمرارية أهم من ملاحقة أول اندفاعة.';
    if (signal.title.toLowerCase().includes('volatility')) return 'التقلب مرتفع اليوم، لذلك من الأفضل التحقق من الاستمرارية أولاً.';
    return 'ابحث عن تأكيد قبل رفع درجة الاهتمام.';
  }

  return signal.detail;
}
