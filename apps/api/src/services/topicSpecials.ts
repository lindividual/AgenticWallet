import { fetchNewsHeadlines } from '../durableObjects/userAgentRss';
import { generateWithLlm, getLlmErrorInfo, getLlmStatus } from './llm';
import type { ArticleRelatedAssetRef } from './articleRelatedAssets';
import type { MarketTopAsset } from './bitgetWallet';
import { fetchDexScreenerMemeHeat, type DexScreenerMemeHeatItem } from './dexScreener';
import { fetchTopMarketAssets } from './marketTopAssets';
import { fetchOpenNewsCryptoNews, fetchOpenTwitterCryptoTweets, type NewsItem, type TweetItem } from './openNews';
import {
  fetchTradeBrowse,
  type TradeBrowseMarketItem,
  type TradeBrowsePredictionItem,
} from './tradeBrowse';
import { deleteArticleMarkdownContent, putArticleMarkdownContent } from '../durableObjects/userAgentArticleContentStore';
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
const TOPIC_SPECIAL_HISTORY_LOOKBACK_DAYS = 5;
const TOPIC_SPECIAL_HISTORY_LIMIT = 48;
const TOPIC_SPECIAL_STRICT_COOLDOWN_HOURS = 36;
const TOPIC_SPECIAL_ASSET_COOLDOWN_HOURS = 24;
const TOPIC_STABLE_ASSETS = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'USDD', 'USDP', 'PYUSD', 'FRAX']);
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
  'meme',
  'memecoin',
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
  'meme',
  'memecoin',
  'doge',
  'dogecoin',
  'shib',
  'fed',
  'rates',
  'risk-on',
  'risk-off',
  'nasdaq',
  'etf',
  'stablecoin',
];

type TopicSpecialEditorId = 'majors' | 'meme' | 'perps' | 'prediction';

type TopicDraft = {
  editorId: TopicSpecialEditorId;
  editorLabel: string;
  topic: string;
  summary: string;
  relatedAssets: string[];
  sourceRefs: string[];
  storyKey: string | null;
  editorScore: number;
  chiefScore: number | null;
  chiefReason: string | null;
};

type TopicRecentArticleMemory = {
  topicSlug: string;
  title: string;
  summary: string;
  generatedAt: string;
  relatedAssets: string[];
  sourceRefs: string[];
  storyKey: string | null;
  assetFamily: string;
};

type PromptDebugStats = {
  systemChars: number;
  userChars: number;
  totalChars: number;
  systemEstimatedTokens: number;
  userEstimatedTokens: number;
  totalEstimatedTokens: number;
};

export type TopicSpecialSourcePacket = {
  slotKey: string;
  sourceRefs: string[];
  rssHeadlines: string[];
  defaultAssets: string[];
  memeHeatItems: DexScreenerMemeHeatItem[];
  newsItems: NewsItem[];
  twitterItems: TweetItem[];
  marketAssets: MarketTopAsset[];
  perps: TradeBrowseMarketItem[];
  predictions: TradeBrowsePredictionItem[];
  existingTopicsToday: string[];
};

type TopicDraftGenerationInput = TopicSpecialSourcePacket;

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
  debug?: {
    llm: TopicSpecialPreviewDebug['llm'];
    sources: TopicSpecialPreviewDebug['sources'];
    draft: TopicSpecialPreviewDebug['draft'];
    editors: TopicSpecialPreviewDebug['editors'];
    chief: TopicSpecialPreviewDebug['chief'];
    articles: Array<{
      topic: string;
      topicSlug: string;
      editorId: TopicSpecialEditorId;
      editorLabel: string;
      relatedAssets: string[];
      sourceRefs: string[];
      llm: TopicSpecialPreviewDebug['article'];
    }>;
  };
};

export type TopicSpecialPreviewResult = {
  slotKey: string;
  skipped: boolean;
  totalInSlot: number;
  article: TopicSpecialPersistInput | null;
  debug?: TopicSpecialPreviewDebug;
};

export type TopicSpecialDraftProbeResult = {
  slotKey: string;
  drafts: TopicDraft[];
  debug: TopicSpecialPreviewDebug;
};

export type TopicSpecialDebugOptions = {
  compactDraftPacket?: boolean;
  draftRetryAttempts?: number;
  forceArticleFallback?: boolean;
  omitDraftHeadlineTape?: boolean;
  omitDraftNews?: boolean;
  omitDraftSocial?: boolean;
  omitDraftMemeHeat?: boolean;
  omitDraftSpot?: boolean;
  omitDraftPerps?: boolean;
  omitDraftPredictions?: boolean;
};

export type TopicSpecialPersistInput = {
  id: string;
  topicSlug: string;
  title: string;
  summary: string;
  r2Key: string;
  relatedAssetsJson: string;
  sourceRefsJson: string;
  generatedAt: string;
  markdown: string;
  slotKey: string;
};

export type TopicSpecialPreviewDebug = {
  llm: {
    enabled: boolean;
    provider: string;
    model: string;
    baseUrl: string;
    fallbackEnabled: boolean;
    fallbackProvider: string;
    fallbackModel: string;
    fallbackBaseUrl: string;
  };
  sources: {
    sourceRefCount: number;
    sourceRefPreview: string[];
    defaultAssetCount: number;
    defaultAssetPreview: string[];
    newsCount: number;
    twitterCount: number;
    rssHeadlineCount: number;
    marketAssetCount: number;
    memeHeatCount: number;
    perpCount: number;
    predictionCount: number;
    existingTopicsTodayCount: number;
  };
  draft: {
    mode: 'llm' | 'fallback';
    fallbackReason: 'llm_disabled' | 'insufficient_results' | 'llm_error' | null;
    requestId: string | null;
    cfRay: string | null;
    provider: string | null;
    model: string | null;
    promptStats: PromptDebugStats | null;
    parsedDraftCount: number;
    systemPrompt: string | null;
    userPrompt: string | null;
    responseSnippet: string | null;
    error: ReturnType<typeof getLlmErrorInfo> | null;
  };
  editors: Record<TopicSpecialEditorId, {
    id: TopicSpecialEditorId;
    label: string;
    mode: 'llm' | 'fallback';
    fallbackReason: 'llm_disabled' | 'insufficient_results' | 'llm_error' | null;
    requestId: string | null;
    cfRay: string | null;
    provider: string | null;
    model: string | null;
    promptStats: PromptDebugStats | null;
    generatedDraftCount: number;
    systemPrompt: string | null;
    userPrompt: string | null;
    responseSnippet: string | null;
    error: ReturnType<typeof getLlmErrorInfo> | null;
  }>;
  chief: {
    mode: 'llm' | 'fallback';
    fallbackReason: 'llm_disabled' | 'insufficient_results' | 'llm_error' | null;
    requestId: string | null;
    cfRay: string | null;
    provider: string | null;
    model: string | null;
    promptStats: PromptDebugStats | null;
    selectedDraftCount: number;
    systemPrompt: string | null;
    userPrompt: string | null;
    responseSnippet: string | null;
    error: ReturnType<typeof getLlmErrorInfo> | null;
  };
  article: {
    mode: 'llm' | 'fallback';
    fallbackReason: 'llm_disabled' | 'llm_error' | 'forced_fallback' | null;
    requestId: string | null;
    cfRay: string | null;
    provider: string | null;
    model: string | null;
    promptStats: PromptDebugStats | null;
    systemPrompt: string | null;
    userPrompt: string | null;
    responseSnippet: string | null;
    markdownSnippet: string | null;
    error: ReturnType<typeof getLlmErrorInfo> | null;
  };
};

type TopicSpecialPreviewDebugCollector = TopicSpecialPreviewDebug;
type TopicSpecialArticleDebugCollector = TopicSpecialPreviewDebug['article'];

type TopicSpecialEditorDefinition = {
  id: TopicSpecialEditorId;
  label: string;
  summary: string;
};

const TOPIC_SPECIAL_EDITOR_DEFINITIONS: TopicSpecialEditorDefinition[] = [
  {
    id: 'majors',
    label: 'Majors Editor',
    summary: 'Owns market breadth, stablecoin liquidity, ETF and macro regime, plus leadership rotation across majors and alt leaders.',
  },
  {
    id: 'meme',
    label: 'Meme Editor',
    summary: 'Owns memecoin heat, attention rotation, and retail sentiment topics.',
  },
  {
    id: 'perps',
    label: 'Perps Editor',
    summary: 'Owns futures positioning, leverage, basis, volume, and liquidation-sensitive topics.',
  },
  {
    id: 'prediction',
    label: 'Prediction Editor',
    summary: 'Owns event markets, catalyst repricing, regulatory timing, and narrative inflection topics.',
  },
];

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

function buildEmptyTradeBrowseResponse(): {
  generatedAt: string;
  topMovers: TradeBrowseMarketItem[];
  trendings: TradeBrowseMarketItem[];
  perps: TradeBrowseMarketItem[];
  predictions: TradeBrowsePredictionItem[];
} {
  return {
    generatedAt: new Date().toISOString(),
    topMovers: [],
    trendings: [],
    perps: [],
    predictions: [],
  };
}

function captureDebugText(text: string | null | undefined, maxLength = 8000): string | null {
  const normalized = text?.trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n\n...[truncated]` : normalized;
}

function createTopicArticleDebugCollector(): TopicSpecialPreviewDebug['article'] {
  return {
    mode: 'fallback',
    fallbackReason: null,
    requestId: null,
    cfRay: null,
    provider: null,
    model: null,
    promptStats: null,
    systemPrompt: null,
    userPrompt: null,
    responseSnippet: null,
    markdownSnippet: null,
    error: null,
  };
}

function buildTopicPreviewDebug(
  packet: TopicSpecialSourcePacket,
  llmStatus: ReturnType<typeof getLlmStatus>,
): TopicSpecialPreviewDebugCollector {
  const editorDebugEntries = TOPIC_SPECIAL_EDITOR_DEFINITIONS.map((editor) => [
    editor.id,
    {
      id: editor.id,
      label: editor.label,
      mode: 'fallback' as const,
      fallbackReason: null,
      requestId: null,
      cfRay: null,
      provider: null,
      model: null,
      promptStats: null,
      generatedDraftCount: 0,
      systemPrompt: null,
      userPrompt: null,
      responseSnippet: null,
      error: null,
    },
  ]);

  return {
    llm: {
      enabled: llmStatus.enabled,
      provider: llmStatus.provider,
      model: llmStatus.model,
      baseUrl: llmStatus.baseUrl,
      fallbackEnabled: llmStatus.fallbackEnabled,
      fallbackProvider: llmStatus.fallbackProvider,
      fallbackModel: llmStatus.fallbackModel,
      fallbackBaseUrl: llmStatus.fallbackBaseUrl,
    },
    sources: {
      sourceRefCount: packet.sourceRefs.length,
      sourceRefPreview: packet.sourceRefs.slice(0, 6),
      defaultAssetCount: packet.defaultAssets.length,
      defaultAssetPreview: packet.defaultAssets.slice(0, 8),
      newsCount: packet.newsItems.length,
      twitterCount: packet.twitterItems.length,
      rssHeadlineCount: packet.rssHeadlines.length,
      marketAssetCount: packet.marketAssets.length,
      memeHeatCount: packet.memeHeatItems.length,
      perpCount: packet.perps.length,
      predictionCount: packet.predictions.length,
      existingTopicsTodayCount: packet.existingTopicsToday.length,
    },
    draft: {
      mode: 'fallback',
      fallbackReason: null,
      requestId: null,
      cfRay: null,
      provider: null,
      model: null,
      promptStats: null,
      parsedDraftCount: 0,
      systemPrompt: null,
      userPrompt: null,
      responseSnippet: null,
      error: null,
    },
    editors: Object.fromEntries(editorDebugEntries) as TopicSpecialPreviewDebug['editors'],
    chief: {
      mode: 'fallback',
      fallbackReason: null,
      requestId: null,
      cfRay: null,
      provider: null,
      model: null,
      promptStats: null,
      selectedDraftCount: 0,
      systemPrompt: null,
      userPrompt: null,
      responseSnippet: null,
      error: null,
    },
    article: createTopicArticleDebugCollector(),
  };
}

export async function fetchTopicSpecialSourcePacket(
  env: Bindings,
  options?: {
    slotKey?: string;
    existingTopicsToday?: string[];
  },
): Promise<TopicSpecialSourcePacket> {
  await ensureTopicSpecialSchema(env.DB);
  const slotKey = options?.slotKey?.trim() || getTopicSpecialSlotKey(new Date());
  const dateKey = slotKey.slice(0, 10);
  const existingTopicsToday = options?.existingTopicsToday ?? await listTopicTitlesForDate(env.DB, dateKey);

  const [newsItems, twitterItems, rssHeadlines, marketAssets, memeHeatItems, tradeBrowse] = await Promise.all([
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
    fetchDexScreenerMemeHeat().catch(() => [] as DexScreenerMemeHeatItem[]),
    fetchTradeBrowse(env).catch(() => buildEmptyTradeBrowseResponse()),
  ]);

  const sourceRefs = buildSourceReferences(newsItems, twitterItems, rssHeadlines);
  const defaultAssets = buildDefaultAssetPool(marketAssets, newsItems, memeHeatItems, tradeBrowse.perps);

  return {
    slotKey,
    sourceRefs,
    rssHeadlines,
    defaultAssets,
    memeHeatItems,
    newsItems,
    twitterItems,
    marketAssets,
    perps: tradeBrowse.perps,
    predictions: tradeBrowse.predictions,
    existingTopicsToday,
  };
}

export async function generateTopicSpecialBatch(
  env: Bindings,
  options?: { force?: boolean; slotKey?: string },
): Promise<TopicSpecialGenerationResult> {
  const packet = await fetchTopicSpecialSourcePacket(env, {
    slotKey: options?.slotKey,
  });
  return generateTopicSpecialBatchFromSourcePacket(env, packet, {
    force: options?.force === true,
  });
}

export async function generateTopicSpecialBatchFromSourcePacket(
  env: Bindings,
  packet: TopicSpecialSourcePacket,
  options?: { force?: boolean },
): Promise<TopicSpecialGenerationResult> {
  await ensureTopicSpecialSchema(env.DB);
  const runId = crypto.randomUUID();
  const slotKey = packet.slotKey;
  const dateKey = slotKey.slice(0, 10);
  const existingRows = await listTopicRowsInSlot(env.DB, slotKey);
  const existingCount = existingRows.length;
  const dailyCount = await countTopicsForDate(env.DB, dateKey);
  const existingTopicsToday = await listTopicTitlesForDate(env.DB, dateKey);
  const remainingDailyCapacity = Math.max(TOPIC_SPECIAL_DAILY_MAX_COUNT - dailyCount, 0);
  console.log('topic_special_batch_started', {
    runId,
    slotKey,
    force: options?.force === true,
    existingCount,
    dailyCount,
    remainingDailyCapacity,
    existingTopicsTodayCount: existingTopicsToday.length,
  });

  if (existingCount >= TOPIC_SPECIAL_MAX_COUNT_PER_SLOT) {
    console.log('topic_special_batch_skipped_slot_full', {
      runId,
      slotKey,
      existingCount,
      maxPerSlot: TOPIC_SPECIAL_MAX_COUNT_PER_SLOT,
    });
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }

  if (remainingDailyCapacity === 0) {
    console.log('topic_special_batch_skipped_daily_full', {
      runId,
      slotKey,
      dailyCount,
      dailyMax: TOPIC_SPECIAL_DAILY_MAX_COUNT,
    });
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }

  const llmStatus = getLlmStatus(env);
  const debug = buildTopicPreviewDebug(
    {
      ...packet,
      existingTopicsToday,
    },
    llmStatus,
  );
  console.log('topic_special_batch_sources_loaded', {
    runId,
    slotKey,
    llmEnabled: llmStatus.enabled,
    llmProvider: llmStatus.provider,
    llmModel: llmStatus.model,
    llmBaseUrl: llmStatus.baseUrl,
    fallbackEnabled: llmStatus.fallbackEnabled,
    fallbackProvider: llmStatus.fallbackProvider,
    fallbackModel: llmStatus.fallbackModel,
    fallbackBaseUrl: llmStatus.fallbackBaseUrl,
    newsCount: packet.newsItems.length,
    twitterCount: packet.twitterItems.length,
    rssHeadlineCount: packet.rssHeadlines.length,
    marketAssetCount: packet.marketAssets.length,
    memeHeatCount: packet.memeHeatItems.length,
    perpCount: packet.perps.length,
    predictionCount: packet.predictions.length,
    sourceRefCount: packet.sourceRefs.length,
    defaultAssetCount: packet.defaultAssets.length,
  });
  const drafts = await buildTopicDrafts(env, llmStatus, {
    slotKey,
    sourceRefs: packet.sourceRefs,
    rssHeadlines: packet.rssHeadlines,
    defaultAssets: packet.defaultAssets,
    memeHeatItems: packet.memeHeatItems,
    newsItems: packet.newsItems,
    twitterItems: packet.twitterItems,
    marketAssets: packet.marketAssets,
    perps: packet.perps,
    predictions: packet.predictions,
    existingTopicsToday,
  }, debug);

  const existingSlugs = new Set(existingRows.map((row) => row.topic_slug));
  const candidateDrafts = drafts
    .filter((draft) => {
      const slug = slugifyTopic(draft.topic);
      return Boolean(slug) && !existingSlugs.has(slug);
    })
    .slice(0, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);
  console.log('topic_special_batch_drafts_ready', {
    runId,
    slotKey,
    draftCount: drafts.length,
    candidateDraftCount: candidateDrafts.length,
    draftTopics: drafts.map((draft) => draft.topic),
    candidateTopics: candidateDrafts.map((draft) => draft.topic),
  });

  const remainingSlotCapacity = Math.max(TOPIC_SPECIAL_MAX_COUNT_PER_SLOT - existingCount, 0);
  if (remainingSlotCapacity === 0) {
    console.log('topic_special_batch_skipped_no_slot_capacity', {
      runId,
      slotKey,
      existingCount,
      remainingSlotCapacity,
    });
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
  console.log('topic_special_batch_capacity_computed', {
    runId,
    slotKey,
    remainingSlotCapacity,
    remainingSlotsInDay,
    desiredTotalInSlot,
    desiredNewCount,
    targetNewCount,
    force: options?.force === true,
  });
  if (targetNewCount <= 0) {
    console.log('topic_special_batch_skipped_target_zero', {
      runId,
      slotKey,
      remainingDailyCapacity,
      remainingSlotCapacity,
      desiredNewCount,
      targetNewCount,
    });
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }
  const selectedDrafts = candidateDrafts.slice(0, targetNewCount);

  let generated = 0;
  const articleDebugRuns: NonNullable<TopicSpecialGenerationResult['debug']>['articles'] = [];
  for (const [index, draft] of selectedDrafts.entries()) {
    const topicSlug = slugifyTopic(draft.topic);
    if (!topicSlug) continue;
    if (existingSlugs.has(topicSlug)) continue;
    console.log('topic_special_article_generation_started', {
      runId,
      slotKey,
      articleIndex: index,
      editorId: draft.editorId,
      editorLabel: draft.editorLabel,
      topic: draft.topic,
      topicSlug,
      relatedAssetCount: draft.relatedAssets.length,
      sourceRefCount: draft.sourceRefs.length,
    });
    if (index > 0 && llmStatus.enabled) {
      await sleep(TOPIC_SPECIAL_INTER_ARTICLE_DELAY_MS);
    }

    const articleId = crypto.randomUUID();
    const generatedAt = new Date().toISOString();
    const r2Key = buildTopicR2Key(slotKey, topicSlug, articleId);
    const normalizedAssets = normalizeAssetSymbols(draft.relatedAssets, packet.defaultAssets);
    const relatedAssetRefs = await buildTopicRelatedAssetRefs(env, {
      topic: draft.topic,
      summary: draft.summary,
      symbols: normalizedAssets,
      marketAssets: packet.marketAssets,
      perps: packet.perps,
      predictions: packet.predictions,
    });
    const normalizedRefs = normalizeSourceRefs(draft.sourceRefs.length > 0 ? draft.sourceRefs : packet.sourceRefs);
    const articleDebug = createTopicArticleDebugCollector();
    const markdown = await buildTopicArticleMarkdown(
      env,
      llmStatus,
      {
        slotKey,
        editorId: draft.editorId,
        editorLabel: draft.editorLabel,
        topic: draft.topic,
        summary: draft.summary,
        chiefReason: draft.chiefReason,
        relatedAssets: normalizedAssets,
        sourceRefs: normalizedRefs,
        memeHeatItems: packet.memeHeatItems,
        newsItems: packet.newsItems,
        twitterItems: packet.twitterItems,
        marketAssets: packet.marketAssets,
        perps: packet.perps,
        predictions: packet.predictions,
        existingTopicsToday,
      },
      articleDebug,
    );
    articleDebug.markdownSnippet = captureDebugText(markdown, 6000);
    console.log('topic_special_article_generation_completed', {
      runId,
      slotKey,
      articleIndex: index,
      editorId: draft.editorId,
      editorLabel: draft.editorLabel,
      topic: draft.topic,
      topicSlug,
      normalizedAssetCount: normalizedAssets.length,
      relatedAssetRefCount: relatedAssetRefs.length,
      normalizedSourceRefCount: normalizedRefs.length,
      markdownChars: markdown.length,
      markdownEstimatedTokens: estimateTokenCount(markdown),
    });
    try {
      await persistTopicSpecialArticleViaHttp(env, {
        id: articleId,
        topicSlug,
        title: draft.topic,
        summary: truncateSummary(draft.summary),
        r2Key,
        relatedAssetsJson: JSON.stringify(relatedAssetRefs),
        sourceRefsJson: JSON.stringify(normalizedRefs),
        generatedAt,
        markdown,
        slotKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('topic_special_r2_put_failed', {
        runId,
        slotKey,
        topicSlug,
        r2Key,
        message,
      });
      throw new Error(`topic_special_r2_store_failed:${topicSlug}:${message}`);
    }

    generated += 1;
    existingSlugs.add(topicSlug);
    articleDebugRuns.push({
      topic: draft.topic,
      topicSlug,
      editorId: draft.editorId,
      editorLabel: draft.editorLabel,
      relatedAssets: normalizedAssets,
      sourceRefs: normalizedRefs,
      llm: articleDebug,
    });
  }

  const totalInSlot = await countTopicsInSlot(env.DB, slotKey);
  console.log('topic_special_batch_completed', {
    runId,
    slotKey,
    generated,
    totalInSlot,
    skipped: generated === 0,
  });
  return {
    slotKey,
    generated,
    skipped: generated === 0,
    totalInSlot,
    debug: {
      llm: debug.llm,
      sources: debug.sources,
      draft: debug.draft,
      editors: debug.editors,
      chief: debug.chief,
      articles: articleDebugRuns,
    },
  };
}

export async function generateTopicSpecialPreview(
  env: Bindings,
  options?: { force?: boolean; slotKey?: string } & TopicSpecialDebugOptions,
): Promise<TopicSpecialPreviewResult> {
  const packet = await fetchTopicSpecialSourcePacket(env, {
    slotKey: options?.slotKey,
  });
  return generateTopicSpecialPreviewFromSourcePacket(env, packet, options);
}

export async function generateTopicSpecialPreviewFromSourcePacket(
  env: Bindings,
  packet: TopicSpecialSourcePacket,
  options?: { force?: boolean; slotKey?: string } & TopicSpecialDebugOptions,
): Promise<TopicSpecialPreviewResult> {
  await ensureTopicSpecialSchema(env.DB);
  const slotKey = packet.slotKey;
  const dateKey = slotKey.slice(0, 10);
  const existingRows = await listTopicRowsInSlot(env.DB, slotKey);
  const existingCount = existingRows.length;
  const dailyCount = await countTopicsForDate(env.DB, dateKey);
  const existingTopicsToday = await listTopicTitlesForDate(env.DB, dateKey);
  const remainingDailyCapacity = Math.max(TOPIC_SPECIAL_DAILY_MAX_COUNT - dailyCount, 0);

  if (existingCount >= TOPIC_SPECIAL_MAX_COUNT_PER_SLOT || remainingDailyCapacity === 0) {
    return {
      slotKey,
      skipped: true,
      totalInSlot: existingCount,
      article: null,
    };
  }

  const llmStatus = getLlmStatus(env);
  const debug = buildTopicPreviewDebug(
    {
      ...packet,
      existingTopicsToday,
    },
    llmStatus,
  );
  const drafts = await buildTopicDrafts(env, llmStatus, {
    slotKey,
    sourceRefs: packet.sourceRefs,
    rssHeadlines: packet.rssHeadlines,
    defaultAssets: packet.defaultAssets,
    memeHeatItems: packet.memeHeatItems,
    newsItems: packet.newsItems,
    twitterItems: packet.twitterItems,
    marketAssets: packet.marketAssets,
    perps: packet.perps,
    predictions: packet.predictions,
    existingTopicsToday,
  }, debug, options);

  const existingSlugs = new Set(existingRows.map((row) => row.topic_slug));
  const candidateDrafts = drafts
    .filter((draft) => {
      const slug = slugifyTopic(draft.topic);
      return Boolean(slug) && !existingSlugs.has(slug);
    })
    .slice(0, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);

  const remainingSlotCapacity = Math.max(TOPIC_SPECIAL_MAX_COUNT_PER_SLOT - existingCount, 0);
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
  if (targetNewCount <= 0 || candidateDrafts.length === 0) {
    return {
      slotKey,
      skipped: true,
      totalInSlot: existingCount,
      article: null,
      debug,
    };
  }

  const draft = candidateDrafts[0];
  if (!draft) {
    return {
      slotKey,
      skipped: true,
      totalInSlot: existingCount,
      article: null,
      debug,
    };
  }

  const topicSlug = slugifyTopic(draft.topic);
  if (!topicSlug || existingSlugs.has(topicSlug)) {
    return {
      slotKey,
      skipped: true,
      totalInSlot: existingCount,
      article: null,
      debug,
    };
  }

  const articleId = crypto.randomUUID();
  const generatedAt = new Date().toISOString();
  const r2Key = buildTopicR2Key(slotKey, topicSlug, articleId);
  const normalizedAssets = normalizeAssetSymbols(draft.relatedAssets, packet.defaultAssets);
  const relatedAssetRefs = await buildTopicRelatedAssetRefs(env, {
    topic: draft.topic,
    summary: draft.summary,
    symbols: normalizedAssets,
    marketAssets: packet.marketAssets,
    perps: packet.perps,
    predictions: packet.predictions,
  });
  const normalizedRefs = normalizeSourceRefs(draft.sourceRefs.length > 0 ? draft.sourceRefs : packet.sourceRefs);
  const markdown = await buildTopicArticleMarkdown(
    env,
    llmStatus,
    {
      slotKey,
      editorId: draft.editorId,
      editorLabel: draft.editorLabel,
      topic: draft.topic,
      summary: draft.summary,
      chiefReason: draft.chiefReason,
      relatedAssets: normalizedAssets,
      sourceRefs: normalizedRefs,
      memeHeatItems: packet.memeHeatItems,
      newsItems: packet.newsItems,
      twitterItems: packet.twitterItems,
      marketAssets: packet.marketAssets,
      perps: packet.perps,
      predictions: packet.predictions,
      existingTopicsToday,
    },
    debug.article,
    options,
  );
  debug.article.markdownSnippet = markdown.slice(0, 800) || null;

  return {
    slotKey,
    skipped: false,
    totalInSlot: existingCount,
    article: {
      id: articleId,
      topicSlug,
      title: draft.topic,
      summary: draft.summary,
      r2Key,
      relatedAssetsJson: JSON.stringify(relatedAssetRefs),
      sourceRefsJson: JSON.stringify(normalizedRefs),
      generatedAt,
      markdown,
      slotKey,
    },
    debug,
  };
}

export async function probeTopicSpecialDrafts(
  env: Bindings,
  options?: { slotKey?: string } & TopicSpecialDebugOptions,
): Promise<TopicSpecialDraftProbeResult> {
  const packet = await fetchTopicSpecialSourcePacket(env, {
    slotKey: options?.slotKey,
  });
  return probeTopicSpecialDraftsFromSourcePacket(env, packet, options);
}

export async function probeTopicSpecialDraftsFromSourcePacket(
  env: Bindings,
  packet: TopicSpecialSourcePacket,
  options?: { slotKey?: string } & TopicSpecialDebugOptions,
): Promise<TopicSpecialDraftProbeResult> {
  const llmStatus = getLlmStatus(env);
  const debug = buildTopicPreviewDebug(packet, llmStatus);

  const drafts = await buildTopicDrafts(env, llmStatus, {
    slotKey: packet.slotKey,
    sourceRefs: packet.sourceRefs,
    rssHeadlines: packet.rssHeadlines,
    defaultAssets: packet.defaultAssets,
    memeHeatItems: packet.memeHeatItems,
    newsItems: packet.newsItems,
    twitterItems: packet.twitterItems,
    marketAssets: packet.marketAssets,
    perps: packet.perps,
    predictions: packet.predictions,
    existingTopicsToday: packet.existingTopicsToday,
  }, debug, options);

  return {
    slotKey: packet.slotKey,
    drafts,
    debug,
  };
}

export async function persistTopicSpecialArticle(
  env: Bindings,
  article: TopicSpecialPersistInput,
): Promise<void> {
  try {
    await putArticleMarkdownContent(env, article.id, article.r2Key, article.markdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('topic_special_r2_put_failed', {
      slotKey: article.slotKey,
      topicSlug: article.topicSlug,
      r2Key: article.r2Key,
      message,
    });
    throw new Error(`topic_special_r2_store_failed:${article.topicSlug}:${message}`);
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
        article.id,
        article.slotKey,
        article.topicSlug,
        article.title,
        article.summary,
        article.r2Key,
        article.relatedAssetsJson,
        article.sourceRefsJson,
        article.generatedAt,
        'ready',
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('topic_special_insert_failed', {
      slotKey: article.slotKey,
      topicSlug: article.topicSlug,
      message,
    });
    try {
      await deleteArticleMarkdownContent(env, article.r2Key);
    } catch (cleanupError) {
      console.error('topic_special_r2_cleanup_failed', {
        slotKey: article.slotKey,
        topicSlug: article.topicSlug,
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw new Error(`topic_special_index_failed:${article.topicSlug}:${message}`);
  }
}

async function persistTopicSpecialArticleViaHttp(
  env: Bindings,
  article: TopicSpecialPersistInput,
): Promise<void> {
  const uploader = env.TOPIC_SPECIAL.get(env.TOPIC_SPECIAL.idFromName('uploader')) as
    unknown as
    | { persistTopicSpecialArticleRpc: (input: TopicSpecialPersistInput) => Promise<void> }
    | undefined;
  if (!uploader?.persistTopicSpecialArticleRpc) {
    throw new Error('topic_special_upload_rpc_missing');
  }
  try {
    await uploader.persistTopicSpecialArticleRpc(article);
  } catch (error) {
    throw new Error(`topic_special_upload_rpc_failed:${error instanceof Error ? error.message : String(error)}`);
  }
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

async function listTopicTitlesForDate(db: D1Database, dateKey: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT title
       FROM topic_special_articles
       WHERE slot_key LIKE ?
       ORDER BY generated_at DESC`,
    )
    .bind(`${dateKey}T%`)
    .all<{ title: string }>();

  return dedupeStrings(
    (result.results ?? [])
      .map((row) => sanitizeTitle(row.title))
      .filter(Boolean),
  ).slice(0, 12);
}

async function listRecentTopicArticleMemories(
  db: D1Database,
  options?: { lookbackDays?: number; limit?: number },
): Promise<TopicRecentArticleMemory[]> {
  const lookbackDays = Math.max(1, Math.trunc(options?.lookbackDays ?? TOPIC_SPECIAL_HISTORY_LOOKBACK_DAYS));
  const limit = Math.max(1, Math.trunc(options?.limit ?? TOPIC_SPECIAL_HISTORY_LIMIT));
  const cutoffIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT topic_slug, title, summary, related_assets_json, source_refs_json, generated_at
       FROM topic_special_articles
       WHERE generated_at >= ?
       ORDER BY generated_at DESC
       LIMIT ?`,
    )
    .bind(cutoffIso, limit)
    .all<{
      topic_slug: string;
      title: string;
      summary: string;
      related_assets_json: string;
      source_refs_json: string;
      generated_at: string;
    }>();

  return (result.results ?? []).map((row) => {
    const relatedAssets = sanitizeAssetSymbols(parseStoredStringArray(row.related_assets_json));
    const sourceRefs = normalizeSourceRefs(parseStoredStringArray(row.source_refs_json));
    const storyKey = deriveStoryKeyFromParts(row.title, row.summary, sourceRefs);
    return {
      topicSlug: row.topic_slug,
      title: sanitizeTitle(row.title),
      summary: truncateSummary(row.summary),
      generatedAt: row.generated_at,
      relatedAssets,
      sourceRefs,
      storyKey,
      assetFamily: buildAssetFamilySignature(relatedAssets),
    };
  });
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

function normalizeDebugRetryAttempts(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(Number(value));
  if (normalized < 1) return 1;
  return Math.min(normalized, 3);
}

async function buildTopicDrafts(
  env: Bindings,
  llmStatus: ReturnType<typeof getLlmStatus>,
  input: TopicDraftGenerationInput,
  debug?: TopicSpecialPreviewDebugCollector,
  options?: TopicSpecialDebugOptions,
): Promise<TopicDraft[]> {
  const candidateDrafts: TopicDraft[] = [];
  const recentHistory = await listRecentTopicArticleMemories(env.DB);
  for (const [index, editor] of TOPIC_SPECIAL_EDITOR_DEFINITIONS.entries()) {
    const editorDrafts = await buildTopicBeatDrafts(env, llmStatus, editor, input, debug, options);
    candidateDrafts.push(...editorDrafts);
    if (index < TOPIC_SPECIAL_EDITOR_DEFINITIONS.length - 1 && llmStatus.enabled) {
      await sleep(TOPIC_SPECIAL_INTER_ARTICLE_DELAY_MS);
    }
  }

  const dedupedCandidates = dedupeTopicDrafts(candidateDrafts, input.existingTopicsToday, recentHistory);
  const uniqueStoryCandidates = enforceUniqueStoryDrafts(dedupedCandidates, 'editor');
  const chiefSelected = enforceUniqueStoryDrafts(
    await buildChiefEditorSelection(env, llmStatus, input, uniqueStoryCandidates, debug),
    'chief',
  );
  const shortlisted = selectDiverseTopicDrafts(chiefSelected, recentHistory, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);

  if (debug) {
    const firstLlmEditor = TOPIC_SPECIAL_EDITOR_DEFINITIONS
      .map((editor) => debug.editors[editor.id])
      .find((item) => item.mode === 'llm');
    debug.draft.mode = debug.chief.mode === 'llm' || Boolean(firstLlmEditor) ? 'llm' : 'fallback';
    debug.draft.fallbackReason = shortlisted.length === 0
      ? (llmStatus.enabled ? 'insufficient_results' : 'llm_disabled')
      : (debug.draft.mode === 'fallback' ? (llmStatus.enabled ? 'llm_error' : 'llm_disabled') : null);
    debug.draft.requestId = debug.chief.requestId ?? firstLlmEditor?.requestId ?? null;
    debug.draft.cfRay = debug.chief.cfRay ?? firstLlmEditor?.cfRay ?? null;
    debug.draft.provider = debug.chief.provider ?? firstLlmEditor?.provider ?? llmStatus.provider ?? null;
    debug.draft.model = debug.chief.model ?? firstLlmEditor?.model ?? llmStatus.model ?? null;
    debug.draft.promptStats = debug.chief.promptStats ?? firstLlmEditor?.promptStats ?? null;
    debug.draft.parsedDraftCount = shortlisted.length;
    debug.draft.responseSnippet = debug.chief.responseSnippet
      ?? TOPIC_SPECIAL_EDITOR_DEFINITIONS
        .map((editor) => debug.editors[editor.id].responseSnippet)
        .find(Boolean)
      ?? null;
    debug.draft.error = debug.chief.error
      ?? TOPIC_SPECIAL_EDITOR_DEFINITIONS
        .map((editor) => debug.editors[editor.id].error)
        .find(Boolean)
      ?? null;
  }

  if (shortlisted.length > 0) {
    return shortlisted.slice(0, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);
  }

  return selectDiverseTopicDrafts(
    buildFallbackTopicDrafts(input),
    recentHistory,
    TOPIC_SPECIAL_MAX_COUNT_PER_SLOT,
  ).slice(0, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);
}

async function buildTopicBeatDrafts(
  env: Bindings,
  llmStatus: ReturnType<typeof getLlmStatus>,
  editor: TopicSpecialEditorDefinition,
  input: TopicDraftGenerationInput,
  debug: TopicSpecialPreviewDebugCollector | undefined,
  options?: TopicSpecialDebugOptions,
): Promise<TopicDraft[]> {
  const candidateAssets = buildEditorCandidateAssets(editor.id, input);
  const fallbackDrafts = buildFallbackTopicDraftsForEditor(editor.id, input);
  const editorDebug = debug?.editors[editor.id];

  if (!llmStatus.enabled) {
    if (editorDebug) {
      editorDebug.mode = 'fallback';
      editorDebug.fallbackReason = 'llm_disabled';
      editorDebug.provider = llmStatus.provider || null;
      editorDebug.model = llmStatus.model || null;
      editorDebug.generatedDraftCount = fallbackDrafts.length;
    }
    return fallbackDrafts;
  }

  try {
    const systemPrompt = [
      'You are a beat editor for a crypto wallet publication.',
      `Your desk is "${editor.label}".`,
      editor.summary,
      'Produce only briefs that fit your beat and are strong enough to survive chief-editor review.',
      'Optimize for click-through, investment usefulness, and evidence density.',
      'Output strict JSON array only.',
    ].join(' ');
    const userPrompt = buildTopicBeatEditorPrompt(editor, input, candidateAssets, options);
    const promptStats = buildPromptDebugStats(systemPrompt, userPrompt);
    if (editorDebug) {
      editorDebug.promptStats = promptStats;
      editorDebug.systemPrompt = captureDebugText(systemPrompt, 4000);
      editorDebug.userPrompt = captureDebugText(userPrompt);
    }
    const retryAttempts = normalizeDebugRetryAttempts(options?.draftRetryAttempts, TOPIC_SPECIAL_LLM_RETRY_ATTEMPTS);
    console.log('topic_special_editor_llm_request', {
      editorId: editor.id,
      editorLabel: editor.label,
      ...promptStats,
      sourceRefCount: input.sourceRefs.length,
      candidateAssetCount: candidateAssets.length,
      newsCount: input.newsItems.length,
      twitterCount: input.twitterItems.length,
      marketAssetCount: input.marketAssets.length,
      perpCount: input.perps.length,
      predictionCount: input.predictions.length,
      model: llmStatus.model,
      baseUrl: llmStatus.baseUrl,
      retryAttempts,
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
      temperature: 0.3,
      maxTokens: 950,
      retryAttempts,
      maxRetryDelayMs: 60_000,
    });
    const drafts = parseBeatEditorDrafts(llmResult.text, editor, candidateAssets, input.sourceRefs);
    console.log('topic_special_editor_llm_succeeded', {
      editorId: editor.id,
      editorLabel: editor.label,
      requestId: llmResult.requestId ?? null,
      cfRay: llmResult.cfRay ?? null,
      fallbackFrom: llmResult.fallbackFrom ?? null,
      responseChars: llmResult.text.length,
      generatedDraftCount: drafts.length,
    });
    if (editorDebug) {
      editorDebug.mode = 'llm';
      editorDebug.fallbackReason = null;
      editorDebug.requestId = llmResult.requestId ?? null;
      editorDebug.cfRay = llmResult.cfRay ?? null;
      editorDebug.provider = llmResult.provider ?? llmStatus.provider ?? null;
      editorDebug.model = llmResult.model ?? llmStatus.model ?? null;
      editorDebug.generatedDraftCount = drafts.length;
      editorDebug.responseSnippet = captureDebugText(llmResult.text);
      editorDebug.error = null;
    }
    if (drafts.length > 0) {
      return drafts;
    }
    if (editorDebug) {
      editorDebug.mode = 'fallback';
      editorDebug.fallbackReason = 'insufficient_results';
      editorDebug.generatedDraftCount = fallbackDrafts.length;
    }
    return fallbackDrafts;
  } catch (error) {
    const llmError = getLlmErrorInfo(error);
    if (editorDebug) {
      editorDebug.mode = 'fallback';
      editorDebug.fallbackReason = 'llm_error';
      editorDebug.provider = llmStatus.provider || null;
      editorDebug.model = llmStatus.model || null;
      editorDebug.generatedDraftCount = fallbackDrafts.length;
      editorDebug.error = llmError;
    }
    console.error('topic_special_editor_llm_failed', {
      editorId: editor.id,
      editorLabel: editor.label,
      ...llmError,
      llm: llmStatus,
    });
    return fallbackDrafts;
  }
}

function buildTopicBeatEditorPrompt(
  editor: TopicSpecialEditorDefinition,
  input: TopicDraftGenerationInput,
  candidateAssets: string[],
  options?: TopicSpecialDebugOptions,
): string {
  const coveredTopicsBlock = input.existingTopicsToday.length > 0
    ? input.existingTopicsToday.slice(0, 8).map((topic) => `- ${topic}`).join('\n')
    : '- None yet today.';

  return [
    `Desk: ${editor.label}`,
    `Beat: ${editor.summary}`,
    '',
    'Mission:',
    '- Produce 1 to 2 article briefs for your desk only.',
    '- Stay within your beat. Do not pitch generic market stories that could belong to every desk.',
    '- Prefer topics with a specific trigger, evidence trail, and clear investment implication.',
    '- Treat this as a newsroom brief, not a final article.',
    '',
    'Editorial rules:',
    '- Avoid repeating or lightly renaming topics already covered today.',
    '- Do not default to BTC or ETH unless the packet shows they are the clearest expression of the story.',
    '- Avoid sponsored tone, hype, and generic macro filler.',
    '- Use only evidence supported by the research packet.',
    '- A brief can stay fully inside its category; do not force cross-category framing.',
    '',
    'Return a JSON array only.',
    'Each object must include:',
    '- "topic": a sharp non-clickbait title',
    '- "summary": one sentence for why this belongs in the publication now (< 180 chars)',
    '- "related_assets": array with 2 to 5 uppercase symbols',
    '- "source_refs": array with 2 to 4 exact evidence lines copied from the packet',
    '- "editor_score": integer from 0 to 100',
    '',
    `Candidate assets: ${candidateAssets.join(', ') || 'BTC, ETH, SOL, USDC'}`,
    '',
    'Already covered today:',
    coveredTopicsBlock,
    '',
    'Research packet:',
    buildTopicBeatResearchPacket(editor.id, input, options),
  ].join('\n');
}

function parseBeatEditorDrafts(
  text: string,
  editor: TopicSpecialEditorDefinition,
  defaultAssets: string[],
  fallbackRefs: string[],
): TopicDraft[] {
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
    const relatedAssets = normalizeAssetSymbols(
      readStringArray(row.related_assets) ?? readStringArray(row.relatedAssets),
      defaultAssets,
    );
    const sourceRefs = normalizeSourceRefs(
      readStringArray(row.source_refs) ?? readStringArray(row.sourceRefs) ?? fallbackRefs,
    );
    drafts.push({
      editorId: editor.id,
      editorLabel: editor.label,
      topic,
      summary: summary || `Watch ${relatedAssets.join(', ')} around the latest market signals in ${editor.label.toLowerCase()}.`,
      relatedAssets,
      sourceRefs,
      storyKey: null,
      editorScore: normalizeDraftScore(row.editor_score ?? row.score),
      chiefScore: null,
      chiefReason: null,
    });
    seenTopics.add(topicSlug);
    if (drafts.length >= 2) break;
  }

  return drafts;
}

async function buildChiefEditorSelection(
  env: Bindings,
  llmStatus: ReturnType<typeof getLlmStatus>,
  input: TopicDraftGenerationInput,
  candidates: TopicDraft[],
  debug?: TopicSpecialPreviewDebugCollector,
): Promise<TopicDraft[]> {
  const chiefFallback = selectChiefFallbackDrafts(candidates, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT, 'chief_fallback');
  if (candidates.length === 0) {
    if (debug) {
      debug.chief.mode = 'fallback';
      debug.chief.fallbackReason = llmStatus.enabled ? 'insufficient_results' : 'llm_disabled';
      debug.chief.provider = llmStatus.provider || null;
      debug.chief.model = llmStatus.model || null;
      debug.chief.selectedDraftCount = 0;
    }
    return chiefFallback;
  }

  if (!llmStatus.enabled) {
    if (debug) {
      debug.chief.mode = 'fallback';
      debug.chief.fallbackReason = 'llm_disabled';
      debug.chief.provider = llmStatus.provider || null;
      debug.chief.model = llmStatus.model || null;
      debug.chief.selectedDraftCount = chiefFallback.length;
    }
    return chiefFallback;
  }

  const candidatesWithIds = candidates.map((draft, index) => ({
    id: `${draft.editorId}-${index + 1}`,
    draft,
  }));

  try {
    const systemPrompt = [
      'You are the chief editor for a crypto wallet publication.',
      'Your job is to choose the strongest slate from the beat-editor briefs.',
      'Balance quality, novelty, evidence density, and coverage across desks.',
      'Prefer a slate that covers multiple market lenses instead of clustering around BTC/ETH unless the evidence is overwhelmingly concentrated there.',
      'Prefer one strong brief per desk before taking a second brief from the same desk, unless quality clearly justifies it.',
      'Output strict JSON array only.',
    ].join(' ');
    const userPrompt = buildChiefEditorPrompt(input, candidatesWithIds);
    const promptStats = buildPromptDebugStats(systemPrompt, userPrompt);
    if (debug) {
      debug.chief.promptStats = promptStats;
      debug.chief.systemPrompt = captureDebugText(systemPrompt, 4000);
      debug.chief.userPrompt = captureDebugText(userPrompt);
    }
    console.log('topic_special_chief_llm_request', {
      ...promptStats,
      candidateCount: candidates.length,
      model: llmStatus.model,
      baseUrl: llmStatus.baseUrl,
    });
    const llmResult = await generateWithLlm(env, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 900,
      retryAttempts: TOPIC_SPECIAL_LLM_RETRY_ATTEMPTS,
      maxRetryDelayMs: 60_000,
    });
    const selected = parseChiefSelection(llmResult.text, candidatesWithIds, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);
    const merged = mergeChiefSelectionWithFallback(selected, chiefFallback, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);
    console.log('topic_special_chief_llm_succeeded', {
      requestId: llmResult.requestId ?? null,
      cfRay: llmResult.cfRay ?? null,
      fallbackFrom: llmResult.fallbackFrom ?? null,
      candidateCount: candidates.length,
      selectedCount: merged.length,
    });
    if (debug) {
      debug.chief.mode = 'llm';
      debug.chief.fallbackReason = null;
      debug.chief.requestId = llmResult.requestId ?? null;
      debug.chief.cfRay = llmResult.cfRay ?? null;
      debug.chief.provider = llmResult.provider ?? llmStatus.provider ?? null;
      debug.chief.model = llmResult.model ?? llmStatus.model ?? null;
      debug.chief.selectedDraftCount = merged.length;
      debug.chief.responseSnippet = captureDebugText(llmResult.text);
      debug.chief.error = null;
    }
    if (merged.length > 0) {
      return merged;
    }
    if (debug) {
      debug.chief.mode = 'fallback';
      debug.chief.fallbackReason = 'insufficient_results';
      debug.chief.selectedDraftCount = chiefFallback.length;
    }
    return chiefFallback;
  } catch (error) {
    const llmError = getLlmErrorInfo(error);
    if (debug) {
      debug.chief.mode = 'fallback';
      debug.chief.fallbackReason = 'llm_error';
      debug.chief.provider = llmStatus.provider || null;
      debug.chief.model = llmStatus.model || null;
      debug.chief.selectedDraftCount = chiefFallback.length;
      debug.chief.error = llmError;
    }
    console.error('topic_special_chief_llm_failed', {
      ...llmError,
      llm: llmStatus,
      candidateCount: candidates.length,
    });
    return chiefFallback;
  }
}

function buildChiefEditorPrompt(
  input: TopicDraftGenerationInput,
  candidates: Array<{ id: string; draft: TopicDraft }>,
): string {
  const coveredTopicsBlock = input.existingTopicsToday.length > 0
    ? input.existingTopicsToday.slice(0, 8).map((topic) => `- ${topic}`).join('\n')
    : '- None yet today.';
  const candidateBlock = candidates.map(({ id, draft }) => [
    `ID: ${id}`,
    `Desk: ${draft.editorLabel}`,
    `Title: ${draft.topic}`,
    `Summary: ${draft.summary}`,
    `Assets: ${draft.relatedAssets.join(', ')}`,
    `Editor score: ${draft.editorScore}`,
    'Evidence:',
    ...draft.sourceRefs.map((line) => `- ${line}`),
  ].join('\n')).join('\n\n');

  return [
    `Slot: ${input.slotKey}`,
    '',
    'Mission:',
    '- Select the strongest publication slate from the candidate briefs below.',
    '- Maximize distinctiveness, evidence quality, and reader usefulness.',
    '- Avoid duplicate angles, even if titles differ slightly.',
    '',
    'Selection rules:',
    '- Prefer one strong brief per desk before doubling up on the same desk.',
    '- Prefer coverage breadth across market regime, rotation, leverage, sentiment, and catalysts.',
    '- Keep only briefs with a clear trigger, evidence trail, and concrete reason to read now.',
    '- Avoid generic market filler and redundant macro angles.',
    '',
    'Return a JSON array only.',
    'Each object must include:',
    '- "id": exact candidate ID',
    '- "chief_score": integer from 0 to 100',
    '- "reason": short reason under 120 chars',
    '',
    'Already covered today:',
    coveredTopicsBlock,
    '',
    'Candidate briefs:',
    candidateBlock,
  ].join('\n');
}

function parseChiefSelection(
  text: string,
  candidates: Array<{ id: string; draft: TopicDraft }>,
  limit: number,
): TopicDraft[] {
  const jsonArray = extractJsonArray(text);
  if (!jsonArray) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonArray);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const candidateMap = new Map(candidates.map((item) => [item.id, item.draft]));
  const selected: TopicDraft[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    const candidateId = typeof row === 'string'
      ? row.trim()
      : typeof row === 'object' && row !== null && typeof (row as { id?: unknown }).id === 'string'
        ? ((row as { id: string }).id).trim()
        : '';
    if (!candidateId || seen.has(candidateId)) continue;
    const matched = candidateMap.get(candidateId);
    if (!matched) continue;
    const record = typeof row === 'object' && row !== null ? row as Record<string, unknown> : {};
    selected.push({
      ...matched,
      chiefScore: normalizeDraftScore(record.chief_score ?? record.score, matched.editorScore),
      chiefReason: truncateSummary(typeof record.reason === 'string' ? record.reason : ''),
    });
    seen.add(candidateId);
    if (selected.length >= limit) break;
  }
  return selected;
}

function mergeChiefSelectionWithFallback(selected: TopicDraft[], fallback: TopicDraft[], limit: number): TopicDraft[] {
  const output: TopicDraft[] = [];
  const seenTopics = new Set<string>();
  for (const draft of [...selected, ...fallback]) {
    const slug = slugifyTopic(draft.topic);
    if (!slug || seenTopics.has(slug)) continue;
    output.push(draft);
    seenTopics.add(slug);
    if (output.length >= limit) break;
  }
  return output;
}

function selectChiefFallbackDrafts(candidates: TopicDraft[], limit: number, reason: string): TopicDraft[] {
  const ranked = candidates
    .slice()
    .sort((a, b) => scoreDraftForChiefFallback(b) - scoreDraftForChiefFallback(a));
  const selected: TopicDraft[] = [];
  const selectedSlugs = new Set<string>();
  const deskCounts = new Map<TopicSpecialEditorId, number>();

  for (const draft of ranked) {
    if (selected.length >= limit) break;
    const slug = slugifyTopic(draft.topic);
    if (!slug || selectedSlugs.has(slug)) continue;
    const deskCount = deskCounts.get(draft.editorId) ?? 0;
    if (deskCount >= 1 && deskCounts.size >= Math.min(limit, TOPIC_SPECIAL_EDITOR_DEFINITIONS.length)) {
      continue;
    }
    selected.push({
      ...draft,
      chiefScore: draft.editorScore,
      chiefReason: reason,
    });
    selectedSlugs.add(slug);
    deskCounts.set(draft.editorId, deskCount + 1);
  }

  for (const draft of ranked) {
    if (selected.length >= limit) break;
    const slug = slugifyTopic(draft.topic);
    if (!slug || selectedSlugs.has(slug)) continue;
    selected.push({
      ...draft,
      chiefScore: draft.editorScore,
      chiefReason: reason,
    });
    selectedSlugs.add(slug);
  }

  return selected;
}

const TOPIC_STORY_STOPWORDS = new Set([
  'about',
  'amid',
  'after',
  'before',
  'brief',
  'crypto',
  'desk',
  'editor',
  'from',
  'market',
  'markets',
  'price',
  'rates',
  'raises',
  'risk',
  'risks',
  'sale',
  'sells',
  'signals',
  'spot',
  'story',
  'topic',
  'watch',
  'with',
]);

function enforceUniqueStoryDrafts(candidates: TopicDraft[], stage: 'editor' | 'chief'): TopicDraft[] {
  const source = stage === 'editor'
    ? candidates.slice().sort((a, b) => scoreDraftForStoryUniqueness(b, stage) - scoreDraftForStoryUniqueness(a, stage))
    : candidates.slice();
  const output: TopicDraft[] = [];
  for (const draft of source) {
    const enriched = {
      ...draft,
      storyKey: draft.storyKey ?? deriveDraftStoryKey(draft),
    };
    if (output.some((existing) => draftsShareStory(existing, enriched))) continue;
    output.push(enriched);
  }
  return output;
}

function dedupeTopicDrafts(
  candidates: TopicDraft[],
  existingTopicsToday: string[],
  recentHistory: TopicRecentArticleMemory[],
): TopicDraft[] {
  const output: TopicDraft[] = [];
  const seenTopics = new Set([
    ...existingTopicsToday.map((topic) => slugifyTopic(topic)).filter(Boolean),
    ...recentHistory.map((item) => item.topicSlug).filter(Boolean),
  ]);
  for (const candidate of candidates) {
    const slug = slugifyTopic(candidate.topic);
    if (!slug || seenTopics.has(slug)) continue;
    output.push({
      ...candidate,
      storyKey: candidate.storyKey ?? deriveDraftStoryKey(candidate),
    });
    seenTopics.add(slug);
  }
  return output;
}

function selectDiverseTopicDrafts(
  candidates: TopicDraft[],
  recentHistory: TopicRecentArticleMemory[],
  limit: number,
): TopicDraft[] {
  if (candidates.length <= 1) return candidates.slice(0, limit);

  const cooledCandidates = applyRecentTopicCooldown(candidates, recentHistory);
  const pool = cooledCandidates.length > 0 ? cooledCandidates : candidates;
  const output: TopicDraft[] = [];
  const remaining = pool.slice();

  while (remaining.length > 0 && output.length < limit) {
    remaining.sort((left, right) => scoreDraftForSelection(right, output, recentHistory) - scoreDraftForSelection(left, output, recentHistory));
    const next = remaining.shift();
    if (!next) break;
    output.push(next);
  }

  return output;
}

function scoreDraftForStoryUniqueness(draft: TopicDraft, stage: 'editor' | 'chief'): number {
  const stageScore = stage === 'chief' ? (draft.chiefScore ?? draft.editorScore) : draft.editorScore;
  return stageScore * 3 + draft.sourceRefs.length * 8 + draft.relatedAssets.length * 2;
}

function deriveDraftStoryKey(draft: TopicDraft): string | null {
  return deriveStoryKeyFromParts(draft.topic, draft.summary, draft.sourceRefs);
}

function draftsShareStory(left: TopicDraft, right: TopicDraft): boolean {
  if (left.storyKey && right.storyKey && left.storyKey === right.storyKey) return true;

  const leftRefKeys = buildDraftRefKeys(left);
  const rightRefKeys = buildDraftRefKeys(right);
  if (leftRefKeys.some((key) => rightRefKeys.includes(key))) return true;

  const leftTokens = new Set(buildStoryTokens(`${left.topic} ${left.summary}`));
  const rightTokens = new Set(buildStoryTokens(`${right.topic} ${right.summary}`));
  const sharedAssets = left.relatedAssets.filter((asset) => right.relatedAssets.includes(asset)).length;
  const titleSimilarity = jaccardSimilarity(leftTokens, rightTokens);
  if (sharedAssets > 0 && titleSimilarity >= 0.55) return true;

  const refSimilarity = bestReferenceSimilarity(left.sourceRefs, right.sourceRefs);
  if (sharedAssets > 0 && refSimilarity >= 0.7) return true;

  return false;
}

function buildDraftRefKeys(draft: TopicDraft): string[] {
  return normalizeSourceRefs(draft.sourceRefs)
    .map((line) => buildReferenceStoryKey(line))
    .filter(Boolean);
}

function deriveStoryKeyFromParts(title: string, summary: string, sourceRefs: string[]): string | null {
  const refKeys = normalizeSourceRefs(sourceRefs)
    .map((line) => buildReferenceStoryKey(line))
    .filter(Boolean);
  if (refKeys.length > 0) return refKeys[0] ?? null;
  const tokens = buildStoryTokens(`${title} ${summary}`);
  return tokens.length > 0 ? tokens.slice(0, 8).join('-') : null;
}

function buildReferenceStoryKey(line: string): string {
  const tokens = buildStoryTokens(line);
  return tokens.slice(0, 8).join('-');
}

function buildStoryTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .filter((item) => !TOPIC_STORY_STOPWORDS.has(item));
}

function bestReferenceSimilarity(leftRefs: string[], rightRefs: string[]): number {
  let best = 0;
  for (const left of leftRefs) {
    for (const right of rightRefs) {
      const similarity = jaccardSimilarity(
        new Set(buildStoryTokens(left)),
        new Set(buildStoryTokens(right)),
      );
      if (similarity > best) best = similarity;
    }
  }
  return best;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function scoreDraftForChiefFallback(draft: TopicDraft): number {
  return (
    draft.editorScore * 3
    + draft.sourceRefs.length * 8
    + draft.relatedAssets.length * 2
  );
}

function applyRecentTopicCooldown(candidates: TopicDraft[], recentHistory: TopicRecentArticleMemory[]): TopicDraft[] {
  const filtered = candidates.filter((draft) => !recentHistory.some((item) => shouldCooldownDraft(draft, item)));
  return filtered.length > 0 ? filtered : candidates;
}

function scoreDraftForSelection(
  draft: TopicDraft,
  selected: TopicDraft[],
  recentHistory: TopicRecentArticleMemory[],
): number {
  let score = (draft.chiefScore ?? draft.editorScore) * 4 + draft.sourceRefs.length * 10 + draft.relatedAssets.length * 3;
  const recentPenalty = calculateRecentHistoryPenalty(draft, recentHistory);
  score -= recentPenalty;

  const draftFamily = buildAssetFamilySignature(draft.relatedAssets);
  const selectedFamilies = new Set(selected.map((item) => buildAssetFamilySignature(item.relatedAssets)).filter(Boolean));
  if (draftFamily && selectedFamilies.has(draftFamily)) score -= 24;

  const selectedDeskCount = selected.filter((item) => item.editorId === draft.editorId).length;
  score -= selectedDeskCount * 18;

  const sharedAssets = selected.reduce((count, item) => count + countSharedAssets(draft.relatedAssets, item.relatedAssets), 0);
  score -= sharedAssets * 6;

  return score;
}

function calculateRecentHistoryPenalty(draft: TopicDraft, recentHistory: TopicRecentArticleMemory[]): number {
  let penalty = 0;
  for (const item of recentHistory) {
    const sharedAssets = countSharedAssets(draft.relatedAssets, item.relatedAssets);
    const titleSimilarity = jaccardSimilarity(
      new Set(buildStoryTokens(`${draft.topic} ${draft.summary}`)),
      new Set(buildStoryTokens(`${item.title} ${item.summary}`)),
    );
    const refSimilarity = bestReferenceSimilarity(draft.sourceRefs, item.sourceRefs);
    if (sharedAssets >= 2 && (titleSimilarity >= 0.35 || refSimilarity >= 0.45)) {
      penalty += 48;
      continue;
    }
    if (buildAssetFamilySignature(draft.relatedAssets) === item.assetFamily && sharedAssets >= 1) {
      penalty += 18;
    }
  }
  return penalty;
}

function shouldCooldownDraft(draft: TopicDraft, recent: TopicRecentArticleMemory): boolean {
  const ageHours = getAgeHours(recent.generatedAt);
  const sharedAssets = countSharedAssets(draft.relatedAssets, recent.relatedAssets);
  const draftStoryKey = draft.storyKey ?? deriveDraftStoryKey(draft);
  const titleSimilarity = jaccardSimilarity(
    new Set(buildStoryTokens(`${draft.topic} ${draft.summary}`)),
    new Set(buildStoryTokens(`${recent.title} ${recent.summary}`)),
  );
  const refSimilarity = bestReferenceSimilarity(draft.sourceRefs, recent.sourceRefs);
  const sameAssetFamily = buildAssetFamilySignature(draft.relatedAssets) === recent.assetFamily;
  if (ageHours <= TOPIC_SPECIAL_STRICT_COOLDOWN_HOURS) {
    if (draftStoryKey && recent.storyKey && draftStoryKey === recent.storyKey) return true;
    if (sharedAssets >= 2 && (titleSimilarity >= 0.32 || refSimilarity >= 0.42)) return true;
  }
  if (ageHours <= TOPIC_SPECIAL_ASSET_COOLDOWN_HOURS) {
    if (sameAssetFamily && sharedAssets >= 1 && titleSimilarity >= 0.2) return true;
  }
  return false;
}

function getAgeHours(isoTimestamp: string): number {
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - parsed) / (60 * 60 * 1000));
}

function countSharedAssets(left: string[], right: string[]): number {
  const rightSet = new Set(sanitizeAssetSymbols(right));
  let count = 0;
  for (const asset of sanitizeAssetSymbols(left)) {
    if (rightSet.has(asset)) count += 1;
  }
  return count;
}

function buildAssetFamilySignature(assets: string[]): string {
  const sanitized = sanitizeAssetSymbols(assets);
  const normalized = sanitized.filter((asset) => !TOPIC_STABLE_ASSETS.has(asset));
  const selected = (normalized.length > 0 ? normalized : sanitized).slice(0, 2).sort((left, right) => left.localeCompare(right));
  return selected.join('+');
}

function normalizeDraftScore(raw: unknown, fallback = 60): number {
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}
type TopicArticleInput = {
  slotKey: string;
  editorId: TopicSpecialEditorId;
  editorLabel: string;
  topic: string;
  summary: string;
  chiefReason: string | null;
  relatedAssets: string[];
  sourceRefs: string[];
  memeHeatItems: DexScreenerMemeHeatItem[];
  newsItems: NewsItem[];
  twitterItems: TweetItem[];
  marketAssets: MarketTopAsset[];
  perps: TradeBrowseMarketItem[];
  predictions: TradeBrowsePredictionItem[];
  existingTopicsToday: string[];
};

async function buildTopicArticleMarkdown(
  env: Bindings,
  llmStatus: ReturnType<typeof getLlmStatus>,
  input: TopicArticleInput,
  debug?: TopicSpecialArticleDebugCollector,
  options?: TopicSpecialDebugOptions,
): Promise<string> {
  if (options?.forceArticleFallback === true) {
    if (debug) {
      debug.mode = 'fallback';
      debug.fallbackReason = 'forced_fallback';
      debug.provider = llmStatus.provider || null;
      debug.model = llmStatus.model || null;
      debug.promptStats = null;
      debug.error = null;
    }
    return buildFallbackTopicArticleMarkdown(input);
  }

  if (!llmStatus.enabled) {
    if (debug) {
      debug.mode = 'fallback';
      debug.fallbackReason = 'llm_disabled';
      debug.provider = llmStatus.provider || null;
      debug.model = llmStatus.model || null;
      debug.promptStats = null;
      debug.error = null;
    }
    console.warn('topic_special_article_llm_disabled_using_fallback', {
      slotKey: input.slotKey,
      topic: input.topic,
      llmEnabled: llmStatus.enabled,
      llmProvider: llmStatus.provider,
      llmModel: llmStatus.model,
      llmBaseUrl: llmStatus.baseUrl,
      fallbackEnabled: llmStatus.fallbackEnabled,
      fallbackProvider: llmStatus.fallbackProvider,
    });
    return buildFallbackTopicArticleMarkdown(input);
  }

  try {
    const systemPrompt = [
      'You are the feature writer for a crypto wallet publication.',
      `The selected brief came from the "${input.editorLabel}" desk.`,
      'Write a high-quality market topic article for readers who care about crypto, meme, derivatives, prediction markets, or cross-market flows.',
      'The article should be strong enough to earn a click, keep the reader engaged, and improve investment decisions.',
      'Build a clear line of reasoning from evidence to implications.',
      'Do not force a crypto-TradFi bridge if the selected topic is best written as a crypto-only, meme-only, or TradFi-only story.',
      'Do not write generic macro filler, stacked buzzwords, obvious ad copy, or token shilling.',
      'Do not force a rigid outline; choose the structure that best fits the topic.',
      'Output markdown only.',
      'Include a final "## Related Assets" section with bullet symbols.',
    ].join(' ');
    const userPrompt = buildTopicArticlePrompt(input);
    const promptStats = buildPromptDebugStats(systemPrompt, userPrompt);
    if (debug) {
      debug.promptStats = promptStats;
      debug.systemPrompt = captureDebugText(systemPrompt, 4000);
      debug.userPrompt = captureDebugText(userPrompt);
    }
    console.log('topic_special_article_llm_request', {
      ...promptStats,
      slotKey: input.slotKey,
      topic: input.topic,
      sourceRefCount: input.sourceRefs.length,
      relatedAssetCount: input.relatedAssets.length,
      memeHeatCount: input.memeHeatItems.length,
      newsCount: input.newsItems.length,
      twitterCount: input.twitterItems.length,
      marketAssetCount: input.marketAssets.length,
      perpCount: input.perps.length,
      predictionCount: input.predictions.length,
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
      fallbackFrom: llmResult.fallbackFrom ?? null,
      responseChars: llmResult.text.length,
      responseEstimatedTokens: estimateTokenCount(llmResult.text),
    });
    const text = llmResult.text.trim();
    if (!text) {
      throw new Error('topic_special_article_empty_response');
    }
    if (debug) {
      debug.mode = 'llm';
      debug.fallbackReason = null;
      debug.requestId = llmResult.requestId ?? null;
      debug.cfRay = llmResult.cfRay ?? null;
      debug.provider = llmResult.provider ?? llmStatus.provider ?? null;
      debug.model = llmResult.model ?? llmStatus.model ?? null;
      debug.responseSnippet = captureDebugText(text);
      debug.error = null;
    }
    return ensureRelatedAssetsSection(text, input.relatedAssets);
  } catch (error) {
    const llmError = getLlmErrorInfo(error);
    if (debug) {
      debug.mode = 'fallback';
      debug.fallbackReason = 'llm_error';
      debug.provider = llmStatus.provider || null;
      debug.model = llmStatus.model || null;
      debug.error = llmError;
    }
    console.error('topic_special_article_llm_failed', {
      ...llmError,
      llm: llmStatus,
      slotKey: input.slotKey,
      topic: input.topic,
      sourceRefCount: input.sourceRefs.length,
      relatedAssetCount: input.relatedAssets.length,
    });
    return buildFallbackTopicArticleMarkdown(input);
  }
}

function buildTopicArticlePrompt(input: TopicArticleInput): string {
  const evidencePacket = buildTopicArticleResearchPacket(input);

  return [
    `Slot: ${input.slotKey}`,
    `Desk: ${input.editorLabel}`,
    `Topic: ${input.topic}`,
    `Why this topic was selected: ${input.summary}`,
    `Chief editor note: ${input.chiefReason || 'Selected for strength, evidence, and reader usefulness.'}`,
    `Priority assets: ${input.relatedAssets.join(', ') || 'BTC, ETH, USDC'}`,
    '',
    'Objective:',
    '- Write a high-quality topic article that appeals to crypto, meme, or traditional finance readers.',
    '- The article should be compelling enough to earn a click, strong enough to sustain reading, and useful enough to influence investment follow-through.',
    '- Build a real argument from evidence instead of stacking empty claims.',
    '',
    'Writing rules:',
    '- Use only evidence supported by the packet below.',
    '- Keep a strong internal logic from trigger -> evidence -> implication -> what to watch.',
    '- A crypto-only, meme-only, or TradFi-only framing is acceptable when that produces the clearest article.',
    '- You may choose your own structure and subheadings; do not default to a canned template unless it genuinely helps.',
    '- Any concrete number, event detail, or quote must come directly from the packet or be a simple rounding of a packet value.',
    '- Do not claim institutional behavior, flows, or positioning unless the packet directly supports that claim.',
    '- Do not sound sponsored, promotional, or like obvious copywriting.',
    '- Do not fabricate prices, percentages, flows, or quotes.',
    '- Do not issue direct buy or sell commands.',
    '- Acknowledge uncertainty when the evidence is mixed.',
    '- End with a final "## Related Assets" section using bullet points.',
    '',
    'Research packet:',
    evidencePacket,
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

function truncateLine(raw: string, max = 220): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3).trimEnd()}...`;
}

function formatIsoTimestamp(raw: string | null | undefined): string {
  const value = raw?.trim();
  if (!value) return 'unknown time';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return truncateLine(value, 32);
  return new Date(parsed).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

function formatCompactNumber(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(Number(value));
  if (abs >= 1_000_000_000) return `${(Number(value) / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  if (abs >= 1_000_000) return `${(Number(value) / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(Number(value) / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${Math.round(Number(value))}`;
}

function formatSignedPercent(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return 'n/a';
  const numeric = Number(value);
  const abs = Math.abs(numeric);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(digits)}%`;
}

function formatBulletBlock(lines: string[], emptyLine: string): string {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join('\n') : emptyLine;
}

function sortTweetsByEngagement(tweets: TweetItem[]): TweetItem[] {
  return tweets
    .slice()
    .sort((a, b) => (b.likes + b.retweets * 2) - (a.likes + a.retweets * 2));
}

function formatNewsSignalLine(item: NewsItem): string {
  const parts = [
    '[NEWS]',
    item.title,
    item.source ? `source=${item.source}` : null,
    item.coin ? `coin=${item.coin}` : null,
    item.rating != null ? `rating=${item.rating}` : null,
    item.publishedAt ? `time=${formatIsoTimestamp(item.publishedAt)}` : null,
    item.summary ? `summary=${truncateLine(item.summary, 120)}` : null,
  ].filter(Boolean);
  return truncateLine(parts.join(' | '), 240);
}

function formatTweetSignalLine(item: TweetItem): string {
  const prefix = item.handle ? `@${item.handle}` : item.author || 'unknown';
  return truncateLine(
    ['[SOCIAL]', prefix, `likes=${item.likes}`, `retweets=${item.retweets}`, `time=${formatIsoTimestamp(item.createdAt)}`, item.text]
      .filter(Boolean)
      .join(' | '),
    240,
  );
}

function formatMarketSignalLine(asset: MarketTopAsset): string {
  return truncateLine(
    [
      '[SPOT]',
      `${asset.symbol} (${asset.name})`,
      asset.market_cap_rank != null ? `rank=#${asset.market_cap_rank}` : null,
      `24h=${formatSignedPercent(asset.price_change_percentage_24h)}`,
      asset.turnover_24h != null ? `turnover=${formatCompactNumber(asset.turnover_24h)}` : null,
      asset.current_price != null ? `price=${asset.current_price}` : null,
    ].filter(Boolean).join(' | '),
    240,
  );
}

function formatPerpSignalLine(item: TradeBrowseMarketItem): string {
  return truncateLine(
    [
      '[PERP]',
      `${item.symbol} (${item.name})`,
      `24h=${formatSignedPercent(item.change24h)}`,
      item.volume24h != null ? `vol=${formatCompactNumber(item.volume24h)}` : null,
      item.metaLabel && item.metaValue != null ? `${item.metaLabel}=${item.metaValue}` : null,
      `source=${item.source}`,
    ].filter(Boolean).join(' | '),
    240,
  );
}

function formatPredictionSignalLine(item: TradeBrowsePredictionItem): string {
  return truncateLine(
    [
      '[PREDICTION]',
      item.title,
      item.probability != null ? `prob=${formatSignedPercent(item.probability * 100)}` : null,
      item.volume24h != null ? `vol=${formatCompactNumber(item.volume24h)}` : null,
      item.endDate ? `end=${formatIsoTimestamp(item.endDate)}` : null,
    ].filter(Boolean).join(' | '),
    240,
  );
}

function formatMemeHeatLine(item: DexScreenerMemeHeatItem): string {
  return truncateLine(
    [
      '[MEME]',
      item.symbol ? `${item.symbol}${item.name ? ` (${item.name})` : ''}` : item.name ?? item.tokenAddress,
      `chain=${item.chainId}`,
      `heat=${item.heatScore}`,
      item.boostAmount != null ? `boost=${formatCompactNumber(item.boostAmount)}` : null,
      item.priceChange24h != null ? `24h=${formatSignedPercent(item.priceChange24h)}` : null,
      item.volume24h != null ? `vol=${formatCompactNumber(item.volume24h)}` : null,
      item.liquidityUsd != null ? `liq=${formatCompactNumber(item.liquidityUsd)}` : null,
      item.matchedKeywords.length > 0 ? `keywords=${item.matchedKeywords.join(',')}` : null,
      item.description ? `desc=${truncateLine(item.description, 96)}` : null,
    ].filter(Boolean).join(' | '),
    240,
  );
}

function buildTopicDraftResearchPacket(
  input: TopicDraftGenerationInput,
  options?: TopicSpecialDebugOptions,
): string {
  const compact = options?.compactDraftPacket === true;
  const headlineLimit = compact ? 6 : 10;
  const newsLimit = compact ? 3 : 6;
  const socialLimit = compact ? 3 : 5;
  const memeLimit = compact ? 4 : 8;
  const spotLimit = compact ? 4 : 8;
  const perpLimit = compact ? 3 : 5;
  const predictionLimit = compact ? 2 : 4;
  const headlineTape = formatBulletBlock(
    (options?.omitDraftHeadlineTape === true ? [] : input.sourceRefs.slice(0, headlineLimit))
      .map((line) => truncateLine(line, 180)),
    '- No headline tape available.',
  );
  const newsBlock = formatBulletBlock(
    (options?.omitDraftNews === true ? [] : input.newsItems.slice(0, newsLimit))
      .map((item) => formatNewsSignalLine(item)),
    '- No news signals available.',
  );
  const socialBlock = formatBulletBlock(
    (options?.omitDraftSocial === true ? [] : sortTweetsByEngagement(input.twitterItems).slice(0, socialLimit))
      .map((item) => formatTweetSignalLine(item)),
    '- No social signals available.',
  );
  const spotBlock = formatBulletBlock(
    (options?.omitDraftSpot === true ? [] : input.marketAssets.slice(0, spotLimit))
      .map((asset) => formatMarketSignalLine(asset)),
    '- No spot market snapshot available.',
  );
  const perpBlock = formatBulletBlock(
    (options?.omitDraftPerps === true
      ? []
      : input.perps
        .slice()
        .sort((a, b) => Number(b.volume24h ?? 0) - Number(a.volume24h ?? 0))
        .slice(0, perpLimit))
      .map((item) => formatPerpSignalLine(item)),
    '- No perp signals available.',
  );
  const predictionBlock = formatBulletBlock(
    (options?.omitDraftPredictions === true
      ? []
      : input.predictions
        .slice()
        .sort((a, b) => Number(b.volume24h ?? 0) - Number(a.volume24h ?? 0))
        .slice(0, predictionLimit))
      .map((item) => formatPredictionSignalLine(item)),
    '- No prediction signals available.',
  );
  const memeHeatBlock = formatBulletBlock(
    (options?.omitDraftMemeHeat === true ? [] : input.memeHeatItems.slice(0, memeLimit))
      .map((item) => formatMemeHeatLine(item)),
    '- No meme heat signals available.',
  );

  return [
    `Current slot: ${input.slotKey}`,
    '',
    'Headline and social tape:',
    headlineTape,
    '',
    'News detail:',
    newsBlock,
    '',
    'Social detail:',
    socialBlock,
    '',
    'Meme heat snapshot:',
    memeHeatBlock,
    '',
    'Spot market snapshot:',
    spotBlock,
    '',
    'Perp snapshot:',
    perpBlock,
    '',
    'Prediction market snapshot:',
    predictionBlock,
  ].join('\n');
}

function collectNewsAssetSymbols(items: NewsItem[]): string[] {
  return dedupeStrings(
    items
      .map((item) => normalizeAssetSymbol(item.coin))
      .filter((value): value is string => Boolean(value)),
  );
}

function collectPerpAssetSymbols(items: TradeBrowseMarketItem[]): string[] {
  return dedupeStrings(
    items
      .map((item) => normalizePerpBaseSymbol(item.symbol))
      .filter((value): value is string => Boolean(value)),
  );
}

function interleaveSymbolGroups(groups: string[][], limit: number): string[] {
  const queues = groups.map((group) => group.slice());
  const output: string[] = [];
  const seen = new Set<string>();

  while (output.length < limit) {
    let progressed = false;
    for (const queue of queues) {
      while (queue.length > 0) {
        const next = normalizeAssetSymbol(queue.shift());
        if (!next || seen.has(next)) continue;
        seen.add(next);
        output.push(next);
        progressed = true;
        break;
      }
      if (output.length >= limit) break;
    }
    if (!progressed) break;
  }

  return output;
}

function interleaveStringGroups(groups: string[][], limit: number): string[] {
  const queues = groups.map((group) => group.slice());
  const output: string[] = [];
  const seen = new Set<string>();

  while (output.length < limit) {
    let progressed = false;
    for (const queue of queues) {
      while (queue.length > 0) {
        const next = queue.shift()?.trim();
        if (!next || seen.has(next)) continue;
        seen.add(next);
        output.push(next);
        progressed = true;
        break;
      }
      if (output.length >= limit) break;
    }
    if (!progressed) break;
  }

  return output;
}

function buildEditorCandidateAssets(editorId: TopicSpecialEditorId, input: TopicDraftGenerationInput): string[] {
  const marketSymbols = input.marketAssets.slice(0, 12).map((asset) => asset.symbol);
  const newsSymbols = collectNewsAssetSymbols(input.newsItems);
  const perpSymbols = collectPerpAssetSymbols(
    input.perps
      .slice()
      .sort((a, b) => Number(b.volume24h ?? 0) - Number(a.volume24h ?? 0))
      .slice(0, 10),
  );
  const defaultSymbols = normalizeAssetSymbols(input.defaultAssets, []);
  switch (editorId) {
    case 'majors':
      return normalizeAssetSymbols(
        interleaveSymbolGroups(
          [marketSymbols, newsSymbols, defaultSymbols, ['USDC', 'USDT', 'SOL', 'BNB', 'XRP']],
          8,
        ),
        ['BTC', 'ETH', 'SOL', 'USDC', 'USDT'],
      );
    case 'meme':
      return normalizeAssetSymbols(
        input.memeHeatItems
          .slice(0, 8)
          .map((item) => item.symbol ?? item.name ?? ''),
        ['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK'],
      );
    case 'perps':
      return normalizeAssetSymbols(
        interleaveSymbolGroups(
          [perpSymbols, marketSymbols, newsSymbols, ['SOL', 'DOGE', 'XRP', 'BNB']],
          8,
        ),
        ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP'],
      );
    case 'prediction':
      return normalizeAssetSymbols(
        interleaveSymbolGroups(
          [newsSymbols, defaultSymbols, marketSymbols, ['USDC', 'TRUMP', 'SOL', 'ETH']],
          8,
        ),
        ['BTC', 'ETH', 'SOL', 'USDC', 'TRUMP'],
      );
    default:
      return normalizeAssetSymbols(input.defaultAssets, ['BTC', 'ETH', 'SOL', 'USDC']);
  }
}

function buildTopicBeatResearchPacket(
  editorId: TopicSpecialEditorId,
  input: TopicDraftGenerationInput,
  options?: TopicSpecialDebugOptions,
): string {
  const compact = options?.compactDraftPacket === true;
  const headlineLimit = compact ? 4 : 6;
  const newsLimit = compact ? 3 : 5;
  const socialLimit = compact ? 3 : 4;
  const marketLimit = compact ? 4 : 6;
  const candidateAssets = buildEditorCandidateAssets(editorId, input);

  const majorKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'sol', 'stablecoin', 'usdc', 'usdt', 'etf', 'fed', 'rate', 'treasury', 'nasdaq', 'defi', 'payment', 'layer 2', 'rwa'];
  const memeKeywords = ['meme', 'memecoin', 'doge', 'dogecoin', 'shib', 'shiba', 'pepe', 'bonk', 'wif', 'pump'];
  const perpKeywords = ['perp', 'perpetual', 'futures', 'funding', 'basis', 'open interest', 'liquidation'];
  const predictionKeywords = ['polymarket', 'prediction', 'odds', 'election', 'approve', 'approval', 'cpi', 'fed', 'etf', 'bitcoin', 'ethereum', 'regulation', 'rate'];

  if (editorId === 'majors') {
    const newsItems = filterNewsItemsByKeywords(input.newsItems, majorKeywords).slice(0, newsLimit);
    const tweets = filterTweetsByKeywords(input.twitterItems, majorKeywords).slice(0, socialLimit);
    const spotAssets = input.marketAssets.slice(0, marketLimit);
    const perps = input.perps
      .slice()
      .sort((a, b) => Number(b.volume24h ?? 0) - Number(a.volume24h ?? 0))
      .filter((item) => candidateAssets.includes(normalizePerpBaseSymbol(item.symbol) ?? ''))
      .slice(0, 3);
    const predictions = filterPredictionsByKeywords(input.predictions, predictionKeywords).slice(0, 3);
    return [
      `Current slot: ${input.slotKey}`,
      '',
      'Desk focus: market breadth, stablecoin liquidity, ETF and macro regime, plus leadership rotation across liquid majors and alt leaders.',
      '',
      'Headline tape:',
      formatBulletBlock(
        filterLinesByKeywords(input.sourceRefs, majorKeywords).slice(0, headlineLimit).map((line) => truncateLine(line, 180)),
        '- No major-market headlines available.',
      ),
      '',
      'News detail:',
      formatBulletBlock(newsItems.map((item) => formatNewsSignalLine(item)), '- No major-market news signals available.'),
      '',
      'Social detail:',
      formatBulletBlock(tweets.map((item) => formatTweetSignalLine(item)), '- No major-market social signals available.'),
      '',
      'Spot snapshot:',
      formatBulletBlock(spotAssets.map((asset) => formatMarketSignalLine(asset)), '- No majors spot snapshot available.'),
      '',
      'Perp context:',
      formatBulletBlock(perps.map((item) => formatPerpSignalLine(item)), '- No majors perp context available.'),
      '',
      'Prediction context:',
      formatBulletBlock(predictions.map((item) => formatPredictionSignalLine(item)), '- No major prediction context available.'),
    ].join('\n');
  }

  if (editorId === 'meme') {
    const memeRefs = filterLinesByKeywords(input.sourceRefs, memeKeywords).slice(0, headlineLimit);
    const memeNews = filterNewsItemsByKeywords(input.newsItems, memeKeywords).slice(0, newsLimit);
    const memeTweets = filterTweetsByKeywords(input.twitterItems, memeKeywords).slice(0, socialLimit);
    const memeHeat = input.memeHeatItems.slice(0, compact ? 5 : 8);
    return [
      `Current slot: ${input.slotKey}`,
      '',
      'Desk focus: memecoin heat, social attention, and retail rotation.',
      '',
      'Headline tape:',
      formatBulletBlock(memeRefs.map((line) => truncateLine(line, 180)), '- No meme headlines available.'),
      '',
      'Meme heat snapshot:',
      formatBulletBlock(memeHeat.map((item) => formatMemeHeatLine(item)), '- No meme heat signals available.'),
      '',
      'News detail:',
      formatBulletBlock(memeNews.map((item) => formatNewsSignalLine(item)), '- No meme news signals available.'),
      '',
      'Social detail:',
      formatBulletBlock(memeTweets.map((item) => formatTweetSignalLine(item)), '- No meme social signals available.'),
    ].join('\n');
  }

  if (editorId === 'perps') {
    const topPerps = input.perps
      .slice()
      .sort((a, b) => {
        const aScore = Number(a.volume24h ?? 0) + Math.abs(Number(a.change24h ?? 0)) * 1_000_000;
        const bScore = Number(b.volume24h ?? 0) + Math.abs(Number(b.change24h ?? 0)) * 1_000_000;
        return bScore - aScore;
      })
      .slice(0, compact ? 5 : 8);
    const relevantSymbols = normalizeAssetSymbols(
      topPerps.map((item) => normalizePerpBaseSymbol(item.symbol) ?? item.symbol),
      candidateAssets,
    );
    const perpTweets = filterTweetsByKeywords(input.twitterItems, [...perpKeywords, ...relevantSymbols.map((item) => item.toLowerCase())]).slice(0, socialLimit);
    const spotAssets = input.marketAssets
      .filter((asset) => relevantSymbols.includes(normalizeAssetSymbol(asset.symbol) ?? ''))
      .slice(0, 4);
    return [
      `Current slot: ${input.slotKey}`,
      '',
      'Desk focus: derivatives positioning, leverage, and liquidation-sensitive moves.',
      '',
      'Headline tape:',
      formatBulletBlock(
        filterLinesByKeywords(input.sourceRefs, [...perpKeywords, ...relevantSymbols.map((item) => item.toLowerCase())])
          .slice(0, headlineLimit)
          .map((line) => truncateLine(line, 180)),
        '- No derivatives headlines available.',
      ),
      '',
      'Perp snapshot:',
      formatBulletBlock(topPerps.map((item) => formatPerpSignalLine(item)), '- No perp signals available.'),
      '',
      'Spot context:',
      formatBulletBlock(spotAssets.map((asset) => formatMarketSignalLine(asset)), '- No spot context for active perps available.'),
      '',
      'Social detail:',
      formatBulletBlock(perpTweets.map((item) => formatTweetSignalLine(item)), '- No derivatives social signals available.'),
    ].join('\n');
  }

  const topPredictions = input.predictions
    .slice()
    .sort((a, b) => Number(b.volume24h ?? 0) - Number(a.volume24h ?? 0))
    .slice(0, compact ? 4 : 6);
  const predictionTweets = filterTweetsByKeywords(input.twitterItems, predictionKeywords).slice(0, socialLimit);
  const predictionNews = filterNewsItemsByKeywords(input.newsItems, predictionKeywords).slice(0, newsLimit);
  return [
    `Current slot: ${input.slotKey}`,
    '',
    'Desk focus: event markets, odds repricing, and narrative timing.',
    '',
    'Headline tape:',
    formatBulletBlock(
      filterLinesByKeywords(input.sourceRefs, predictionKeywords).slice(0, headlineLimit).map((line) => truncateLine(line, 180)),
      '- No prediction-market headlines available.',
    ),
    '',
    'Prediction snapshot:',
    formatBulletBlock(topPredictions.map((item) => formatPredictionSignalLine(item)), '- No prediction signals available.'),
    '',
    'News detail:',
    formatBulletBlock(predictionNews.map((item) => formatNewsSignalLine(item)), '- No prediction-linked news signals available.'),
    '',
    'Social detail:',
    formatBulletBlock(predictionTweets.map((item) => formatTweetSignalLine(item)), '- No prediction-linked social signals available.'),
  ].join('\n');
}

function filterLinesByKeywords(lines: string[], keywords: string[]): string[] {
  const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase());
  const matched = lines.filter((line) => {
    const lower = line.toLowerCase();
    return normalizedKeywords.some((keyword) => lower.includes(keyword));
  });
  return matched.length > 0 ? matched : lines;
}

function filterNewsItemsByKeywords(items: NewsItem[], keywords: string[]): NewsItem[] {
  const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase());
  const matched = items.filter((item) => {
    const haystack = `${item.title} ${item.summary} ${item.coin} ${item.source}`.toLowerCase();
    return normalizedKeywords.some((keyword) => haystack.includes(keyword));
  });
  return matched.length > 0 ? matched : items;
}

function filterTweetsByKeywords(items: TweetItem[], keywords: string[]): TweetItem[] {
  const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase());
  const matched = sortTweetsByEngagement(items).filter((item) => {
    const haystack = `${item.text} ${item.author} ${item.handle}`.toLowerCase();
    return normalizedKeywords.some((keyword) => haystack.includes(keyword));
  });
  return matched.length > 0 ? matched : sortTweetsByEngagement(items);
}

function filterPredictionsByKeywords(items: TradeBrowsePredictionItem[], keywords: string[]): TradeBrowsePredictionItem[] {
  const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase());
  const matched = items.filter((item) => {
    const haystack = `${item.title} ${item.description ?? ''} ${item.options.map((option) => option.label).join(' ')}`.toLowerCase();
    return normalizedKeywords.some((keyword) => haystack.includes(keyword));
  });
  return matched.length > 0 ? matched : items;
}

function scoreTextAgainstTopic(text: string, topic: string, summary: string, symbols: string[]): number {
  const haystack = ` ${normalizePredictionSearchText(text)} `;
  let score = 0;
  for (const symbol of symbols) {
    if (haystack.includes(` ${symbol.toLowerCase()} `)) score += 8;
  }
  const tokens = new Set([...tokenizePredictionText(topic), ...tokenizePredictionText(summary)]);
  for (const token of tokens) {
    if (haystack.includes(` ${token} `)) score += 2;
  }
  return score;
}

function rankNewsItemsForTopic(items: NewsItem[], topic: string, summary: string, symbols: string[]): NewsItem[] {
  return items
    .map((item) => ({
      item,
      score:
        scoreTextAgainstTopic(`${item.title} ${item.summary} ${item.coin} ${item.source}`, topic, summary, symbols) +
        Math.min(4, Number(item.rating ?? 0)),
    }))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

function rankTweetsForTopic(items: TweetItem[], topic: string, summary: string, symbols: string[]): TweetItem[] {
  return items
    .map((item) => ({
      item,
      score:
        scoreTextAgainstTopic(`${item.text} ${item.author} ${item.handle}`, topic, summary, symbols) +
        Math.min(6, Math.log10(Math.max(1, item.likes + item.retweets + 1))),
    }))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

function rankSpotAssetsForTopic(items: MarketTopAsset[], topic: string, summary: string, symbols: string[]): MarketTopAsset[] {
  return items
    .map((item) => ({
      item,
      score:
        (symbols.includes(item.symbol) ? 20 : 0) +
        scoreTextAgainstTopic(`${item.symbol} ${item.name}`, topic, summary, symbols) +
        Math.max(0, 12 - Number(item.market_cap_rank ?? 12)),
    }))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

function rankPerpsForTopic(items: TradeBrowseMarketItem[], topic: string, summary: string, symbols: string[]): TradeBrowseMarketItem[] {
  return items
    .map((item) => ({
      item,
      score:
        scoreTextAgainstTopic(`${item.symbol} ${item.name}`, topic, summary, symbols) +
        Math.min(6, Math.log10(Math.max(1, Number(item.volume24h ?? 0) + 1))),
    }))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

function rankMemeHeatForTopic(
  items: DexScreenerMemeHeatItem[],
  topic: string,
  summary: string,
  symbols: string[],
): DexScreenerMemeHeatItem[] {
  return items
    .map((item) => ({
      item,
      score:
        scoreTextAgainstTopic(
          `${item.symbol ?? ''} ${item.name ?? ''} ${item.description ?? ''} ${item.matchedKeywords.join(' ')}`,
          topic,
          summary,
          symbols,
        ) + item.heatScore,
    }))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

function buildTopicArticleResearchPacket(input: TopicArticleInput): string {
  const assetNamesBySymbol = new Map<string, string>();
  for (const asset of input.marketAssets) {
    if (asset.name?.trim()) assetNamesBySymbol.set(asset.symbol, asset.name.trim());
  }

  const newsBlock = formatBulletBlock(
    rankNewsItemsForTopic(input.newsItems, input.topic, input.summary, input.relatedAssets)
      .slice(0, 6)
      .map((item) => formatNewsSignalLine(item)),
    '- No directly relevant news signals available.',
  );
  const socialBlock = formatBulletBlock(
    rankTweetsForTopic(input.twitterItems, input.topic, input.summary, input.relatedAssets)
      .slice(0, 5)
      .map((item) => formatTweetSignalLine(item)),
    '- No directly relevant social signals available.',
  );
  const memeHeatBlock = formatBulletBlock(
    rankMemeHeatForTopic(input.memeHeatItems, input.topic, input.summary, input.relatedAssets)
      .slice(0, 5)
      .map((item) => formatMemeHeatLine(item)),
    '- No directly relevant meme heat signals available.',
  );
  const spotBlock = formatBulletBlock(
    rankSpotAssetsForTopic(input.marketAssets, input.topic, input.summary, input.relatedAssets)
      .slice(0, 6)
      .map((asset) => formatMarketSignalLine(asset)),
    '- No directly relevant spot asset snapshot available.',
  );
  const perpBlock = formatBulletBlock(
    rankPerpsForTopic(input.perps, input.topic, input.summary, input.relatedAssets)
      .slice(0, 4)
      .map((item) => formatPerpSignalLine(item)),
    '- No directly relevant perp snapshot available.',
  );
  const predictionBlock = formatBulletBlock(
    input.predictions
      .map((prediction) => ({
        prediction,
        score: scorePredictionCandidate(prediction, input.topic, input.summary, input.relatedAssets, assetNamesBySymbol),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((item) => formatPredictionSignalLine(item.prediction)),
    '- No directly relevant prediction market snapshot available.',
  );
  const sourceRefBlock = formatBulletBlock(
    input.sourceRefs.slice(0, 6).map((line) => truncateLine(line, 180)),
    '- No source references available.',
  );
  const coveredTopicsBlock = formatBulletBlock(
    input.existingTopicsToday
      .filter((topic) => topic !== input.topic)
      .slice(0, 6),
    '- None.',
  );

  return [
    `Topic hypothesis: ${input.topic}`,
    `Summary anchor: ${input.summary}`,
    `Key assets: ${input.relatedAssets.join(', ') || 'BTC, ETH, USDC'}`,
    '',
    'Anchor evidence lines:',
    sourceRefBlock,
    '',
    'Relevant news signals:',
    newsBlock,
    '',
    'Relevant social signals:',
    socialBlock,
    '',
    'Relevant meme heat signals:',
    memeHeatBlock,
    '',
    'Relevant spot snapshot:',
    spotBlock,
    '',
    'Relevant perp snapshot:',
    perpBlock,
    '',
    'Relevant prediction signals:',
    predictionBlock,
    '',
    'Already covered today:',
    coveredTopicsBlock,
  ].join('\n');
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

function buildFallbackTopicDrafts(input: TopicDraftGenerationInput): TopicDraft[] {
  return TOPIC_SPECIAL_EDITOR_DEFINITIONS
    .flatMap((editor) => buildFallbackTopicDraftsForEditor(editor.id, input))
    .slice(0, TOPIC_SPECIAL_MAX_COUNT_PER_SLOT);
}

function buildFallbackTopicDraftsForEditor(
  editorId: TopicSpecialEditorId,
  input: TopicDraftGenerationInput,
): TopicDraft[] {
  const editor = TOPIC_SPECIAL_EDITOR_DEFINITIONS.find((item) => item.id === editorId);
  if (!editor) return [];
  const genericRefs = normalizeSourceRefs(input.sourceRefs);
  const candidateAssets = buildEditorCandidateAssets(editorId, input);
  const createDraft = (
    topic: string,
    summary: string,
    keywords: string[],
    assets: string[],
    editorScore: number,
  ): TopicDraft => ({
    editorId,
    editorLabel: editor.label,
    topic,
    summary: truncateSummary(summary),
    relatedAssets: normalizeAssetSymbols([...assets, ...candidateAssets], candidateAssets),
    sourceRefs: pickTopicSourceRefs(genericRefs, keywords),
    storyKey: null,
    editorScore,
    chiefScore: null,
    chiefReason: null,
  });

      switch (editorId) {
    case 'majors':
      return [
        createDraft(
          'Stablecoin Liquidity Is Becoming the Cleaner Risk Gauge',
          'Watch whether stablecoin balances, ETF headlines, and macro pricing are aligning with a broader expansion in market breadth.',
          ['stablecoin', 'usdc', 'usdt', 'etf', 'fed', 'rate'],
          ['USDC', 'USDT', 'SOL'],
          84,
        ),
        createDraft(
          'Market Breadth Needs to Confirm the Next Majors Breakout',
          'Leadership matters less than whether participation is broadening across majors, liquid alts, and policy-sensitive narratives.',
          ['market', 'breadth', 'etf', 'rates', 'rotation'],
          ['SOL', 'BNB', 'XRP'],
          80,
        ),
      ];
    case 'meme':
      return [
        createDraft(
          'Memecoin Heat Is Narrowing Into a Few Liquidity Winners',
          'Retail attention often clusters around a small set of liquid meme names before breadth either expands or breaks down.',
          ['meme', 'memecoin', 'doge', 'shib', 'pepe', 'wif', 'bonk'],
          ['DOGE', 'PEPE', 'WIF'],
          78,
        ),
        createDraft(
          'Retail Attention Is Chasing Velocity, Not Conviction',
          'The meme tape matters when social velocity rises faster than liquidity quality, because that usually drives fragile rotation.',
          ['meme', 'social', 'doge', 'shib', 'pepe'],
          ['DOGE', 'SHIB', 'BONK'],
          74,
        ),
      ];
    case 'perps':
      return [
        createDraft(
          'Leverage Is Concentrating Faster Than Spot Breadth',
          'When perp conviction outruns spot participation, the next high-volume move often becomes a positioning reset instead of a clean trend.',
          ['perp', 'futures', 'funding', 'basis', 'liquidation'],
          ['SOL', 'DOGE', 'XRP'],
          82,
        ),
        createDraft(
          'High-Beta Perps Are Testing Whether Rotation Has Real Conviction',
          'The tape gets more useful when leverage rotates into secondary names without immediately collapsing back into the largest pairs.',
          ['perp', 'futures', 'liquidation', 'open interest'],
          ['DOGE', 'XRP', 'BNB'],
          76,
        ),
      ];
    case 'prediction':
      return [
        createDraft(
          'Prediction Markets Are Repricing the Next Policy Catalyst',
          'When event-market odds move faster than spot, they often show which catalyst is about to reshape positioning across multiple sectors.',
          ['prediction', 'polymarket', 'fed', 'etf', 'approve', 'regulation'],
          ['USDC', 'SOL', 'TRUMP'],
          79,
        ),
        createDraft(
          'Event Odds Are Starting to Pull Narrative Attention',
          'Prediction markets are most valuable when odds shifts begin leading headline framing before the spot market fully reacts.',
          ['prediction', 'polymarket', 'election', 'cpi', 'fed'],
          ['TRUMP', 'USDC', 'SOL'],
          73,
        ),
      ];
    default:
      return [];
  }
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

function buildFallbackDeskFraming(editorId: TopicSpecialEditorId, relatedAssets: string[]): {
  whyNow: string;
  contextHeading: string;
  contextBody: string;
  bullish: string;
  neutral: string;
  risk: string;
  checklist: [string, string, string];
} {
  const assetLabel = relatedAssets.join(', ') || 'the tracked assets';
  if (editorId === 'meme') {
    return {
      whyNow: 'The real question is whether attention is broadening into tradeable liquidity or just creating another short-lived spike.',
      contextHeading: 'Attention Transmission',
      contextBody: `Meme leadership matters when social velocity starts pulling fresh capital into {primaryAssets}, but durability still depends on liquidity, venue quality, and whether new names can hold attention after the first burst.`,
      bullish: 'attention expands into {allAssets} with liquidity improving instead of thinning out',
      neutral: 'headline velocity stays high, but the rotation remains choppy and selective',
      risk: 'the crowd crowds back into a narrower set of names and {allAssets} fail to hold momentum once attention cools',
      checklist: [
        'Track whether social velocity is being confirmed by liquidity and turnover.',
        'Watch if new entrants are joining the move or if attention is staying narrow.',
        'Cut conviction quickly if narrative heat is not matched by execution quality.',
      ],
    };
  }
  if (editorId === 'perps') {
    return {
      whyNow: 'What matters is whether leverage is reinforcing spot direction or setting up another forced unwind.',
      contextHeading: 'Positioning Context',
      contextBody: `When derivatives interest outruns spot confirmation, moves in {primaryAssets} can become fragile. The useful signal is whether volume, basis, and liquidation risk are broadening across the complex instead of clustering in one obvious pair.`,
      bullish: 'perp conviction is matched by spot follow-through and the rotation broadens across {allAssets}',
      neutral: 'positioning stays active, but the market keeps mean-reverting before a real trend can form',
      risk: 'crowded leverage in {allAssets} becomes the setup for a sharper liquidation-led reset',
      checklist: [
        'Watch whether spot breadth is confirming the perp move.',
        'Check if the highest-volume contracts are still leading or if participation is rotating.',
        'Treat crowded leverage without spot confirmation as a warning, not a green light.',
      ],
    };
  }
  if (editorId === 'prediction') {
    return {
      whyNow: 'The key is whether odds are moving early enough to reveal the next catalyst before spot positioning fully catches up.',
      contextHeading: 'Catalyst Context',
      contextBody: `Event markets help when they reprice a policy or narrative catalyst before the broader market does. In that setup, {primaryAssets} matter less as standalone tickers and more as expressions of which scenario traders think will dominate next.`,
      bullish: 'odds shifts start pulling positioning and narrative attention into {allAssets} before the broader tape reacts',
      neutral: 'event pricing moves, but conviction stays contained and the spot market waits for confirmation',
      risk: 'odds reprice back the other way and {allAssets} lose the catalyst premium that had started to build',
      checklist: [
        'Track whether event odds are leading headlines or merely echoing them.',
        'Check which assets and sectors are most exposed to the repricing.',
        'Be careful when the catalyst narrative expands faster than supporting evidence.',
      ],
    };
  }
  return {
    whyNow: 'The key question is whether broad market participation is strengthening or whether the latest headline is only lifting the most obvious names.',
    contextHeading: 'Market Regime Context',
    contextBody: `Macro pricing, ETF flows, stablecoin liquidity, and sector rotation all shape whether moves in {primaryAssets} represent a durable regime shift or just another narrow burst of leadership. The best confirmation usually comes from breadth, not from a single ticker.`,
    bullish: 'capital rotation broadens beyond the headline into {allAssets}, with participation improving across the tape',
    neutral: 'the narrative stays alive, but conviction remains selective and breadth fails to improve much',
    risk: 'the next macro or policy catalyst narrows leadership again before {allAssets} can confirm follow-through',
    checklist: [
      'Track whether breadth is improving alongside the headline catalyst.',
      'Watch stablecoin, ETF, and sector-rotation signals for confirmation.',
      `Treat ${assetLabel} as expressions of a broader regime call, not as isolated stories.`,
    ],
  };
}

function buildFallbackTopicArticleMarkdown(input: TopicArticleInput): string {
  const relatedAssets = normalizeAssetSymbols(input.relatedAssets, ['BTC', 'ETH', 'USDC']);
  const sourceRefs = normalizeSourceRefs(input.sourceRefs);
  const sourceLines = sourceRefs.length > 0
    ? sourceRefs.map((line) => `- ${line}`).join('\n')
    : '- Macro and crypto signals remain mixed across liquidity, policy, and risk appetite.';
  const primaryAssets = relatedAssets.slice(0, 2).join(' and ') || 'the current leaders';
  const allAssets = relatedAssets.join(', ') || 'the tracked assets';
  const framing = buildFallbackDeskFraming(input.editorId, relatedAssets);

  return [
    `# ${input.topic}`,
    '',
    '## Why this matters now',
    `${input.summary} ${framing.whyNow}`,
    '',
    `## ${framing.contextHeading}`,
    framing.contextBody.replace('{primaryAssets}', primaryAssets),
    '',
    'Current source signals:',
    sourceLines,
    '',
    '## Scenario watch',
    `- Bullish: ${framing.bullish.replace('{allAssets}', allAssets)}`,
    `- Neutral: ${framing.neutral}`,
    `- Risk: ${framing.risk.replace('{allAssets}', allAssets)}`,
    '',
    '## Action checklist',
    `- ${framing.checklist[0]}`,
    `- ${framing.checklist[1]}`,
    `- ${framing.checklist[2]}`,
    '',
    '## Related Assets',
    ...relatedAssets.map((asset) => `- ${asset}`),
    '',
  ].join('\n');
}

function buildSourceReferences(newsItems: NewsItem[], twitterItems: TweetItem[], rssHeadlines: string[]): string[] {
  const newsRefs = newsItems
    .map((item) => {
      const title = item.title.trim();
      if (!title) return null;
      const source = item.source ? ` (${item.source.trim()})` : '';
      return `${title}${source}`.slice(0, 180);
    })
    .filter((value): value is string => Boolean(value));
  const rssRefs = rssHeadlines
    .map((headline) => headline.trim())
    .filter(Boolean)
    .map((line) => line.slice(0, 180));
  const tweetRefs = twitterItems
    .map((tweet) => {
      const text = tweet.text.trim();
      if (!text) return null;
      const handle = tweet.handle?.trim() ? `@${tweet.handle.trim()}: ` : '';
      return `${handle}${text.slice(0, 140)}`;
    })
    .filter((value): value is string => Boolean(value));
  const refs = interleaveStringGroups([newsRefs, rssRefs, tweetRefs], SOURCE_REFERENCE_LIMIT);

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

function buildDefaultAssetPool(
  marketAssets: MarketTopAsset[],
  newsItems: NewsItem[],
  memeHeatItems: DexScreenerMemeHeatItem[],
  perps: TradeBrowseMarketItem[],
): string[] {
  const marketSymbols = marketAssets
    .map((asset) => normalizeAssetSymbol(asset.symbol))
    .filter((value): value is string => Boolean(value))
    .slice(0, 10);
  const newsSymbols = collectNewsAssetSymbols(newsItems).slice(0, 8);
  const memeSymbols = memeHeatItems
    .map((item) => normalizeAssetSymbol(item.symbol))
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);
  const perpSymbols = collectPerpAssetSymbols(perps).slice(0, 8);
  const deduped = interleaveSymbolGroups([marketSymbols, newsSymbols, memeSymbols, perpSymbols], 18)
    .filter((item) => normalizeAssetSymbol(item) != null);
  if (deduped.length >= 6) return deduped;
  return dedupeStrings([...deduped, 'BTC', 'ETH', 'SOL', 'USDC', 'USDT', 'DOGE']);
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
        name: item.prediction.title,
        image: item.prediction.image,
        price_change_percentage_24h: null,
      },
    });
  }

  return [...new Map(candidates.map((item) => [item.key, item.ref])).values()].slice(0, 8);
}

function sanitizeAssetSymbols(assets: string[] | null | undefined): string[] {
  return dedupeStrings(
    (assets ?? [])
      .map((asset) => normalizeAssetSymbol(asset))
      .filter((value): value is string => Boolean(value)),
  );
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

function parseStoredStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return readStringArray(parsed) ?? [];
  } catch {
    return [];
  }
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
