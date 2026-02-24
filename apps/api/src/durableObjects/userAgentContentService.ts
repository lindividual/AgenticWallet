import { generateWithLlm, getLlmErrorInfo, getLlmStatus } from '../services/llm';
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
  getLatestEvents: (limit?: number) => EventRow[];
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
  const llmStatus = getLlmStatus(deps.env);

  let markdown = buildFallbackDailyDigestMarkdown(dateKey, eventSummary);
  if (llmStatus.enabled) {
    try {
      const llmResult = await generateWithLlm(deps.env, {
        messages: [
          {
            role: 'system',
            content:
              'You are a crypto wallet content agent. Write concise markdown in Chinese. Focus on actionable market context and user-relevant insights.',
          },
          {
            role: 'user',
            content: [
              `Date: ${dateKey}`,
              `User ID: ${ownerUserId}`,
              `Recent event counts: ${JSON.stringify(eventSummary.counts)}`,
              `Top assets: ${eventSummary.topAssets.join(', ') || 'N/A'}`,
              'Generate a daily digest in markdown with sections: # title, ## 今日摘要, ## 关注资产, ## 可执行动作.',
              'Keep it under 300 Chinese words.',
            ].join('\n'),
          },
        ],
        temperature: 0.4,
        maxTokens: 900,
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

  const title = `日报 ${dateKey}`;
  const summary = `今日事件 ${recentEvents.length} 条，重点资产 ${eventSummary.topAssets.slice(0, 3).join(', ') || '暂无'}。`;
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
  const assets = eventSummary.topAssets;
  const top = assets.slice(0, 3);
  const generatedAt = now.toISOString();
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  deps.sql.exec('DELETE FROM recommendations WHERE generated_at < ?', dayStart);

  const [tradeAsset, receiveAsset, sendAsset] = [
    top[0] ?? 'ETH',
    top[1] ?? top[0] ?? 'USDC',
    top[2] ?? top[0] ?? 'BNB',
  ];

  let rows = buildFallbackRecommendations(tradeAsset, receiveAsset, sendAsset);

  const llmStatus = getLlmStatus(deps.env);
  if (llmStatus.enabled) {
    try {
      const llmResult = await generateWithLlm(deps.env, {
        messages: [
          {
            role: 'system',
            content:
              'You generate JSON-only wallet asset recommendations. Output must be strict JSON without markdown.',
          },
          {
            role: 'user',
            content: [
              `Top candidate assets: ${[tradeAsset, receiveAsset, sendAsset].join(', ')}`,
              `Recent event counts: ${JSON.stringify(eventSummary.counts)}`,
              'Return JSON array with 3 items and fields: category(trade|receive|send), asset, reason, score(0-1).',
              'Language: Chinese, concise reason (under 40 Chinese characters each).',
            ].join('\n'),
          },
        ],
        temperature: 0.2,
        maxTokens: 500,
      });
      const parsed = parseLlmRecommendations(llmResult.text);
      if (parsed.length === 3) {
        rows = parsed;
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
    deps.sql.exec(
      `INSERT INTO recommendations (
        id,
        category,
        asset_name,
        reason,
        score,
        generated_at,
        valid_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      row.category,
      row.asset,
      row.reason,
      row.score,
      generatedAt,
      validUntil,
    );
  }
}

export async function generateTopicArticleContent(payload: Record<string, unknown>, deps: ContentDeps): Promise<void> {
  const ownerUserId = deps.getOwnerUserId();
  if (!ownerUserId) {
    throw new Error('owner_user_not_initialized');
  }

  const requestedTopic = typeof payload.topic === 'string' ? payload.topic.trim() : '';
  const topic = requestedTopic || '市场热点追踪';
  const now = new Date();
  const dateKey = isoDate(now);
  const recentEvents = deps.getLatestEvents(100);
  const eventSummary = summarizeEvents(recentEvents);
  const llmStatus = getLlmStatus(deps.env);

  let markdown = buildFallbackTopicMarkdown(dateKey, topic, eventSummary);
  if (llmStatus.enabled) {
    try {
      const llmResult = await generateWithLlm(deps.env, {
        messages: [
          {
            role: 'system',
            content: 'You are a crypto strategy writer for wallet users. Write Chinese markdown with practical steps.',
          },
          {
            role: 'user',
            content: [
              `Date: ${dateKey}`,
              `Topic: ${topic}`,
              `Top assets: ${eventSummary.topAssets.join(', ') || 'N/A'}`,
              `Event counts: ${JSON.stringify(eventSummary.counts)}`,
              'Write markdown with sections: # 标题, ## 核心观点, ## 机会与风险, ## 用户可执行动作.',
              'Keep it under 500 Chinese words.',
            ].join('\n'),
          },
        ],
        temperature: 0.5,
        maxTokens: 1200,
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
    `专题: ${topic}`,
    `${topic} 专题，聚焦用户高关注资产与可执行动作。`,
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

  // Backward-compatibility for existing read path during migration window.
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

  // Fallback for old records before R2 migration.
  const content = sql
    .exec('SELECT article_id, markdown FROM article_contents WHERE article_id = ? LIMIT 1', articleId)
    .toArray()[0] as ArticleContentRow | undefined;
  return content?.markdown ?? '';
}
