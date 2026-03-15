import { generateWithLlm, getLlmErrorInfo, getLlmStatus } from '../services/llm';
import type { MarketTopAsset } from '../services/bitgetWallet';
import { fetchTopMarketAssets } from '../services/marketTopAssets';
import { getSupportedMarketChains } from '../config/appConfig';
import {
  EXCLUDED_RECOMMENDATION_SYMBOLS,
  isExcludedRecommendationAsset,
  mergePreferredAssets,
  parseLlmRecommendations,
  summarizeEvents,
} from './userAgentHelpers';
import {
  buildPortfolioContext,
  buildRecommendationAssetLookup,
  getPortfolioHoldings,
  resolveRecommendationLanguage,
  type RecommendationLanguage,
} from './userAgentContentHelpers';
import type { ContentDeps } from './userAgentContentTypes';

export async function refreshRecommendationsContent(_payload: Record<string, unknown>, deps: ContentDeps): Promise<void> {
  const now = new Date();
  const events = deps.getLatestEvents(120);
  const eventSummary = summarizeEvents(events);
  const watchlistSymbols = (deps.getWatchlistAssets?.(30) ?? [])
    .map((item) => item.symbol.trim().toUpperCase())
    .filter(Boolean);
  const generatedAt = now.toISOString();
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  deps.sql.exec('DELETE FROM recommendations');

  const supportedChains = getSupportedMarketChains();
  const [topGainersResult, marketCapResult, trendingResult] = await Promise.allSettled([
    fetchTopMarketAssets(deps.env, {
      name: 'topGainers',
      limit: 20,
      source: 'auto',
      chains: supportedChains,
    }),
    fetchTopMarketAssets(deps.env, {
      name: 'marketCap',
      limit: 80,
      source: 'auto',
      chains: supportedChains,
    }),
    fetchTopMarketAssets(deps.env, {
      name: 'trending',
      limit: 40,
      source: 'auto',
      chains: supportedChains,
    }),
  ]);
  const marketAssets = topGainersResult.status === 'fulfilled' ? topGainersResult.value : [];
  const metadataAssets: MarketTopAsset[] = [
    ...marketAssets,
    ...(marketCapResult.status === 'fulfilled' ? marketCapResult.value : []),
    ...(trendingResult.status === 'fulfilled' ? trendingResult.value : []),
  ];

  const userTopAssets = mergePreferredAssets(eventSummary.topAssets, watchlistSymbols, 10).slice(0, 5);
  const portfolioHoldings = getPortfolioHoldings(deps.sql, supportedChains);

  // Product decision: if the LLM does not produce usable recommendations, keep this list empty.
  let rows: Array<{ category: string; asset: string; reason: string; score: number }> = [];
  const marketAssetLookup = buildRecommendationAssetLookup(metadataAssets);

  const preferredLocale = deps.getPreferredLocale?.() ?? null;
  const language = resolveRecommendationLanguage(preferredLocale);
  const portfolioContext = buildPortfolioContext(deps.sql);

  const llmStatus = getLlmStatus(deps.env);
  if (llmStatus.enabled && marketAssets.length > 0) {
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
              watchlistSymbols,
              portfolioContext,
              marketAssets,
              userTopAssets,
              language,
              supportedChains,
            ),
          },
        ],
        temperature: 0.3,
        maxTokens: 1200,
      });
      const parsed = parseLlmRecommendations(llmResult.text);
      if (parsed.length > 0) {
        rows = parsed.slice(0, 5);
      }
    } catch (error) {
      const llmError = getLlmErrorInfo(error);
      console.error('recommendation_llm_failed', {
        ...llmError,
        llm: llmStatus,
      });
    }
  }

  rows = rows.filter((row) => !isExcludedRecommendationAsset(row.asset));

  const allowedSymbols = new Set(
    [
      ...marketAssets.map((asset) => (asset.symbol ?? '').trim().toUpperCase()),
      ...portfolioHoldings.map((holding) => holding.symbol.trim().toUpperCase()),
      ...watchlistSymbols,
    ].filter((symbol) => Boolean(symbol) && !isExcludedRecommendationAsset(symbol)),
  );
  if (allowedSymbols.size > 0) {
    rows = rows.filter((row) => allowedSymbols.has(row.asset.trim().toUpperCase()));
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

function buildRecommendationSystemPrompt(language: RecommendationLanguage): string {
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
    `- Never recommend stablecoins such as ${Array.from(EXCLUDED_RECOMMENDATION_SYMBOLS).join(', ')}.`,
  ].join('\n');
}

function buildRecommendationUserPrompt(
  eventSummary: { counts: Record<string, number>; topAssets: string[] },
  watchlistSymbols: string[],
  portfolioContext: string,
  marketAssets: MarketTopAsset[],
  userTopAssets: string[],
  language: RecommendationLanguage,
  supportedChains: Array<'eth' | 'base' | 'bnb' | 'tron' | 'sol' | 'btc'>,
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
    `Watchlist assets: ${watchlistSymbols.join(', ') || 'N/A'}`,
    ``,
    `--- Market Trending (CoinGecko + Bitget) ---`,
    marketLines || '  No market data available.',
    `Supported chains: ${supportedChains.join(', ') || 'eth,base,bnb,tron,sol,btc'}`,
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
    `- If watchlist assets exist, prioritize at least 1 watchlist coin`,
    `- Diversify across different chains and risk profiles when possible`,
    `- Recommendations should be actionable investment suggestions`,
  ].join('\n');
}
