import {
  getUserAgentArticleDetail,
  getUserAgentOpsOverview,
  type AgentOpsOverview,
} from './agent';
import { getWallet } from './wallet';
import type { Bindings, WalletSummary } from '../types';

type AdminUserRow = {
  id: string;
  handle: string;
  display_name: string;
  created_at: string;
  last_login_at: string | null;
};

type AdminTopicSpecialArticleRow = {
  id: string;
  slot_key: string;
  topic_slug: string;
  title: string;
  summary: string;
  r2_key: string;
  generated_at: string;
  status: string;
};

export type AdminUserSummary = {
  id: string;
  handle: string;
  displayName: string;
  createdAt: string;
  lastLoginAt: string | null;
};

export type AdminUserAgentListItem = {
  user: AdminUserSummary;
  walletAddress: string | null;
  overview: {
    generatedAt: string | null;
    activity: {
      isActive: boolean;
      activeUntil: string | null;
      eventCount: number;
    };
    daily: {
      status: AgentOpsOverview['daily']['status'] | 'unknown';
      articleTitle: string | null;
    };
    jobs: {
      counts: AgentOpsOverview['jobs']['counts'];
      nextQueuedRunAt: string | null;
    };
    recommendations: {
      count: number;
      dirty: boolean;
    };
    articles: {
      latestTitle: string | null;
    };
    portfolio: {
      latestTotalUsd: number | null;
    };
  };
};

export type AdminUserAgentDetail = {
  user: AdminUserSummary;
  wallet: WalletSummary | null;
  overview: AgentOpsOverview;
};

export type AdminTopicSpecialArticle = {
  id: string;
  slotKey: string;
  topicSlug: string;
  title: string;
  summary: string;
  r2Key: string;
  generatedAt: string;
  status: string;
};

function toAdminUserSummary(row: AdminUserRow): AdminUserSummary {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function toTopicSpecialArticle(row: AdminTopicSpecialArticleRow): AdminTopicSpecialArticle {
  return {
    id: row.id,
    slotKey: row.slot_key,
    topicSlug: row.topic_slug,
    title: row.title,
    summary: row.summary,
    r2Key: row.r2_key,
    generatedAt: row.generated_at,
    status: row.status,
  };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value as number)));
}

function buildLikeQuery(query: string): string {
  return `%${query.trim()}%`;
}

function pickWalletAddress(wallet: WalletSummary | null): string | null {
  return wallet?.address ?? wallet?.chainAccounts?.[0]?.address ?? null;
}

export async function listAdminUserAgentSummaries(
  env: Bindings,
  options?: {
    query?: string;
    limit?: number;
  },
): Promise<{ total: number; items: AdminUserAgentListItem[] }> {
  const query = options?.query?.trim() ?? '';
  const limit = clampLimit(options?.limit, 12, 50);
  const likeQuery = buildLikeQuery(query);
  const whereClause = `(? = '' OR handle LIKE ? COLLATE NOCASE OR display_name LIKE ? COLLATE NOCASE)`;

  const [totalRow, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE ${whereClause}`)
      .bind(query, likeQuery, likeQuery)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT id, handle, display_name, created_at, last_login_at
       FROM users
       WHERE ${whereClause}
       ORDER BY COALESCE(last_login_at, created_at) DESC, created_at DESC
       LIMIT ?`,
    )
      .bind(query, likeQuery, likeQuery, limit)
      .all<AdminUserRow>(),
  ]);

  const items = await Promise.all(
    rows.results.map(async (row) => {
      const [wallet, overview] = await Promise.all([
        getWallet(env, row.id).catch(() => null),
        getUserAgentOpsOverview(env, row.id, {
          recentJobLimit: 4,
          recentEventLimit: 3,
          recommendationLimit: 2,
          articleLimit: 2,
          watchlistLimit: 2,
          transferLimit: 2,
        }).catch(() => null),
      ]);

      return {
        user: toAdminUserSummary(row),
        walletAddress: pickWalletAddress(wallet),
        overview: {
          generatedAt: overview?.generated_at ?? null,
          activity: {
            isActive: overview?.activity.is_active ?? false,
            activeUntil: overview?.activity.active_until ?? null,
            eventCount: overview?.activity.event_count ?? 0,
          },
          daily: {
            status: overview?.daily.status ?? 'unknown',
            articleTitle: overview?.daily.article?.title ?? overview?.daily.last_ready_article?.title ?? null,
          },
          jobs: {
            counts: overview?.jobs.counts ?? {
              queued: 0,
              running: 0,
              succeeded: 0,
              failed: 0,
            },
            nextQueuedRunAt: overview?.jobs.next_queued_run_at ?? null,
          },
          recommendations: {
            count: overview?.recommendations.count ?? 0,
            dirty: overview?.recommendations.dirty ?? false,
          },
          articles: {
            latestTitle: overview?.articles.items[0]?.title ?? null,
          },
          portfolio: {
            latestTotalUsd: overview?.portfolio.latest_hourly_snapshot?.total_usd ?? null,
          },
        },
      } satisfies AdminUserAgentListItem;
    }),
  );

  return {
    total: Number(totalRow?.count ?? items.length),
    items,
  };
}

export async function getAdminUserAgentDetail(env: Bindings, userId: string): Promise<AdminUserAgentDetail> {
  const row = await env.DB.prepare(
    `SELECT id, handle, display_name, created_at, last_login_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(userId)
    .first<AdminUserRow>();

  if (!row) {
    throw new Error('user_not_found');
  }

  const [wallet, overview] = await Promise.all([
    getWallet(env, userId).catch(() => null),
    getUserAgentOpsOverview(env, userId, {
      recentJobLimit: 12,
      recentEventLimit: 12,
      recommendationLimit: 6,
      articleLimit: 6,
      watchlistLimit: 8,
      transferLimit: 8,
    }),
  ]);

  return {
    user: toAdminUserSummary(row),
    wallet,
    overview,
  };
}

export async function getAdminUserAgentArticleDetail(env: Bindings, userId: string, articleId: string) {
  return getUserAgentArticleDetail(env, userId, articleId);
}

export async function listRecentTopicSpecialArticles(
  env: Bindings,
  limit?: number,
): Promise<AdminTopicSpecialArticle[]> {
  const normalizedLimit = clampLimit(limit, 8, 30);
  const rows = await env.DB.prepare(
    `SELECT id, slot_key, topic_slug, title, summary, r2_key, generated_at, status
     FROM topic_special_articles
     ORDER BY generated_at DESC
     LIMIT ?`,
  )
    .bind(normalizedLimit)
    .all<AdminTopicSpecialArticleRow>();

  return rows.results.map((row) => toTopicSpecialArticle(row));
}
