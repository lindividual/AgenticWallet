import { generateWithLlm, getLlmErrorInfo, getLlmStatus } from '../services/llm';
import {
  buildArticleR2Key,
  buildFallbackTopicMarkdown,
  isoDate,
  summarizeEvents,
} from './userAgentHelpers';
import { buildPortfolioContext, resolveDailyLanguage } from './userAgentContentHelpers';
import { putArticleMarkdownContent } from './userAgentArticleContentStore';
import type { ContentDeps } from './userAgentContentTypes';

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
