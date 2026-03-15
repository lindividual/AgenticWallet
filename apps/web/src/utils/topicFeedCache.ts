import type { AgentArticle } from '../api';
import { cacheStores, readCache, writeCache } from './indexedDbCache';

const TOPIC_FEED_CACHE_TTL_MS = 30 * 60 * 1000;
const TOPIC_READ_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

type TopicReadMap = Record<string, number>;
export type TopicFeedCacheValue = {
  articles: AgentArticle[];
  hasMore: boolean;
  nextOffset: number | null;
};

function buildTopicFeedCacheKey(userId: string): string {
  return `home-topic-feed:v1:${userId}`;
}

function buildTopicReadCacheKey(userId: string): string {
  return `home-topic-read:v1:${userId}`;
}

export async function readTopicFeedCache(userId: string): Promise<TopicFeedCacheValue | null> {
  return readCache<TopicFeedCacheValue>(cacheStores.query, buildTopicFeedCacheKey(userId));
}

export async function writeTopicFeedCache(userId: string, value: TopicFeedCacheValue): Promise<void> {
  await writeCache(cacheStores.query, buildTopicFeedCacheKey(userId), value, TOPIC_FEED_CACHE_TTL_MS);
}

export async function readTopicReadCache(userId: string): Promise<TopicReadMap> {
  return (await readCache<TopicReadMap>(cacheStores.query, buildTopicReadCacheKey(userId))) ?? {};
}

export async function markTopicArticleRead(userId: string, articleId: string): Promise<void> {
  const articleKey = articleId.trim();
  if (!userId || !articleKey) return;
  const current = await readTopicReadCache(userId);
  if (current[articleKey]) return;
  await writeCache(
    cacheStores.query,
    buildTopicReadCacheKey(userId),
    {
      ...current,
      [articleKey]: Date.now(),
    },
    TOPIC_READ_CACHE_TTL_MS,
  );
}
