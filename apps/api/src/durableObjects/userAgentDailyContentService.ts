import { generateWithLlm, getLlmErrorInfo, getLlmStatus } from '../services/llm';
import type { MarketTopAsset } from '../services/bitgetWallet';
import { fetchTopMarketAssets } from '../services/marketTopAssets';
import { fetchOpenNewsCryptoNews, fetchOpenTwitterCryptoTweets, type NewsItem, type TweetItem } from '../services/openNews';
import {
  buildArticleR2Key,
  buildFallbackDailyDigestMarkdown,
  isoDate,
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
  if (llmStatus.enabled && marketAssets.length > 0) {
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
