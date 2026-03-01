import { generateWithLlm, getLlmErrorInfo, getLlmStatus } from '../services/llm';
import type { MarketTopAsset } from '../services/bitgetWallet';
import { fetchTopMarketAssets } from '../services/marketTopAssets';
import { fetchOpenNewsCryptoNews, fetchOpenTwitterCryptoTweets, type NewsItem, type TweetItem } from '../services/openNews';
import type { Bindings } from '../types';
import {
  buildArticleR2Key,
  buildFallbackDailyDigestMarkdown,
  buildFallbackRecommendations,
  buildFallbackTopicMarkdown,
  isoDate,
  normalizeR2Key,
  summarizeEvents,
  tomorrowDate,
  parseLlmRecommendations,
} from './userAgentHelpers';
import type { ArticleContentRow, EventRow } from './userAgentTypes';

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => { toArray(): unknown[] };
};

type ContentDeps = {
  env: Bindings;
  sql: SqlStorage;
  getOwnerUserId: () => string | null;
  getPreferredLocale?: () => string | null;
  getLatestEvents: (limit?: number) => EventRow[];
};

type PortfolioSnapshotRow = {
  bucket_hour_utc?: string;
  total_usd?: number;
  holdings_json?: string;
};

type RecommendationAssetSnapshot = {
  symbol: string;
  chain: string | null;
  contract: string | null;
  name: string | null;
  image: string | null;
  priceChange24h: number | null;
};

const DEFAULT_NEWS_FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
];

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

function buildPortfolioContext(sql: SqlStorage): string {
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

function buildRecommendationAssetLookup(marketAssets: MarketTopAsset[]): Map<string, RecommendationAssetSnapshot> {
  const lookup = new Map<string, RecommendationAssetSnapshot>();
  for (const asset of marketAssets) {
    const symbol = (asset.symbol ?? '').trim().toUpperCase();
    if (!symbol || lookup.has(symbol)) continue;
    lookup.set(symbol, {
      symbol,
      chain: asset.chain ?? null,
      contract: asset.contract ?? null,
      name: asset.name ?? symbol,
      image: asset.image ?? null,
      priceChange24h: asset.price_change_percentage_24h ?? null,
    });
  }
  return lookup;
}

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
  const preferredLocale = deps.getPreferredLocale?.() ?? null;
  const language = resolveDailyLanguage(preferredLocale);
  const portfolioContext = buildPortfolioContext(deps.sql);
  const llmStatus = getLlmStatus(deps.env);

  const userCoins = eventSummary.topAssets.slice(0, 5);
  const searchKeywords = userCoins.length > 0 ? userCoins : ['bitcoin', 'ethereum', 'crypto'];

  const [newsHeadlines, openNewsItems, twitterItems, marketAssets] = await Promise.all([
    fetchNewsHeadlines(deps.env),
    fetchOpenNewsCryptoNews(deps.env, { keywords: searchKeywords, limit: 8 }),
    fetchOpenTwitterCryptoTweets(deps.env, { keywords: searchKeywords, limit: 6 }),
    fetchTopMarketAssets(deps.env, { name: 'topGainers', limit: 10, source: 'auto' }).catch(() => [] as MarketTopAsset[]),
  ]);

  let markdown = buildFallbackDailyDigestMarkdown(dateKey, eventSummary, language.localeCode);
  if (llmStatus.enabled) {
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
              newsHeadlines,
              portfolioContext,
              language,
              openNewsItems,
              twitterItems,
              marketAssets,
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

  await putArticleMarkdownContent(deps.env, deps.sql, articleId, r2Key, markdown);
}

export async function refreshRecommendationsContent(_payload: Record<string, unknown>, deps: ContentDeps): Promise<void> {
  const now = new Date();
  const dateKey = isoDate(now);
  const dayStart = `${dateKey}T00:00:00.000Z`;
  const dayEnd = `${tomorrowDate(dateKey)}T00:00:00.000Z`;

  const existingToday = deps.sql
    .exec(
      `SELECT id
       FROM recommendations
       WHERE generated_at >= ?
         AND generated_at < ?
       LIMIT 1`,
      dayStart,
      dayEnd,
    )
    .toArray()[0];
  if (existingToday) return;

  const events = deps.getLatestEvents(120);
  const eventSummary = summarizeEvents(events);
  const generatedAt = now.toISOString();
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  deps.sql.exec('DELETE FROM recommendations WHERE generated_at < ?', dayStart);

  let marketAssets: MarketTopAsset[] = [];
  try {
    marketAssets = await fetchTopMarketAssets(deps.env, { name: 'topGainers', limit: 20, source: 'auto' });
  } catch {
    // Market APIs may be unavailable; continue with empty market data.
  }

  const userTopAssets = eventSummary.topAssets.slice(0, 5);
  const portfolioHoldings = getPortfolioHoldings(deps.sql);

  let rows = buildFallbackRecommendations(userTopAssets, portfolioHoldings, marketAssets);
  const marketAssetLookup = buildRecommendationAssetLookup(marketAssets);

  const preferredLocale = deps.getPreferredLocale?.() ?? null;
  const language = resolveRecommendationLanguage(preferredLocale);
  const portfolioContext = buildPortfolioContext(deps.sql);

  const llmStatus = getLlmStatus(deps.env);
  if (llmStatus.enabled) {
    try {
      const llmResult = await generateWithLlm(deps.env, {
        messages: [
          {
            role: 'system',
            content: buildRecommendationSystemPrompt(language),
          },
          {
            role: 'user',
            content: buildRecommendationUserPrompt(
              eventSummary,
              portfolioContext,
              marketAssets,
              userTopAssets,
              language,
            ),
          },
        ],
        temperature: 0.3,
        maxTokens: 1200,
      });
      const parsed = parseLlmRecommendations(llmResult.text);
      if (parsed.length > 0) {
        const usedAssets = new Set(parsed.map((r) => r.asset));
        const fillers = rows.filter((r) => !usedAssets.has(r.asset));
        rows = [...parsed, ...fillers].slice(0, 5);
      }
    } catch (error) {
      const llmError = getLlmErrorInfo(error);
      console.error('recommendation_llm_failed', {
        ...llmError,
        llm: llmStatus,
      });
    }
  }

  for (const row of rows) {
    const symbol = row.asset.trim().toUpperCase();
    const snapshot = marketAssetLookup.get(symbol);
    deps.sql.exec(
      `INSERT INTO recommendations (
        id,
        category,
        asset_name,
        asset_symbol,
        asset_chain,
        asset_contract,
        asset_display_name,
        asset_image,
        asset_price_change_24h,
        reason,
        score,
        generated_at,
        valid_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      row.category,
      row.asset,
      symbol || null,
      snapshot?.chain ?? null,
      snapshot?.contract ?? null,
      snapshot?.name ?? symbol ?? null,
      snapshot?.image ?? null,
      snapshot?.priceChange24h ?? null,
      row.reason,
      row.score,
      generatedAt,
      validUntil,
    );
  }
}

function getPortfolioHoldings(sql: SqlStorage): Array<{ symbol: string; valueUsd: number }> {
  const snapshot = getLatestPortfolioSnapshot(sql);
  if (!snapshot?.holdings_json) return [];
  try {
    const holdings = JSON.parse(snapshot.holdings_json) as Array<{
      symbol?: string;
      value_usd?: number;
    }>;
    return holdings
      .filter((h) => h.symbol && Number(h.value_usd ?? 0) > 0)
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

type DailyLanguage = {
  localeCode: 'zh' | 'en' | 'ar';
  outputLanguage: string;
  maxLengthRule: string;
  focusPoints: string;
};

function resolveDailyLanguage(locale: string | null): DailyLanguage {
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

function resolveRecommendationLanguage(locale: string | null): {
  localeCode: 'zh' | 'en' | 'ar';
  outputLanguage: string;
  reasonLengthHint: string;
} {
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

function buildDailyDigestSystemPrompt(language: DailyLanguage): string {
  return [
    `You are a personal crypto wallet assistant writing a daily brief for a wallet user.`,
    `Write entirely in ${language.outputLanguage}.`,
    ``,
    `You have access to multiple data sources: portfolio data, market trends, crypto news, and social media sentiment. Use whichever sources have meaningful content to construct today's brief.`,
    ``,
    `Guidelines:`,
    `- Choose a flexible structure based on what's most interesting today. Don't follow a rigid template.`,
    `- Possible sections (pick and combine freely): market pulse, portfolio spotlight, trending coins, news highlights, social buzz, action items, risk notes.`,
    `- Lead with the single most impactful insight — could be a portfolio swing, breaking news, viral social sentiment, or a market trend.`,
    `- Reference the user's actual holdings and portfolio value when available.`,
    `- Weave in social media sentiment (tweets, KOL opinions) when available — attribute insights but don't list raw tweets.`,
    `- Synthesize news from multiple sources into coherent narratives rather than listing headlines.`,
    `- End with 1–3 actionable suggestions grounded in the combined data.`,
    `- Include a brief risk reminder when suggesting actions.`,
    `- Use markdown formatting naturally (headers, bold, lists, blockquotes). Vary the structure day-to-day.`,
    `- Tone: knowledgeable friend, not a formal analyst. Be concise and directly useful.`,
    `- Do NOT fabricate price data or percentages. Only reference data provided to you.`,
  ].join('\n');
}

function buildDailyDigestUserPrompt(
  dateKey: string,
  ownerUserId: string,
  eventSummary: { counts: Record<string, number>; topAssets: string[] },
  newsHeadlines: string[],
  portfolioContext: string,
  language: DailyLanguage,
  openNewsItems: NewsItem[] = [],
  twitterItems: TweetItem[] = [],
  marketAssets: MarketTopAsset[] = [],
): string {
  const eventLines = Object.entries(eventSummary.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, count]) => `  ${type}: ${count}`)
    .join('\n');

  const allNews: string[] = [];
  if (openNewsItems.length > 0) {
    for (const item of openNewsItems) {
      const rating = item.rating != null ? ` [AI rating: ${item.rating}]` : '';
      const src = item.source ? ` (${item.source})` : '';
      allNews.push(`- ${item.title}${src}${rating}`);
    }
  }
  if (newsHeadlines.length > 0) {
    for (const h of newsHeadlines) {
      if (!allNews.some((n) => n.includes(h.slice(0, 30)))) {
        allNews.push(`- ${h}`);
      }
    }
  }

  const twitterSection = twitterItems.length > 0
    ? twitterItems
        .map((t) => `- @${t.handle || t.author}: "${t.text.slice(0, 200)}" (❤${t.likes} 🔁${t.retweets})`)
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

  const sections = [
    `Date: ${dateKey}`,
    `User ID: ${ownerUserId}`,
    ``,
    `--- Portfolio ---`,
    portfolioContext,
    ``,
    `--- User Behavior (recent) ---`,
    eventLines || '  No recent activity recorded.',
    `Top interacted assets: ${eventSummary.topAssets.join(', ') || 'N/A'}`,
  ];

  if (marketSection) {
    sections.push('', '--- Market Trending (CoinGecko + Bitget) ---', marketSection);
  }

  sections.push(
    '',
    '--- Crypto News ---',
    allNews.length > 0
      ? allNews.slice(0, 12).join('\n')
      : 'No headlines available (skip news commentary).',
  );

  if (twitterSection) {
    sections.push('', '--- Social Buzz (Twitter/X) ---', twitterSection);
  }

  sections.push(
    '',
    '--- Output Requirements ---',
    `Length: ${language.maxLengthRule}.`,
    `Focus: ${language.focusPoints}.`,
    `Format: Markdown. Pick a structure that best fits today's data — no fixed template required. Synthesize across sources.`,
  );

  return sections.join('\n');
}

function buildRecommendationSystemPrompt(language: {
  outputLanguage: string;
}): string {
  return [
    `You generate personalized crypto investment recommendations in strict JSON format.`,
    `Write the "reason" field in ${language.outputLanguage}.`,
    ``,
    `Guidelines:`,
    `- Recommend exactly 5 coins combining market trends, user portfolio, and user behavior.`,
    `- Use real market data provided (trending coins, price changes) to inform recommendations.`,
    `- Mix different recommendation types: trending opportunities, portfolio-related, user interests, diversification.`,
    `- Each recommendation should have a clear, specific rationale tied to the data.`,
    `- The score (0–1) should reflect confidence based on data quality and relevance.`,
    `- Do NOT output markdown, only raw JSON.`,
    `- Do NOT recommend coins only from user holdings — include market trending opportunities.`,
  ].join('\n');
}

function buildRecommendationUserPrompt(
  eventSummary: { counts: Record<string, number>; topAssets: string[] },
  portfolioContext: string,
  marketAssets: MarketTopAsset[],
  userTopAssets: string[],
  language: { reasonLengthHint: string },
): string {
  const marketLines = marketAssets
    .slice(0, 10)
    .map((a) => {
      const change = a.price_change_percentage_24h != null
        ? `24h: ${Number(a.price_change_percentage_24h) >= 0 ? '+' : ''}${Number(a.price_change_percentage_24h).toFixed(2)}%`
        : '';
      const cap = a.market_cap != null ? `mcap: $${Number(a.market_cap).toLocaleString()}` : '';
      const price = a.current_price != null ? `$${Number(a.current_price).toPrecision(4)}` : 'N/A';
      return `  ${a.symbol} (${a.chain}): ${price} ${[change, cap].filter(Boolean).join(', ')}`;
    })
    .join('\n');

  return [
    `--- Portfolio ---`,
    portfolioContext,
    ``,
    `--- User Behavior ---`,
    `Recent event counts: ${JSON.stringify(eventSummary.counts)}`,
    `Top interacted assets: ${userTopAssets.join(', ') || 'N/A'}`,
    ``,
    `--- Market Trending (CoinGecko + Bitget) ---`,
    marketLines || '  No market data available.',
    ``,
    `Return a JSON array with exactly 5 objects. Each object must have:`,
    `- "category": one of "trending", "portfolio", "interest", "diversify", "momentum"`,
    `- "asset": the token symbol (e.g. "ETH", "USDC", "SOL")`,
    `- "reason": a concise investment rationale (${language.reasonLengthHint})`,
    `- "score": a confidence score between 0 and 1`,
    ``,
    `Requirements:`,
    `- At least 1 coin from market trending data`,
    `- At least 1 coin related to user's existing portfolio`,
    `- At least 1 coin based on user's recent interaction interests`,
    `- Diversify across different chains and risk profiles when possible`,
    `- Recommendations should be actionable investment suggestions`,
  ].join('\n');
}

function buildDailyTitle(dateKey: string, localeCode: 'zh' | 'en' | 'ar'): string {
  if (localeCode === 'zh') return `日报 ${dateKey}`;
  if (localeCode === 'ar') return `التقرير اليومي ${dateKey}`;
  return `Daily ${dateKey}`;
}

function buildDailySummary(markdown: string, localeCode: 'zh' | 'en' | 'ar'): string {
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

async function fetchNewsHeadlines(env: Bindings): Promise<string[]> {
  const feedList = (env.DAILY_NEWS_FEEDS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const feeds = feedList.length ? feedList : DEFAULT_NEWS_FEEDS;
  const headlines: string[] = [];

  const fetchPromises = feeds.slice(0, 4).map(async (feed) => {
    try {
      const res = await fetch(feed, {
        headers: {
          accept: 'application/rss+xml, application/xml, text/xml',
          'user-agent': 'AgenticWallet/1.0 RSS Reader',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return extractRssTitles(xml);
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(fetchPromises);
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const title of result.value) {
      if (!headlines.includes(title)) {
        headlines.push(title);
      }
      if (headlines.length >= 10) return headlines;
    }
  }

  return headlines;
}

function extractRssTitles(xml: string): string[] {
  const titles: string[] = [];
  const itemMatches = xml.matchAll(/<item[\s\S]*?<\/item>/gi);
  for (const match of itemMatches) {
    const item = match[0];
    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
    if (!titleMatch?.[1]) continue;
    const decoded = decodeXmlEntities(stripCdata(titleMatch[1])).trim();
    if (!decoded) continue;
    titles.push(decoded);
    if (titles.length >= 5) break;
  }
  return titles;
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function generateTopicArticleContent(payload: Record<string, unknown>, deps: ContentDeps): Promise<void> {
  const ownerUserId = deps.getOwnerUserId();
  if (!ownerUserId) {
    throw new Error('owner_user_not_initialized');
  }

  const requestedTopic = typeof payload.topic === 'string' ? payload.topic.trim() : '';
  const preferredLocale = deps.getPreferredLocale?.() ?? null;
  const language = resolveDailyLanguage(preferredLocale);
  const topic = requestedTopic || (language.localeCode === 'zh' ? '市场热点追踪' : language.localeCode === 'ar' ? 'تتبع النقاط الساخنة في السوق' : 'Market Hot Topics');
  const now = new Date();
  const dateKey = isoDate(now);
  const recentEvents = deps.getLatestEvents(100);
  const eventSummary = summarizeEvents(recentEvents);
  const llmStatus = getLlmStatus(deps.env);
  const portfolioContext = buildPortfolioContext(deps.sql);

  let markdown = buildFallbackTopicMarkdown(dateKey, topic, eventSummary, language.localeCode);
  if (llmStatus.enabled) {
    try {
      const llmResult = await generateWithLlm(deps.env, {
        messages: [
          {
            role: 'system',
            content: [
              `You are a crypto strategy writer for wallet users. Write in ${language.outputLanguage}.`,
              `Use markdown with practical, actionable content.`,
              `Ground your analysis in the user's actual portfolio data when available.`,
              `Include risk awareness alongside opportunities.`,
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              `Date: ${dateKey}`,
              `Topic: ${topic}`,
              ``,
              `Portfolio context:`,
              portfolioContext,
              ``,
              `Top assets: ${eventSummary.topAssets.join(', ') || 'N/A'}`,
              `Event counts: ${JSON.stringify(eventSummary.counts)}`,
              ``,
              language.localeCode === 'zh'
                ? 'Write markdown: # 标题, ## 核心观点, ## 机会与风险, ## 用户可执行动作. Under 500 Chinese characters.'
                : language.localeCode === 'ar'
                  ? 'Write markdown: # Title, ## Key Insights, ## Opportunities & Risks, ## Actionable Steps. Under 400 words.'
                  : 'Write markdown: # Title, ## Key Insights, ## Opportunities & Risks, ## Actionable Steps. Under 350 words.',
            ].join('\n'),
          },
        ],
        temperature: 0.5,
        maxTokens: 1500,
      });
      markdown = llmResult.text;
    } catch (error) {
      const llmError = getLlmErrorInfo(error);
      console.error('topic_generation_llm_failed', {
        ...llmError,
        llm: llmStatus,
      });
    }
  }

  const topicTitle = language.localeCode === 'zh'
    ? `专题: ${topic}`
    : language.localeCode === 'ar'
      ? `موضوع: ${topic}`
      : `Topic: ${topic}`;
  const topicSummary = language.localeCode === 'zh'
    ? `${topic} 专题，聚焦用户高关注资产与可执行动作。`
    : language.localeCode === 'ar'
      ? `موضوع ${topic}، يركز على الأصول الأكثر متابعة والإجراءات القابلة للتنفيذ.`
      : `${topic} deep dive focusing on your top assets and actionable steps.`;

  const articleId = crypto.randomUUID();
  const createdAt = now.toISOString();
  const r2Key = buildArticleR2Key(ownerUserId, dateKey, 'topic', articleId, topic);
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
    'topic',
    topicTitle,
    topicSummary,
    r2Key,
    JSON.stringify(['topic', topic]),
    createdAt,
    'ready',
  );
  await putArticleMarkdownContent(deps.env, deps.sql, articleId, r2Key, markdown);
}

export async function putArticleMarkdownContent(
  env: Bindings,
  sql: SqlStorage,
  articleId: string,
  r2Key: string,
  markdown: string,
): Promise<void> {
  await env.AGENT_ARTICLES.put(r2Key, markdown, {
    httpMetadata: {
      contentType: 'text/markdown; charset=utf-8',
    },
    customMetadata: {
      articleId,
    },
  });

  sql.exec(
    `INSERT INTO article_contents (article_id, markdown)
     VALUES (?, ?)
     ON CONFLICT(article_id) DO UPDATE SET markdown = excluded.markdown`,
    articleId,
    markdown,
  );
}

export async function getArticleMarkdownContent(
  env: Bindings,
  sql: SqlStorage,
  articleId: string,
  r2Key: string,
): Promise<string> {
  const normalizedKey = normalizeR2Key(r2Key);
  if (normalizedKey) {
    const object = await env.AGENT_ARTICLES.get(normalizedKey);
    if (object) {
      const text = await object.text();
      if (text) return text;
    }
  }

  const content = sql
    .exec('SELECT article_id, markdown FROM article_contents WHERE article_id = ? LIMIT 1', articleId)
    .toArray()[0] as ArticleContentRow | undefined;
  return content?.markdown ?? '';
}
