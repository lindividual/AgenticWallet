import type { Bindings } from '../types';

const API_BASE = 'https://ai.6551.io';

type OpenNewsArticle = {
  title?: string;
  summary?: string;
  source?: string;
  coin?: string;
  rating?: number | string;
  published_at?: string;
  url?: string;
};

type OpenNewsResponse = {
  code?: number;
  data?: {
    list?: OpenNewsArticle[];
  };
};

type TwitterSearchTweet = {
  text?: string;
  user?: { name?: string; username?: string };
  created_at?: string;
  like_count?: number | string;
  retweet_count?: number | string;
};

type TwitterSearchResponse = {
  code?: number;
  data?: {
    list?: TwitterSearchTweet[];
  };
};

export type NewsItem = {
  title: string;
  source: string;
  summary: string;
  coin: string;
  rating: number | null;
};

export type TweetItem = {
  text: string;
  author: string;
  handle: string;
  likes: number;
  retweets: number;
};

export async function fetchOpenNewsCryptoNews(
  env: Bindings,
  options?: { keywords?: string[]; coins?: string[]; limit?: number },
): Promise<NewsItem[]> {
  const token = env.OPENNEWS_TOKEN?.trim();
  if (!token) return [];

  const limit = options?.limit ?? 10;
  const body: Record<string, unknown> = {
    page: 1,
    size: limit,
    engine: 'news',
  };
  if (options?.keywords?.length) {
    body.keyword = options.keywords.join(' ');
  }
  if (options?.coins?.length) {
    body.coins = options.coins.join(',');
  }

  try {
    const res = await fetch(`${API_BASE}/open/news_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as OpenNewsResponse;
    const list = json.data?.list ?? [];

    return list
      .filter((item) => item.title?.trim())
      .slice(0, limit)
      .map((item) => ({
        title: (item.title ?? '').trim(),
        source: (item.source ?? '').trim(),
        summary: (item.summary ?? '').trim(),
        coin: (item.coin ?? '').trim(),
        rating: typeof item.rating === 'number' ? item.rating : null,
      }));
  } catch {
    return [];
  }
}

export async function fetchOpenTwitterCryptoTweets(
  env: Bindings,
  options?: { keywords?: string[]; limit?: number },
): Promise<TweetItem[]> {
  const token = env.TWITTER_TOKEN?.trim();
  if (!token) return [];

  const limit = options?.limit ?? 8;
  const keyword = options?.keywords?.length
    ? options.keywords.join(' OR ')
    : 'crypto OR bitcoin OR ethereum';

  try {
    const res = await fetch(`${API_BASE}/open/twitter_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        keyword,
        size: limit,
        sort: 'relevance',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as TwitterSearchResponse;
    const list = json.data?.list ?? [];

    return list
      .filter((item) => item.text?.trim())
      .slice(0, limit)
      .map((item) => ({
        text: (item.text ?? '').trim().slice(0, 280),
        author: item.user?.name ?? 'Unknown',
        handle: item.user?.username ?? '',
        likes: Number(item.like_count) || 0,
        retweets: Number(item.retweet_count) || 0,
      }));
  } catch {
    return [];
  }
}
