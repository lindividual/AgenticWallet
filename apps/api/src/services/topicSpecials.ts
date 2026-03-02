import { fetchNewsHeadlines } from '../durableObjects/userAgentRss';
import { generateWithLlm, getLlmErrorInfo, getLlmStatus } from './llm';
import type { MarketTopAsset } from './bitgetWallet';
import { fetchTopMarketAssets } from './marketTopAssets';
import { fetchOpenNewsCryptoNews, fetchOpenTwitterCryptoTweets, type NewsItem, type TweetItem } from './openNews';
import type { Bindings } from '../types';

const MIN_TOPIC_COUNT = 3;
const TARGET_TOPIC_COUNT = 4;
const MAX_TOPIC_COUNT = 5;
const SOURCE_REFERENCE_LIMIT = 18;
const SUMMARY_MAX_LENGTH = 180;

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

type TopicBucket = {
  title: string;
  baseSummary: string;
  keywords: string[];
  relatedAssets: string[];
};

const FALLBACK_TOPIC_BUCKETS: TopicBucket[] = [
  {
    title: 'Fed rates, liquidity, and crypto beta',
    baseSummary: 'Track how policy signals and liquidity changes shape crypto risk appetite.',
    keywords: ['fed', 'fomc', 'rates', 'inflation', 'treasury', 'yield', 'dollar'],
    relatedAssets: ['BTC', 'ETH', 'SOL'],
  },
  {
    title: 'ETF and institutional flow: TradFi to crypto bridge',
    baseSummary: 'Watch whether institutional flows and ETF narratives rotate into major tokens.',
    keywords: ['etf', 'institutional', 'blackrock', 'flows', 'fund', 'spot'],
    relatedAssets: ['BTC', 'ETH', 'ARB'],
  },
  {
    title: 'Stablecoin liquidity and on-chain risk sentiment',
    baseSummary: 'Use stablecoin flow and market breadth to evaluate risk-on or risk-off transitions.',
    keywords: ['stablecoin', 'usdt', 'usdc', 'liquidity', 'depeg', 'on-chain'],
    relatedAssets: ['USDT', 'USDC', 'ETH'],
  },
  {
    title: 'Tech equities correlation with crypto momentum',
    baseSummary: 'Assess whether Nasdaq-led risk appetite confirms or diverges from crypto momentum.',
    keywords: ['nasdaq', 'stocks', 'equity', 'tech', 'risk-on', 'risk-off'],
    relatedAssets: ['BTC', 'ETH', 'SOL'],
  },
  {
    title: 'Defensive positioning: volatility, macro shocks, and hedges',
    baseSummary: 'Prepare scenarios for volatility spikes when macro headlines pressure risky assets.',
    keywords: ['volatility', 'vix', 'recession', 'tariff', 'geopolitical', 'selloff'],
    relatedAssets: ['BTC', 'ETH', 'USDC'],
  },
];

type TopicDraft = {
  topic: string;
  summary: string;
  relatedAssets: string[];
  sourceRefs: string[];
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

export async function generateTopicSpecialBatch(
  env: Bindings,
  options?: { force?: boolean },
): Promise<TopicSpecialGenerationResult> {
  await ensureTopicSpecialSchema(env.DB);
  const slotKey = toHalfDaySlotKey(new Date());
  const existingRows = await listTopicRowsInSlot(env.DB, slotKey);
  const existingCount = existingRows.length;

  if (existingCount >= MAX_TOPIC_COUNT) {
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }

  if (!options?.force && existingCount >= MIN_TOPIC_COUNT) {
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }

  const [newsItems, twitterItems, rssHeadlines, marketAssets] = await Promise.all([
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
  ]);

  const sourceRefs = buildSourceReferences(newsItems, twitterItems, rssHeadlines);
  const defaultAssets = buildDefaultAssetPool(marketAssets, newsItems);

  let drafts: TopicDraft[] = [];
  const llmStatus = getLlmStatus(env);
  if (llmStatus.enabled) {
    try {
      const llmResult = await generateWithLlm(env, {
        messages: [
          {
            role: 'system',
            content: [
              'You are a market strategist writing topic plans for a fintech wallet app.',
              'Generate 3 to 5 investable topics that connect traditional finance and crypto markets.',
              'Topics must be grounded in provided news and Twitter signals.',
              'Output strict JSON array only.',
            ].join(' '),
          },
          {
            role: 'user',
            content: buildTopicDraftPrompt(sourceRefs, defaultAssets),
          },
        ],
        temperature: 0.35,
        maxTokens: 1600,
      });
      drafts = parseTopicDrafts(llmResult.text, defaultAssets, sourceRefs);
    } catch (error) {
      const llmError = getLlmErrorInfo(error);
      console.error('topic_special_draft_llm_failed', {
        ...llmError,
        llm: llmStatus,
      });
    }
  }

  if (drafts.length < MIN_TOPIC_COUNT) {
    drafts = buildFallbackTopicDrafts(sourceRefs, marketAssets, defaultAssets);
  }

  const existingSlugs = new Set(existingRows.map((row) => row.topic_slug));
  const candidateDrafts = drafts
    .filter((draft) => {
      const slug = slugifyTopic(draft.topic);
      return Boolean(slug) && !existingSlugs.has(slug);
    })
    .slice(0, MAX_TOPIC_COUNT);

  const remainingCapacity = Math.max(MAX_TOPIC_COUNT - existingCount, 0);
  if (remainingCapacity === 0) {
    return {
      slotKey,
      generated: 0,
      skipped: true,
      totalInSlot: existingCount,
    };
  }

  const requiredNewCount = Math.max(MIN_TOPIC_COUNT - existingCount, 0);
  const minWhenForced = options?.force === true ? 1 : 0;
  const targetNewCount = Math.min(
    remainingCapacity,
    Math.max(requiredNewCount, TARGET_TOPIC_COUNT - existingCount, minWhenForced),
  );
  const selectedDrafts = candidateDrafts.slice(0, targetNewCount);

  let generated = 0;
  for (const draft of selectedDrafts) {
    const topicSlug = slugifyTopic(draft.topic);
    if (!topicSlug) continue;
    if (existingSlugs.has(topicSlug)) continue;

    const articleId = crypto.randomUUID();
    const generatedAt = new Date().toISOString();
    const r2Key = buildTopicR2Key(slotKey, topicSlug, articleId);
    const normalizedAssets = normalizeAssetSymbols(draft.relatedAssets, defaultAssets);
    const normalizedRefs = normalizeSourceRefs(draft.sourceRefs.length > 0 ? draft.sourceRefs : sourceRefs);
    const markdown = await buildTopicArticleMarkdown(env, {
      slotKey,
      topic: draft.topic,
      summary: draft.summary,
      relatedAssets: normalizedAssets,
      sourceRefs: normalizedRefs,
    });

    await env.AGENT_ARTICLES.put(r2Key, markdown, {
      httpMetadata: {
        contentType: 'text/markdown; charset=utf-8',
      },
      customMetadata: {
        articleId,
        slotKey,
        topic: draft.topic.slice(0, 120),
      },
    });

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
          JSON.stringify(normalizedAssets),
          JSON.stringify(normalizedRefs),
          generatedAt,
          'ready',
        )
        .run();
      generated += 1;
      existingSlugs.add(topicSlug);
    } catch (error) {
      console.error('topic_special_insert_failed', {
        slotKey,
        topicSlug,
        message: error instanceof Error ? error.message : String(error),
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

async function ensureTopicSpecialSchema(db: D1Database): Promise<void> {
  if (topicSpecialSchemaReady) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS topic_special_articles (
         id TEXT PRIMARY KEY,
         slot_key TEXT NOT NULL,
         topic_slug TEXT NOT NULL,
         title TEXT NOT NULL,
         summary TEXT NOT NULL,
         r2_key TEXT NOT NULL,
         related_assets_json TEXT NOT NULL,
         source_refs_json TEXT NOT NULL,
         generated_at TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'ready'
       )`,
    )
    .run();
  await db
    .prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_special_slot_slug ON topic_special_articles(slot_key, topic_slug)')
    .run();
  await db
    .prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_special_r2_key ON topic_special_articles(r2_key)')
    .run();
  await db
    .prepare('CREATE INDEX IF NOT EXISTS idx_topic_special_generated_at ON topic_special_articles(generated_at DESC)')
    .run();
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

function toHalfDaySlotKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  const hour = date.getUTCHours() >= 12 ? '12' : '00';
  return `${year}-${month}-${day}T${hour}`;
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
    if (drafts.length >= MAX_TOPIC_COUNT) break;
  }

  return drafts;
}

function buildFallbackTopicDrafts(
  sourceRefs: string[],
  marketAssets: MarketTopAsset[],
  defaultAssets: string[],
): TopicDraft[] {
  const sourceCorpus = sourceRefs.join('\n').toLowerCase();
  const marketSymbols = marketAssets
    .map((asset) => normalizeAssetSymbol(asset.symbol))
    .filter((value): value is string => Boolean(value));

  const ranked = FALLBACK_TOPIC_BUCKETS
    .map((bucket, index) => {
      const score = bucket.keywords.reduce((acc, keyword) => {
        return sourceCorpus.includes(keyword.toLowerCase()) ? acc + 1 : acc;
      }, 0);
      return { bucket, score, index };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  const output: TopicDraft[] = [];
  for (const item of ranked.slice(0, MAX_TOPIC_COUNT)) {
    const keywordSources = sourceRefs
      .filter((line) => item.bucket.keywords.some((keyword) => line.toLowerCase().includes(keyword.toLowerCase())))
      .slice(0, 3);
    const refs = normalizeSourceRefs(keywordSources.length > 0 ? keywordSources : sourceRefs);
    const relatedAssets = normalizeAssetSymbols(
      [...item.bucket.relatedAssets, ...marketSymbols.slice(0, 3)],
      defaultAssets,
    );
    const anchor = refs[0] ?? 'recent macro and crypto updates';
    output.push({
      topic: item.bucket.title,
      summary: truncateSummary(`${item.bucket.baseSummary} Trigger: ${anchor}`),
      relatedAssets,
      sourceRefs: refs,
    });
  }

  if (output.length < MIN_TOPIC_COUNT) {
    const emergency = defaultAssets.length > 0 ? defaultAssets : ['BTC', 'ETH', 'USDC'];
    while (output.length < MIN_TOPIC_COUNT) {
      const suffix = output.length + 1;
      output.push({
        topic: `Macro and crypto watchlist ${suffix}`,
        summary: truncateSummary('Monitor cross-market liquidity, risk appetite, and sector rotation signals.'),
        relatedAssets: emergency.slice(0, 3),
        sourceRefs: normalizeSourceRefs(sourceRefs),
      });
    }
  }

  return output.slice(0, MAX_TOPIC_COUNT);
}

type TopicArticleInput = {
  slotKey: string;
  topic: string;
  summary: string;
  relatedAssets: string[];
  sourceRefs: string[];
};

async function buildTopicArticleMarkdown(env: Bindings, input: TopicArticleInput): Promise<string> {
  const fallback = buildFallbackTopicArticleMarkdown(input);
  const llmStatus = getLlmStatus(env);
  if (!llmStatus.enabled) {
    return fallback;
  }

  try {
    const llmResult = await generateWithLlm(env, {
      messages: [
        {
          role: 'system',
          content: [
            'You are a cross-market analyst writing actionable topic briefs for wallet users.',
            'Every article must connect traditional finance and crypto market transmission.',
            'Output markdown only.',
            'Include a final "## Related Assets" section with bullet symbols.',
          ].join(' '),
        },
        {
          role: 'user',
          content: buildTopicArticlePrompt(input),
        },
      ],
      temperature: 0.45,
      maxTokens: 2000,
    });
    const text = llmResult.text.trim();
    if (!text) return fallback;
    return ensureRelatedAssetsSection(text, input.relatedAssets);
  } catch (error) {
    const llmError = getLlmErrorInfo(error);
    console.error('topic_special_article_llm_failed', {
      ...llmError,
      llm: llmStatus,
      slotKey: input.slotKey,
      topic: input.topic,
    });
    return fallback;
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

function buildFallbackTopicArticleMarkdown(input: TopicArticleInput): string {
  const sourceBlock = input.sourceRefs.length > 0
    ? input.sourceRefs.slice(0, 6).map((line) => `- ${line}`).join('\n')
    : '- External source density is low. Keep focus on macro and liquidity updates.';
  const assetBlock = input.relatedAssets.length > 0
    ? input.relatedAssets.map((asset) => `- ${asset}`).join('\n')
    : '- BTC\n- ETH\n- USDC';

  return [
    `# ${input.topic}`,
    '',
    `> ${input.summary}`,
    '',
    '## Why this matters now',
    sourceBlock,
    '',
    '## TradFi x Crypto transmission',
    '- Follow policy-rate expectations, treasury yields, and equity risk sentiment as upstream signals.',
    '- Validate whether crypto breadth and stablecoin liquidity confirm the same risk direction.',
    '',
    '## Scenario watch',
    '- Bull case: easing macro pressure plus improving market breadth.',
    '- Base case: mixed macro data and selective sector rotation.',
    '- Bear case: tighter liquidity and synchronized risk-off repricing.',
    '',
    '## Action checklist',
    '- Define position size and invalidation conditions before adding exposure.',
    '- Review liquidity, slippage, and chain-specific execution risk.',
    '- Re-check thesis when macro signals diverge from crypto internals.',
    '',
    '## Related Assets',
    assetBlock,
  ].join('\n');
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
