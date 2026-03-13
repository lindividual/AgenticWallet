import { fetchNewsHeadlines } from '../durableObjects/userAgentRss';
import { generateWithLlm, getLlmErrorInfo, getLlmStatus } from './llm';
import type { ArticleRelatedAssetRef } from './articleRelatedAssets';
import type { MarketTopAsset } from './bitgetWallet';
import { fetchTopMarketAssets } from './marketTopAssets';
import { fetchOpenNewsCryptoNews, fetchOpenTwitterCryptoTweets, type NewsItem, type TweetItem } from './openNews';
import {
  fetchTradeBrowse,
  type TradeBrowseMarketItem,
  type TradeBrowsePredictionItem,
} from './tradeBrowse';
import type { Bindings } from '../types';

const TOPIC_SPECIAL_SLOT_HOURS = 4;
const TOPIC_SPECIAL_DAILY_MAX_COUNT = 10;
const TOPIC_SPECIAL_MAX_COUNT_PER_SLOT = 5;
const SOURCE_REFERENCE_LIMIT = 18;
const SUMMARY_MAX_LENGTH = 180;
const TOPIC_SPECIAL_LLM_RETRY_ATTEMPTS = 3;
const TOPIC_SPECIAL_ARTICLE_MAX_TOKENS = 1400;
const TOPIC_SPECIAL_INTER_ARTICLE_DELAY_MS = 750;
const TOPIC_SPECIAL_MAX_SPOT_REFS = 4;
const TOPIC_SPECIAL_MAX_PERP_REFS = 2;
const TOPIC_SPECIAL_MAX_PREDICTION_REFS = 2;
const TOPIC_PREDICTION_STOPWORDS = new Set([
  'about',
  'after',
  'before',
  'between',
  'could',
  'crypto',
  'from',
  'have',
  'into',
  'market',
  'markets',
  'price',
  'rates',
  'than',
  'that',
  'their',
  'there',
  'these',
  'this',
  'topic',
  'update',
  'with',
]);

const TOPIC_NEWS_KEYWORDS = [
  'bitcoin',
  'ethereum',
  'crypto',
  'stablecoin',
  'etf',
  'fed',
  'interest rate',
  'treasury',
  'nasdaq',
  's&p 500',
];

const TOPIC_TWITTER_KEYWORDS = [
  'bitcoin',
  'ethereum',
  'crypto',
  'fed',
  'rates',
  'risk-on',
  'risk-off',
  'nasdaq',
  'etf',
  'stablecoin',
];

type TopicDraft = {
  topic: string;
  summary: string;
  relatedAssets: string[];
  sourceRefs: string[];
};

type PromptDebugStats = {
  systemChars: number;
  userChars: number;
  totalChars: number;
  systemEstimatedTokens: number;
  userEstimatedTokens: number;
  totalEstimatedTokens: number;
};

type TopicSpecialArticleRow = {
  id: string;
  slot_key: string;
  topic_slug: string;
  title: string;
  summary: string;
  r2_key: string;
  related_assets_json: string;
  source_refs_json: string;
  generated_at: string;
  status: string;
};

export type TopicSpecialGenerationResult = {
  slotKey: string;
  generated: number;
  skipped: boolean;
  totalInSlot: number;
};

let topicSpecialSchemaReady = false;

function choosePreferredMarketAsset(candidate: MarketTopAsset, current: MarketTopAsset): boolean {
  const candidateRank = Number(candidate.market_cap_rank ?? Number.MAX_SAFE_INTEGER);
  const currentRank = Number(current.market_cap_rank ?? Number.MAX_SAFE_INTEGER);
  if (candidateRank !== currentRank) return candidateRank < currentRank;
  const candidateHasImage = Boolean(candidate.image?.trim());
  const currentHasImage = Boolean(current.image?.trim());
  if (candidateHasImage !== currentHasImage) return candidateHasImage;
  return false;
}

export async function generateTopicSpecialBatch(
  env: Bindings,
  options?: { force?: boolean; slotKey?: string },
): Promise<TopicSpecialGenerationResult> {
  await ensureTopicSpecialSchema(env.DB);
  const slotKey = options?.slotKey?.trim() || getTopicSpecialSlotKey(new Date());
  const dateKey = slotKey.slice(0, 10);
  const existingRows = await listTopicRowsInSlot(env.DB, slotKey);
  const existingCount = existingRows.length;
  const dailyCount = await countTopicsForDate(env.DB, dateKey);
  const remainingDailyCapacity = Math.max(TOPIC_SPECIAL_DAILY_MAX_COUNT - dailyCount, 0);

  if (existingCount >= TOPIC_SPECIAL_MAX_COUNT_PER_SLOT) {
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }

  if (remainingDailyCapacity === 0) {
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }

  const [newsItems, twitterItems, rssHeadlines, marketAssets, tradeBrowse] = await Promise.all([
    fetchOpenNewsCryptoNews(env, {
      keywords: TOPIC_NEWS_KEYWORDS,
      limit: 14,
    }).catch(() => [] as NewsItem[]),
    fetchOpenTwitterCryptoTweets(env, {
      keywords: TOPIC_TWITTER_KEYWORDS,
      limit: 10,
    }).catch(() => [] as TweetItem[]),
    fetchNewsHeadlines(env).catch(() => [] as string[]),
    fetchTopMarketAssets(env, {
      name: 'marketCap',
      source: 'auto',
      limit: 20,
    }).catch(() => [] as MarketTopAsset[]),
    fetchTradeBrowse(env).catch(() => ({
      generatedAt: new Date().toISOString(),
      topMovers: [] as TradeBrowseMarketItem[],
      trendings: [] as TradeBrowseMarketItem[],
      perps: [] as TradeBrowseMarketItem[],
      predictions: [] as TradeBrowsePredictionItem[],
    })),
  ]);

  const sourceRefs = buildSourceReferences(newsItems, twitterItems, rssHeadlines);
  const defaultAssets = buildDefaultAssetPool(marketAssets, newsItems);
  const llmStatus = getLlmStatus(env);
  const drafts = await buildTopicDrafts(env, llmStatus, sourceRefs, defaultAssets);

  const existingSlugs = new Set(existingRows.map((row) => row.topic_slug));
  const candidateDrafts = drafts
    .filter((draft) => {
      const slug = slugifyTopic(draft.topic);
      return Boolean(slug) && !existingSlugs.has(slug);
    })
    .slice(0, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);

  const remainingSlotCapacity = Math.max(TOPIC_SPECIAL_MAX_COUNT_PER_SLOT - existingCount, 0);
  if (remainingSlotCapacity === 0) {
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }

  const remainingSlotsInDay = getRemainingTopicSlotsInDay(slotKey);
  const desiredTotalInSlot = Math.min(
    TOPIC_SPECIAL_MAX_COUNT_PER_SLOT,
    Math.max(1, Math.ceil(remainingDailyCapacity / remainingSlotsInDay)),
  );
  const desiredNewCount = Math.max(desiredTotalInSlot - existingCount, 0);
  const targetNewCount = Math.min(
    remainingDailyCapacity,
    remainingSlotCapacity,
    Math.max(desiredNewCount, options?.force === true ? 1 : 0),
  );
  if (targetNewCount <= 0) {
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }
  const selectedDrafts = candidateDrafts.slice(0, targetNewCount);

  let generated = 0;
  for (const [index, draft] of selectedDrafts.entries()) {
    const topicSlug = slugifyTopic(draft.topic);
    if (!topicSlug) continue;
    if (existingSlugs.has(topicSlug)) continue;
    if (index > 0 && llmStatus.enabled) {
      await sleep(TOPIC_SPECIAL_INTER_ARTICLE_DELAY_MS);
    }

    const articleId = crypto.randomUUID();
    const generatedAt = new Date().toISOString();
    const r2Key = buildTopicR2Key(slotKey, topicSlug, articleId);
    const normalizedAssets = normalizeAssetSymbols(draft.relatedAssets, defaultAssets);
    const relatedAssetRefs = await buildTopicRelatedAssetRefs(env, {
      topic: draft.topic,
      summary: draft.summary,
      symbols: normalizedAssets,
      marketAssets,
      perps: tradeBrowse.perps,
      predictions: tradeBrowse.predictions,
    });
    const normalizedRefs = normalizeSourceRefs(draft.sourceRefs.length > 0 ? draft.sourceRefs : sourceRefs);
    const markdown = await buildTopicArticleMarkdown(
      env,
      llmStatus,
      {
        slotKey,
        topic: draft.topic,
        summary: draft.summary,
        relatedAssets: normalizedAssets,
        sourceRefs: normalizedRefs,
      },
    );
    try {
      await env.AGENT_ARTICLES.put(r2Key, markdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('topic_special_r2_put_failed', {
        slotKey,
        topicSlug,
        r2Key,
        message,
      });
      throw new Error(`topic_special_r2_store_failed:${topicSlug}:${message}`);
    }

    try {
      await env.DB.prepare(
        `INSERT INTO topic_special_articles (
           id,
           slot_key,
           topic_slug,
           title,
           summary,
           r2_key,
           related_assets_json,
           source_refs_json,
           generated_at,
           status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          articleId,
          slotKey,
          topicSlug,
          draft.topic,
          truncateSummary(draft.summary),
          r2Key,
          JSON.stringify(relatedAssetRefs),
          JSON.stringify(normalizedRefs),
          generatedAt,
          'ready',
        )
        .run();
      generated += 1;
      existingSlugs.add(topicSlug);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('topic_special_insert_failed', {
        slotKey,
        topicSlug,
        message,
      });
      try {
        await env.AGENT_ARTICLES.delete(r2Key);
      } catch (cleanupError) {
        console.error('topic_special_r2_cleanup_failed', {
          slotKey,
          topicSlug,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw new Error(`topic_special_index_failed:${topicSlug}:${message}`);
    }
  }

  const totalInSlot = await countTopicsInSlot(env.DB, slotKey);
  return {
    slotKey,
    generated,
    skipped: generated === 0,
    totalInSlot,
  };
}

export async function ensureTopicSpecialSchema(db: D1Database): Promise<void> {
  if (topicSpecialSchemaReady) return;
  try {
    await db.prepare('SELECT id FROM topic_special_articles LIMIT 1').first();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`topic_special_schema_missing_run_migrations:${message}`);
  }
  topicSpecialSchemaReady = true;
}

async function listTopicRowsInSlot(db: D1Database, slotKey: string): Promise<Array<Pick<TopicSpecialArticleRow, 'topic_slug'>>> {
  const result = await db
    .prepare(
      `SELECT topic_slug
       FROM topic_special_articles
       WHERE slot_key = ?`,
    )
    .bind(slotKey)
    .all<{ topic_slug: string }>();
  return result.results ?? [];
}

async function countTopicsInSlot(db: D1Database, slotKey: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM topic_special_articles
       WHERE slot_key = ?`,
    )
    .bind(slotKey)
    .first<{ count: number }>();
  const count = Number(row?.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

async function countTopicsForDate(db: D1Database, dateKey: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM topic_special_articles
       WHERE slot_key LIKE ?`,
    )
    .bind(`${dateKey}T%`)
    .first<{ count: number }>();
  const count = Number(row?.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export function getTopicSpecialSlotKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  const slotHour = Math.floor(date.getUTCHours() / TOPIC_SPECIAL_SLOT_HOURS) * TOPIC_SPECIAL_SLOT_HOURS;
  const hour = `${slotHour}`.padStart(2, '0');
  return `${year}-${month}-${day}T${hour}`;
}

function getRemainingTopicSlotsInDay(slotKey: string): number {
  const hour = Number(slotKey.slice(11, 13));
  if (!Number.isFinite(hour) || hour < 0 || hour >= 24) return 1;
  return Math.max(1, Math.floor((24 - hour) / TOPIC_SPECIAL_SLOT_HOURS));
}

function buildTopicDraftPrompt(sourceRefs: string[], defaultAssets: string[]): string {
  const refsBlock = sourceRefs.length > 0
    ? sourceRefs.slice(0, SOURCE_REFERENCE_LIMIT).map((line) => `- ${line}`).join('\n')
    : '- No external source lines available; use robust macro+crypto framing.';
  const assetBlock = defaultAssets.length > 0 ? defaultAssets.join(', ') : 'BTC, ETH, SOL, USDC';

  return [
    'Create 3 to 5 topic objects in JSON array format.',
    'Each object must include:',
    '- "topic": concise title',
    '- "summary": one sentence (< 180 chars)',
    '- "related_assets": array with 2 to 5 uppercase symbols',
    '- "source_refs": array with 1 to 3 short references copied from input lines',
    '',
    'Hard requirements:',
    '- Blend traditional finance and crypto perspectives.',
    '- Prioritize actionable investment monitoring angles.',
    '- Do not output markdown.',
    '- Do not output keys other than topic, summary, related_assets, source_refs.',
    '',
    `Candidate assets: ${assetBlock}`,
    '',
    'Input source lines:',
    refsBlock,
  ].join('\n');
}

async function buildTopicDrafts(
  env: Bindings,
  llmStatus: ReturnType<typeof getLlmStatus>,
  sourceRefs: string[],
  defaultAssets: string[],
): Promise<TopicDraft[]> {
  if (!llmStatus.enabled) {
    console.warn('topic_special_draft_llm_disabled_using_fallback', {
      sourceRefCount: sourceRefs.length,
      defaultAssetCount: defaultAssets.length,
    });
    return buildFallbackTopicDrafts(sourceRefs, defaultAssets);
  }

  try {
    const systemPrompt = [
      'You are a market strategist writing topic plans for a fintech wallet app.',
      'Generate 3 to 5 investable topics that connect traditional finance and crypto markets.',
      'Topics must be grounded in provided news and Twitter signals.',
      'Output strict JSON array only.',
    ].join(' ');
    const userPrompt = buildTopicDraftPrompt(sourceRefs, defaultAssets);
    const promptStats = buildPromptDebugStats(systemPrompt, userPrompt);
    console.log('topic_special_draft_llm_request', {
      ...promptStats,
      sourceRefCount: sourceRefs.length,
      defaultAssetCount: defaultAssets.length,
      model: llmStatus.model,
      baseUrl: llmStatus.baseUrl,
      retryAttempts: TOPIC_SPECIAL_LLM_RETRY_ATTEMPTS,
    });
    const llmResult = await generateWithLlm(env, {
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      temperature: 0.35,
      maxTokens: 1600,
      retryAttempts: TOPIC_SPECIAL_LLM_RETRY_ATTEMPTS,
      maxRetryDelayMs: 60_000,
    });
    console.log('topic_special_draft_llm_succeeded', {
      requestId: llmResult.requestId ?? null,
      cfRay: llmResult.cfRay ?? null,
      openaiProject: llmResult.openaiProject ?? null,
      openaiOrganization: llmResult.openaiOrganization ?? null,
      keyFingerprint: llmResult.keyFingerprint ?? null,
      responseChars: llmResult.text.length,
      responseEstimatedTokens: estimateTokenCount(llmResult.text),
    });
    const drafts = parseTopicDrafts(llmResult.text, defaultAssets, sourceRefs);
    if (drafts.length < 3) {
      console.warn('topic_special_draft_llm_insufficient_results_using_fallback', {
        draftCount: drafts.length,
        sourceRefCount: sourceRefs.length,
      });
      return buildFallbackTopicDrafts(sourceRefs, defaultAssets);
    }
    return drafts;
  } catch (error) {
    const llmError = getLlmErrorInfo(error);
    console.error('topic_special_draft_llm_failed', {
      ...llmError,
      llm: llmStatus,
    });
    return buildFallbackTopicDrafts(sourceRefs, defaultAssets);
  }
}

function parseTopicDrafts(text: string, defaultAssets: string[], fallbackRefs: string[]): TopicDraft[] {
  const jsonArray = extractJsonArray(text);
  if (!jsonArray) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonArray);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const drafts: TopicDraft[] = [];
  const seenTopics = new Set<string>();
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;

    const topic = sanitizeTitle(
      typeof row.topic === 'string'
        ? row.topic
        : typeof row.title === 'string'
          ? row.title
          : '',
    );
    if (!topic) continue;
    const topicSlug = slugifyTopic(topic);
    if (!topicSlug || seenTopics.has(topicSlug)) continue;

    const summary = truncateSummary(
      typeof row.summary === 'string' ? row.summary : typeof row.brief === 'string' ? row.brief : '',
    );
    const relatedAssets = normalizeAssetSymbols(readStringArray(row.related_assets) ?? readStringArray(row.relatedAssets), defaultAssets);
    const sourceRefs = normalizeSourceRefs(readStringArray(row.source_refs) ?? readStringArray(row.sourceRefs) ?? fallbackRefs);

    drafts.push({
      topic,
      summary: summary || `Watch ${relatedAssets.join(', ')} around the latest macro and crypto signals.`,
      relatedAssets,
      sourceRefs,
    });
    seenTopics.add(topicSlug);
    if (drafts.length >= TOPIC_SPECIAL_MAX_COUNT_PER_SLOT) break;
  }

  return drafts;
}
type TopicArticleInput = {
  slotKey: string;
  topic: string;
  summary: string;
  relatedAssets: string[];
  sourceRefs: string[];
};

async function buildTopicArticleMarkdown(
  env: Bindings,
  llmStatus: ReturnType<typeof getLlmStatus>,
  input: TopicArticleInput,
): Promise<string> {
  if (!llmStatus.enabled) {
    console.warn('topic_special_article_llm_disabled_using_fallback', {
      slotKey: input.slotKey,
      topic: input.topic,
    });
    return buildFallbackTopicArticleMarkdown(input);
  }

  try {
    const systemPrompt = [
      'You are a cross-market analyst writing actionable topic briefs for wallet users.',
      'Every article must connect traditional finance and crypto market transmission.',
      'Output markdown only.',
      'Include a final "## Related Assets" section with bullet symbols.',
    ].join(' ');
    const userPrompt = buildTopicArticlePrompt(input);
    const promptStats = buildPromptDebugStats(systemPrompt, userPrompt);
    console.log('topic_special_article_llm_request', {
      ...promptStats,
      slotKey: input.slotKey,
      topic: input.topic,
      sourceRefCount: input.sourceRefs.length,
      relatedAssetCount: input.relatedAssets.length,
      model: llmStatus.model,
      baseUrl: llmStatus.baseUrl,
      retryAttempts: TOPIC_SPECIAL_LLM_RETRY_ATTEMPTS,
    });
    const llmResult = await generateWithLlm(env, {
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      temperature: 0.45,
      maxTokens: TOPIC_SPECIAL_ARTICLE_MAX_TOKENS,
      retryAttempts: TOPIC_SPECIAL_LLM_RETRY_ATTEMPTS,
      maxRetryDelayMs: 60_000,
    });
    console.log('topic_special_article_llm_succeeded', {
      slotKey: input.slotKey,
      topic: input.topic,
      requestId: llmResult.requestId ?? null,
      cfRay: llmResult.cfRay ?? null,
      openaiProject: llmResult.openaiProject ?? null,
      openaiOrganization: llmResult.openaiOrganization ?? null,
      keyFingerprint: llmResult.keyFingerprint ?? null,
      responseChars: llmResult.text.length,
      responseEstimatedTokens: estimateTokenCount(llmResult.text),
    });
    const text = llmResult.text.trim();
    if (!text) {
      throw new Error('topic_special_article_empty_response');
    }
    return ensureRelatedAssetsSection(text, input.relatedAssets);
  } catch (error) {
    const llmError = getLlmErrorInfo(error);
    console.error('topic_special_article_llm_failed', {
      ...llmError,
      llm: llmStatus,
      slotKey: input.slotKey,
      topic: input.topic,
    });
    return buildFallbackTopicArticleMarkdown(input);
  }
}

function buildTopicArticlePrompt(input: TopicArticleInput): string {
  const refs = input.sourceRefs.length > 0
    ? input.sourceRefs.slice(0, 8).map((line) => `- ${line}`).join('\n')
    : '- Source coverage is limited; focus on robust risk framing.';

  return [
    `Slot: ${input.slotKey}`,
    `Topic: ${input.topic}`,
    `Summary anchor: ${input.summary}`,
    `Related assets: ${input.relatedAssets.join(', ') || 'BTC, ETH, USDC'}`,
    '',
    'Source references:',
    refs,
    '',
    'Output structure:',
    '- # Title',
    '- ## Why this matters now',
    '- ## TradFi x Crypto transmission',
    '- ## Scenario watch',
    '- ## Action checklist',
    '- ## Related Assets',
    '',
    'Rules:',
    '- 280 to 450 words.',
    '- No fabricated prices or percentages.',
    '- Keep language direct and practical for investors.',
    '- Mention both opportunities and risks.',
  ].join('\n');
}

function buildPromptDebugStats(systemPrompt: string, userPrompt: string): PromptDebugStats {
  const systemChars = systemPrompt.length;
  const userChars = userPrompt.length;
  return {
    systemChars,
    userChars,
    totalChars: systemChars + userChars,
    systemEstimatedTokens: estimateTokenCount(systemPrompt),
    userEstimatedTokens: estimateTokenCount(userPrompt),
    totalEstimatedTokens: estimateTokenCount(`${systemPrompt}\n${userPrompt}`),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.ceil(normalized.length / 4);
}

function ensureRelatedAssetsSection(markdown: string, relatedAssets: string[]): string {
  const lower = markdown.toLowerCase();
  if (lower.includes('## related assets')) {
    return markdown;
  }
  const assetLines = relatedAssets.length > 0
    ? relatedAssets.map((asset) => `- ${asset}`).join('\n')
    : '- BTC\n- ETH\n- USDC';
  return `${markdown.trimEnd()}\n\n## Related Assets\n${assetLines}\n`;
}

function buildFallbackTopicDrafts(sourceRefs: string[], defaultAssets: string[]): TopicDraft[] {
  const fallbackAssets = normalizeAssetSymbols(defaultAssets, ['BTC', 'ETH', 'SOL', 'USDC', 'USDT']);
  const genericRefs = normalizeSourceRefs(sourceRefs);
  const themes: Array<{
    topic: string;
    summary: string;
    keywords: string[];
    assets: string[];
  }> = [
    {
      topic: 'Bitcoin Liquidity and ETF Flow Watch',
      summary: 'Track whether institutional Bitcoin demand stays firm as macro rate expectations reset across global markets.',
      keywords: ['bitcoin', 'btc', 'etf'],
      assets: ['BTC', 'ETH'],
    },
    {
      topic: 'Ethereum Positioning and Yield Rotation',
      summary: 'Watch whether staking demand and liquidity rotation keep reinforcing Ethereum relative strength across risk assets.',
      keywords: ['ethereum', 'eth', 'staking', 'yield'],
      assets: ['ETH', 'SOL'],
    },
    {
      topic: 'Stablecoin Policy and Payment Rails',
      summary: 'Policy headlines around stablecoins can quickly reprice payment narratives, exchange liquidity, and crypto beta.',
      keywords: ['stablecoin', 'usdc', 'usdt', 'payment', 'regulation'],
      assets: ['USDC', 'USDT', 'ETH'],
    },
    {
      topic: 'Macro Risk Appetite and Crypto Beta',
      summary: 'Rates, equities, and liquidity signals still set the tone for how aggressively traders price crypto upside and downside.',
      keywords: ['fed', 'rate', 'rates', 'treasury', 'nasdaq', 's&p', 'risk-on', 'risk-off'],
      assets: ['BTC', 'ETH', 'SOL'],
    },
  ];

  const drafts = themes.map((theme) => ({
    topic: theme.topic,
    summary: truncateSummary(theme.summary),
    relatedAssets: normalizeAssetSymbols([...theme.assets, ...fallbackAssets], fallbackAssets),
    sourceRefs: pickTopicSourceRefs(genericRefs, theme.keywords),
  }));

  if (drafts.length >= 3) {
    return drafts.slice(0, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);
  }

  return [
    ...drafts,
    {
      topic: 'Cross-Market Liquidity Rotation',
      summary: 'Monitor whether the next macro headline broadens into crypto leadership or leaves the market stuck in a narrow range.',
      relatedAssets: fallbackAssets,
      sourceRefs: genericRefs.slice(0, 3),
    },
  ].slice(0, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);
}

function pickTopicSourceRefs(sourceRefs: string[], keywords: string[]): string[] {
  const loweredKeywords = keywords.map((keyword) => keyword.toLowerCase());
  const matched = sourceRefs.filter((line) => {
    const lower = line.toLowerCase();
    return loweredKeywords.some((keyword) => lower.includes(keyword));
  });
  if (matched.length > 0) return matched.slice(0, 3);
  if (sourceRefs.length > 0) return sourceRefs.slice(0, Math.min(3, sourceRefs.length));
  return ['Macro and crypto signals remain mixed across liquidity, policy, and risk appetite.'];
}

function buildFallbackTopicArticleMarkdown(input: TopicArticleInput): string {
  const relatedAssets = normalizeAssetSymbols(input.relatedAssets, ['BTC', 'ETH', 'USDC']);
  const sourceRefs = normalizeSourceRefs(input.sourceRefs);
  const sourceLines = sourceRefs.length > 0
    ? sourceRefs.map((line) => `- ${line}`).join('\n')
    : '- Macro and crypto signals remain mixed across liquidity, policy, and risk appetite.';
  const primaryAssets = relatedAssets.slice(0, 2).join(' and ') || 'BTC and ETH';
  const allAssets = relatedAssets.join(', ') || 'BTC, ETH, USDC';

  return [
    `# ${input.topic}`,
    '',
    '## Why this matters now',
    `${input.summary} The key question is whether the current headline keeps attracting fresh capital or fades once the next macro catalyst arrives.`,
    '',
    '## TradFi x Crypto transmission',
    `Traditional finance catalysts such as rates, ETF flows, regulation, and equity leadership often feed directly into crypto positioning. In practice, that means moves in ${primaryAssets} can be reinforced by broader liquidity conditions, while stablecoin balances and exchange activity help confirm whether the move has depth.`,
    '',
    'Current source signals:',
    sourceLines,
    '',
    '## Scenario watch',
    `- Bullish: capital rotation broadens from the headline into ${allAssets}, with follow-through across spot activity and market breadth.`,
    '- Neutral: the narrative stays in the news, but price action remains range-bound and conviction stays selective.',
    `- Risk: the next macro or policy update reverses sentiment, forcing traders to cut exposure before ${allAssets} can confirm momentum.`,
    '',
    '## Action checklist',
    '- Track the next catalyst tied to the source signals above.',
    '- Confirm whether flows broaden beyond the first headline asset into related assets.',
    '- Reassess sizing quickly if price action diverges from the narrative.',
    '',
    '## Related Assets',
    ...relatedAssets.map((asset) => `- ${asset}`),
    '',
  ].join('\n');
}

function buildSourceReferences(newsItems: NewsItem[], twitterItems: TweetItem[], rssHeadlines: string[]): string[] {
  const refs: string[] = [];

  for (const item of newsItems) {
    const title = item.title.trim();
    if (!title) continue;
    const source = item.source ? ` (${item.source.trim()})` : '';
    refs.push(`${title}${source}`.slice(0, 180));
  }

  for (const headline of rssHeadlines) {
    const line = headline.trim();
    if (!line) continue;
    refs.push(line.slice(0, 180));
  }

  for (const tweet of twitterItems) {
    const text = tweet.text.trim();
    if (!text) continue;
    const handle = tweet.handle?.trim() ? `@${tweet.handle.trim()}: ` : '';
    refs.push(`${handle}${text.slice(0, 140)}`);
  }

  const deduped = new Set<string>();
  const output: string[] = [];
  for (const item of refs) {
    const normalized = item.trim();
    if (!normalized) continue;
    if (deduped.has(normalized)) continue;
    deduped.add(normalized);
    output.push(normalized);
    if (output.length >= SOURCE_REFERENCE_LIMIT) break;
  }

  return output;
}

function buildDefaultAssetPool(marketAssets: MarketTopAsset[], newsItems: NewsItem[]): string[] {
  const output: string[] = [];
  for (const asset of marketAssets) {
    const symbol = normalizeAssetSymbol(asset.symbol);
    if (!symbol) continue;
    output.push(symbol);
    if (output.length >= 8) break;
  }

  for (const item of newsItems) {
    const symbol = normalizeAssetSymbol(item.coin);
    if (!symbol) continue;
    output.push(symbol);
    if (output.length >= 12) break;
  }

  const deduped = dedupeStrings(output).filter((item) => normalizeAssetSymbol(item) != null);
  if (deduped.length >= 3) return deduped;
  return dedupeStrings([...deduped, 'BTC', 'ETH', 'SOL', 'USDC', 'USDT']);
}

type TopicRelatedRefCandidate = {
  key: string;
  ref: ArticleRelatedAssetRef;
};

function normalizePredictionSearchText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizePredictionText(raw: string): string[] {
  return normalizePredictionSearchText(raw)
    .split(' ')
    .map((item) => item.trim())
    .filter((item) => item.length >= 4 && !TOPIC_PREDICTION_STOPWORDS.has(item));
}

function normalizePerpBaseSymbol(raw: string): string | null {
  const upper = raw.trim().toUpperCase().replace(/[_\s]+/g, '');
  if (!upper) return null;
  const stripped = upper.replace(/-PERP$/i, '').replace(/PERP$/i, '');
  const slashIndex = stripped.indexOf('/');
  const withoutSlash = slashIndex > 0 ? stripped.slice(0, slashIndex) : stripped;
  const dashIndex = withoutSlash.indexOf('-');
  const withoutDash = dashIndex > 0 ? withoutSlash.slice(0, dashIndex) : withoutSlash;
  for (const suffix of ['USDT', 'USDC', 'USD', 'FDUSD', 'BUSD']) {
    if (withoutDash.endsWith(suffix) && withoutDash.length > suffix.length) {
      return withoutDash.slice(0, -suffix.length) || null;
    }
  }
  return withoutDash || null;
}

function choosePredictionPrimarySymbol(
  prediction: TradeBrowsePredictionItem,
  symbols: string[],
  assetNamesBySymbol: Map<string, string>,
): string {
  const haystack = ` ${normalizePredictionSearchText(prediction.title)} `;
  for (const symbol of symbols) {
    const name = assetNamesBySymbol.get(symbol);
    if (name && haystack.includes(` ${normalizePredictionSearchText(name)} `)) {
      return symbol;
    }
    if (haystack.includes(` ${symbol.toLowerCase()} `)) {
      return symbol;
    }
  }
  return symbols[0] ?? 'EVENT';
}

function scorePredictionCandidate(
  prediction: TradeBrowsePredictionItem,
  topic: string,
  summary: string,
  symbols: string[],
  assetNamesBySymbol: Map<string, string>,
): number {
  const haystack = ` ${normalizePredictionSearchText(`${prediction.title} ${prediction.options.map((item) => item.label).join(' ')}`)} `;
  let score = 0;

  for (const symbol of symbols) {
    if (haystack.includes(` ${symbol.toLowerCase()} `)) {
      score += 8;
    }
    const name = assetNamesBySymbol.get(symbol);
    if (name) {
      const normalizedName = normalizePredictionSearchText(name);
      if (normalizedName && haystack.includes(` ${normalizedName} `)) {
        score += 10;
      }
    }
  }

  const topicTokens = new Set([
    ...tokenizePredictionText(topic),
    ...tokenizePredictionText(summary),
  ]);
  for (const token of topicTokens) {
    if (haystack.includes(` ${token} `)) score += 2;
  }

  score += Math.min(6, Math.log10(Math.max(1, Number(prediction.volume24h ?? 0) + 1)));
  return score;
}

async function buildTopicRelatedAssetRefs(
  _env: Bindings,
  input: {
    topic: string;
    summary: string;
    symbols: string[];
    marketAssets: MarketTopAsset[];
    perps: TradeBrowseMarketItem[];
    predictions: TradeBrowsePredictionItem[];
  },
): Promise<ArticleRelatedAssetRef[]> {
  const assetBySymbol = new Map<string, MarketTopAsset>();
  for (const asset of input.marketAssets) {
    const symbol = normalizeAssetSymbol(asset.symbol);
    if (!symbol) continue;
    const current = assetBySymbol.get(symbol);
    if (!current || choosePreferredMarketAsset(asset, current)) {
      assetBySymbol.set(symbol, asset);
    }
  }

  const assetNamesBySymbol = new Map<string, string>();
  for (const [symbol, asset] of assetBySymbol) {
    if (asset.name?.trim()) assetNamesBySymbol.set(symbol, asset.name.trim());
  }

  const candidates: TopicRelatedRefCandidate[] = [];
  for (const symbol of input.symbols.slice(0, TOPIC_SPECIAL_MAX_SPOT_REFS)) {
    const matched = assetBySymbol.get(symbol) ?? null;
    candidates.push({
      key: `spot:${symbol}`,
      ref: {
        symbol,
        market_type: 'spot',
        market_item_id: null,
        asset_id: matched?.asset_id ?? null,
        instrument_id: null,
        chain: matched?.chain ?? null,
        contract: matched?.contract || null,
        name: matched?.name ?? null,
        image: matched?.image ?? null,
        price_change_percentage_24h: matched?.price_change_percentage_24h ?? null,
      },
    });
  }

  const perpByBaseSymbol = new Map<string, TradeBrowseMarketItem[]>();
  for (const perp of input.perps) {
    const baseSymbol = normalizePerpBaseSymbol(perp.symbol);
    if (!baseSymbol) continue;
    const list = perpByBaseSymbol.get(baseSymbol);
    if (list) {
      list.push(perp);
    } else {
      perpByBaseSymbol.set(baseSymbol, [perp]);
    }
  }
  let perpCount = 0;
  for (const symbol of input.symbols) {
    if (perpCount >= TOPIC_SPECIAL_MAX_PERP_REFS) break;
    const matchedPerp = (perpByBaseSymbol.get(symbol) ?? [])
      .slice()
      .sort((a, b) => Number(b.volume24h ?? 0) - Number(a.volume24h ?? 0))[0];
    if (!matchedPerp) continue;
    candidates.push({
      key: `perp:${matchedPerp.id}`,
      ref: {
        symbol,
        market_type: 'perp',
        market_item_id: matchedPerp.id,
        asset_id: null,
        instrument_id: null,
        name: matchedPerp.name,
        image: matchedPerp.image,
        price_change_percentage_24h: matchedPerp.change24h,
      },
    });
    perpCount += 1;
  }

  const scoredPredictions = input.predictions
    .map((prediction) => ({
      prediction,
      score: scorePredictionCandidate(
        prediction,
        input.topic,
        input.summary,
        input.symbols,
        assetNamesBySymbol,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const item of scoredPredictions.slice(0, TOPIC_SPECIAL_MAX_PREDICTION_REFS)) {
    const primarySymbol = choosePredictionPrimarySymbol(item.prediction, input.symbols, assetNamesBySymbol);
    candidates.push({
      key: `prediction:${item.prediction.id}`,
      ref: {
        symbol: primarySymbol,
        market_type: 'prediction',
        market_item_id: item.prediction.id,
        asset_id: null,
        instrument_id: null,
        name: item.prediction.title,
        image: item.prediction.image,
        price_change_percentage_24h: null,
      },
    });
  }

  return [...new Map(candidates.map((item) => [item.key, item.ref])).values()].slice(0, 8);
}

function normalizeAssetSymbols(assets: string[] | null | undefined, fallbackAssets: string[]): string[] {
  const input = assets ?? [];
  const normalized = input
    .map((asset) => normalizeAssetSymbol(asset))
    .filter((value): value is string => Boolean(value));
  const deduped = dedupeStrings(normalized);
  if (deduped.length >= 2) return deduped.slice(0, 5);

  const fallback = dedupeStrings(
    fallbackAssets.map((asset) => normalizeAssetSymbol(asset)).filter((value): value is string => Boolean(value)),
  );
  const merged = dedupeStrings([...deduped, ...fallback, 'BTC', 'ETH', 'USDC']);
  return merged.slice(0, 5);
}

function normalizeSourceRefs(refs: string[] | null | undefined): string[] {
  const input = refs ?? [];
  const normalized = input
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.slice(0, 180));
  const deduped = dedupeStrings(normalized);
  return deduped.slice(0, 8);
}

function normalizeAssetSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized) return null;
  if (normalized.length < 2 || normalized.length > 12) return null;
  return normalized;
}

function readStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values = raw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return values.length > 0 ? values : null;
}

function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function truncateSummary(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length <= SUMMARY_MAX_LENGTH) return cleaned;
  return `${cleaned.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}...`;
}

function slugifyTopic(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function buildTopicR2Key(slotKey: string, topicSlug: string, articleId: string): string {
  return `special-topics/${slotKey}/${topicSlug}-${articleId}.md`;
}

function dedupeStrings(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(key);
  }
  return output;
}

function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  if (candidate.startsWith('[') && candidate.endsWith(']')) return candidate;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}
