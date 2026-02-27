import { DurableObject } from 'cloudflare:workers';
import type { AgentEventRecord } from '../agent/events';
import {
  generateDailyDigestContent,
  generateTopicArticleContent,
  getArticleMarkdownContent,
  refreshRecommendationsContent,
} from './userAgentContentService';
import type { Bindings } from '../types';
import {
  enqueueJob,
  JOB_STATUS_FAILED,
  JOB_STATUS_QUEUED,
  JOB_STATUS_RUNNING,
  JOB_STATUS_SUCCEEDED,
  runDueJobs,
} from './userAgentJobRunner';
import {
  isoDate,
  isRecommendationTriggerEvent,
  nextUtcHour,
  normalizeOccurredAt,
  normalizeSqlNumber,
  normalizeSqlString,
  retryBackoffMs,
  sanitizeLimit,
  tomorrowDate,
} from './userAgentHelpers';
import { initializeAgentSchema } from './userAgentSchema';
import type {
  ArticleRow,
  EventRow,
  JobType,
  PortfolioSnapshotPoint,
  RecommendationRow,
  TodayDailyStatus,
} from './userAgentTypes';
import { safeJsonParse } from '../utils/json';

const OWNER_KEY = 'owner_user_id';
const USER_LOCALE_KEY = 'user_locale';
const REQUEST_LOCALE_KEY = 'request_locale';
const MAX_JOB_RETRIES = 3;
const HOURLY_SNAPSHOT_RETENTION_HOURS = 72;
const DAILY_SNAPSHOT_RETENTION_DAYS = 180;

export class UserAgentDO extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      initializeAgentSchema(this.ctx.storage.sql);
    });
  }

  async ingestEventRpc(event: AgentEventRecord): Promise<{
    ok: true;
    eventId: string;
    deduped: boolean;
    sequence: number;
  }> {
    await this.ensureDailyDigestJobs();
    return this.ingestEvent(event);
  }

  async setUserLocaleRpc(userId: string, locale: string | null): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    this.setUserLocale(locale);
    return { ok: true };
  }

  async setRequestLocaleRpc(userId: string, locale: string | null): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    this.setRequestLocale(locale);
    return { ok: true };
  }

  async listRecommendationsRpc(
    userId: string,
    limit = 10,
  ): Promise<{ recommendations: RecommendationRow[] }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    return { recommendations: this.getRecommendations(limit) };
  }

  async listArticlesRpc(
    userId: string,
    options?: {
      limit?: number;
      articleType?: string;
    },
  ): Promise<{ articles: ArticleRow[] }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTodayDailyReady();
    const limit = options?.limit ?? 20;
    const articleType = options?.articleType ?? null;
    return { articles: this.getArticles(limit, articleType) };
  }

  async getArticleDetailRpc(
    userId: string,
    articleId: string,
  ): Promise<{ article: ArticleRow; markdown: string } | null> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTodayDailyReady();
    return this.getArticleDetail(articleId);
  }

  async getTodayDailyRpc(userId: string): Promise<{
    date: string;
    status: TodayDailyStatus;
    article: ArticleRow | null;
    lastReadyArticle: ArticleRow | null;
  }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTodayDailyReady();

    const now = new Date();
    const dateKey = isoDate(now);
    const article = this.getTodayDailyArticle(dateKey);
    const lastReadyArticle = this.getLatestDailyBefore(dateKey);

    if (article) {
      return {
        date: dateKey,
        status: 'ready',
        article,
        lastReadyArticle,
      };
    }

    const status = this.getTodayDailyJobStatus(dateKey);
    return {
      date: dateKey,
      status,
      article: null,
      lastReadyArticle,
    };
  }

  async enqueueJobRpc(
    userId: string,
    options: {
      jobType: JobType;
      runAt?: string;
      payload?: Record<string, unknown>;
      jobKey?: string;
    },
  ): Promise<{ ok: true; jobId: string; deduped: boolean }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    const runAt = normalizeOccurredAt(options.runAt);
    const result = await this.enqueueJob(options.jobType, runAt, options.payload ?? {}, options.jobKey ?? null);
    return { ok: true, ...result };
  }

  async runJobsNowRpc(userId: string): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.alarm();
    return { ok: true };
  }

  async savePortfolioSnapshotRpc(
    userId: string,
    input: { totalUsd: number; holdings: unknown[]; asOf?: string },
  ): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    const asOf = normalizeOccurredAt(input.asOf);
    this.savePortfolioSnapshot(asOf, input.totalUsd, input.holdings ?? []);
    return { ok: true };
  }

  async listPortfolioSnapshotsRpc(
    userId: string,
    period: '24h' | '7d' | '30d',
  ): Promise<{ points: PortfolioSnapshotPoint[] }> {
    this.ensureOwner(userId);
    return { points: this.listPortfolioSnapshots(period) };
  }

  async alarm(): Promise<void> {
    await runDueJobs({
      sql: this.ctx.storage.sql,
      alarmStorage: this.ctx.storage,
      executeJob: (jobType, payload) => this.executeJob(jobType, payload),
    });
  }

  private async ingestEvent(event: AgentEventRecord): Promise<{
    ok: true;
    eventId: string;
    deduped: boolean;
    sequence: number;
  }> {
    if (!event?.userId || !event?.eventId || !event?.type) {
      throw new Error('invalid_event_payload');
    }

    this.ensureOwner(event.userId);

    if (event.dedupeKey) {
      const existing = this.ctx.storage.sql
        .exec('SELECT id FROM user_events WHERE dedupe_key = ? LIMIT 1', event.dedupeKey)
        .toArray()[0] as Record<string, unknown> | undefined;
      const existingId = normalizeSqlString(existing?.id);
      if (existingId) {
        return {
          ok: true,
          eventId: existingId,
          deduped: true,
          sequence: this.countEvents(),
        };
      }
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO user_events (
        id,
        user_id,
        event_type,
        payload_json,
        dedupe_key,
        occurred_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      event.userId,
      event.type,
      JSON.stringify(event.payload ?? {}),
      event.dedupeKey,
      event.occurredAt,
      event.receivedAt,
    );

    if (isRecommendationTriggerEvent(event.type)) {
      const today = isoDate(new Date());
      const jobKey = `recommendation_refresh:${today}`;
      await this.enqueueJob('recommendation_refresh', new Date(Date.now() + 5000).toISOString(), {}, jobKey);
    }

    await this.ensureDailyDigestJobs();

    return {
      ok: true,
      eventId: event.eventId,
      deduped: false,
      sequence: this.countEvents(),
    };
  }

  private ensureOwner(userId: string): void {
    const row = this.ctx.storage.sql
      .exec('SELECT value_json FROM agent_state WHERE key = ? LIMIT 1', OWNER_KEY)
      .toArray()[0] as Record<string, unknown> | undefined;
    const valueJson = normalizeSqlString(row?.value_json);
    if (!valueJson) {
      this.ctx.storage.sql.exec(
        'INSERT INTO agent_state (key, value_json, updated_at) VALUES (?, ?, ?)',
        OWNER_KEY,
        JSON.stringify({ userId }),
        new Date().toISOString(),
      );
      return;
    }

    const parsed = JSON.parse(valueJson) as { userId?: string };
    if (parsed.userId !== userId) {
      throw new Error('user_id_mismatch_for_agent');
    }
  }

  private getOwnerUserId(): string | null {
    const row = this.ctx.storage.sql
      .exec('SELECT value_json FROM agent_state WHERE key = ? LIMIT 1', OWNER_KEY)
      .toArray()[0] as Record<string, unknown> | undefined;
    const valueJson = normalizeSqlString(row?.value_json);
    if (!valueJson) return null;
    const parsed = safeJsonParse<{ userId?: string }>(valueJson);
    return parsed?.userId ?? null;
  }

  private setUserLocale(locale: string | null): void {
    const normalized = locale?.trim().toLowerCase() ?? '';
    const value = normalized.slice(0, 32);
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      USER_LOCALE_KEY,
      JSON.stringify({ locale: value || null }),
      new Date().toISOString(),
    );
  }

  private setRequestLocale(locale: string | null): void {
    const normalized = locale?.trim().toLowerCase() ?? '';
    const value = normalized.slice(0, 32);
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      REQUEST_LOCALE_KEY,
      JSON.stringify({ locale: value || null }),
      new Date().toISOString(),
    );
  }

  private getLocaleByKey(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec('SELECT value_json FROM agent_state WHERE key = ? LIMIT 1', key)
      .toArray()[0] as Record<string, unknown> | undefined;
    const valueJson = normalizeSqlString(row?.value_json);
    if (!valueJson) return null;
    const parsed = safeJsonParse<{ locale?: string | null }>(valueJson);
    const locale = parsed?.locale;
    if (typeof locale !== 'string') return null;
    const normalized = locale.trim().toLowerCase();
    return normalized || null;
  }

  private getEffectiveLocale(): string | null {
    const userLocale = this.getLocaleByKey(USER_LOCALE_KEY);
    if (userLocale) return userLocale;
    return this.getLocaleByKey(REQUEST_LOCALE_KEY);
  }

  private countEvents(): number {
    const row = this.ctx.storage.sql.exec('SELECT COUNT(*) as count FROM user_events').one() as
      | Record<string, unknown>
      | null;
    return normalizeSqlNumber(row?.count);
  }

  private getLatestEvents(limit = 20): EventRow[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          event_type,
          occurred_at,
          received_at,
          payload_json,
          dedupe_key
         FROM user_events
         ORDER BY received_at DESC
         LIMIT ?`,
        sanitizeLimit(limit, 1, 100),
      )
      .toArray() as EventRow[];
  }

  private getRecommendations(limit = 10): RecommendationRow[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          category,
          asset_name,
          reason,
          score,
          generated_at,
          valid_until
         FROM recommendations
         ORDER BY generated_at DESC
         LIMIT ?`,
        sanitizeLimit(limit, 1, 100),
      )
      .toArray() as RecommendationRow[];
  }

  private getArticles(limit = 20, articleType: string | null = null): ArticleRow[] {
    const normalizedType = articleType?.trim();
    if (normalizedType) {
      return this.ctx.storage.sql
        .exec(
          `SELECT
            id,
            article_type,
            title,
            summary,
            r2_key,
            tags_json,
            created_at,
            status
           FROM article_index
           WHERE article_type = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          normalizedType,
          sanitizeLimit(limit, 1, 100),
        )
        .toArray() as ArticleRow[];
    }

    return this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          article_type,
          title,
          summary,
          r2_key,
          tags_json,
          created_at,
          status
         FROM article_index
         ORDER BY created_at DESC
         LIMIT ?`,
        sanitizeLimit(limit, 1, 100),
      )
      .toArray() as ArticleRow[];
  }

  private async getArticleDetail(articleId: string): Promise<{ article: ArticleRow; markdown: string } | null> {
    const article = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          article_type,
          title,
          summary,
          r2_key,
          tags_json,
          created_at,
          status
         FROM article_index
         WHERE id = ?
         LIMIT 1`,
        articleId,
      )
      .toArray()[0] as ArticleRow | undefined;

    if (!article) {
      return null;
    }

    const markdown = await this.getArticleMarkdown(article.id, article.r2_key);

    return {
      article,
      markdown,
    };
  }

  private async ensureDailyDigestJobs(): Promise<void> {
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) return;

    const now = new Date();
    const today = isoDate(now);
    const hasTodayArticle = this.ctx.storage.sql
      .exec(
        `SELECT id
         FROM article_index
         WHERE article_type = 'daily'
           AND created_at >= ?
           AND created_at < ?
         LIMIT 1`,
        `${today}T00:00:00.000Z`,
        `${tomorrowDate(today)}T00:00:00.000Z`,
      )
      .toArray()[0];

    if (!hasTodayArticle) {
      await this.enqueueJob('daily_digest', new Date().toISOString(), {}, `daily_digest:${today}`);
    }

    const nextRun = nextUtcHour(now, 8);
    const nextDate = isoDate(nextRun);
    await this.enqueueJob('daily_digest', nextRun.toISOString(), {}, `daily_digest:${nextDate}`);
  }

  private hasTodayDailyArticle(now: Date): boolean {
    const today = isoDate(now);
    return Boolean(
      this.ctx.storage.sql
        .exec(
          `SELECT id
           FROM article_index
           WHERE article_type = 'daily'
             AND created_at >= ?
             AND created_at < ?
           LIMIT 1`,
          `${today}T00:00:00.000Z`,
          `${tomorrowDate(today)}T00:00:00.000Z`,
        )
        .toArray()[0],
    );
  }

  private async ensureTodayDailyReady(): Promise<void> {
    const now = new Date();
    if (this.hasTodayDailyArticle(now)) return;
    await this.alarm();
  }

  private getTodayDailyArticle(dateKey: string): ArticleRow | null {
    return (
      (this.ctx.storage.sql
        .exec(
          `SELECT
            id,
            article_type,
            title,
            summary,
            r2_key,
            tags_json,
            created_at,
            status
           FROM article_index
           WHERE article_type = 'daily'
             AND created_at >= ?
             AND created_at < ?
           ORDER BY created_at DESC
           LIMIT 1`,
          `${dateKey}T00:00:00.000Z`,
          `${tomorrowDate(dateKey)}T00:00:00.000Z`,
        )
        .toArray()[0] as ArticleRow | undefined) ?? null
    );
  }

  private getLatestDailyBefore(dateKey: string): ArticleRow | null {
    return (
      (this.ctx.storage.sql
        .exec(
          `SELECT
            id,
            article_type,
            title,
            summary,
            r2_key,
            tags_json,
            created_at,
            status
           FROM article_index
           WHERE article_type = 'daily'
             AND created_at < ?
           ORDER BY created_at DESC
           LIMIT 1`,
          `${dateKey}T00:00:00.000Z`,
        )
        .toArray()[0] as ArticleRow | undefined) ?? null
    );
  }

  private getTodayDailyJobStatus(dateKey: string): TodayDailyStatus {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT status
         FROM jobs
         WHERE job_type = 'daily_digest'
           AND (job_key = ? OR job_key = ?)
         ORDER BY updated_at DESC
         LIMIT 1`,
        `daily_digest:${dateKey}`,
        `manual_daily_digest:${dateKey}`,
      )
      .toArray()[0] as { status?: string } | undefined;

    const status = normalizeSqlString(row?.status);
    if (status === JOB_STATUS_FAILED) return 'failed';
    if (status === JOB_STATUS_QUEUED || status === JOB_STATUS_RUNNING || status === JOB_STATUS_SUCCEEDED) {
      return 'generating';
    }
    return 'stale';
  }

  private async enqueueJob(
    jobType: JobType,
    runAtIso: string,
    payload: Record<string, unknown>,
    jobKey: string | null,
  ): Promise<{ jobId: string; deduped: boolean }> {
    return enqueueJob({
      sql: this.ctx.storage.sql,
      alarmStorage: this.ctx.storage,
      jobType,
      runAtIso,
      payload,
      jobKey,
    });
  }

  private async executeJob(jobType: JobType, payload: Record<string, unknown>): Promise<void> {
    switch (jobType) {
      case 'daily_digest':
        await this.generateDailyDigest(payload);
        return;
      case 'recommendation_refresh':
        await this.refreshRecommendations(payload);
        return;
      case 'topic_generation':
        await this.generateTopicArticle(payload);
        return;
      case 'cleanup':
        return;
      default:
        throw new Error(`unsupported_job_type_${jobType}`);
    }
  }

  private async generateDailyDigest(_payload: Record<string, unknown>): Promise<void> {
    await generateDailyDigestContent(_payload, {
      env: this.env,
      sql: this.ctx.storage.sql,
      getOwnerUserId: () => this.getOwnerUserId(),
      getPreferredLocale: () => this.getEffectiveLocale(),
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
    });
  }

  private async refreshRecommendations(_payload: Record<string, unknown>): Promise<void> {
    await refreshRecommendationsContent(_payload, {
      env: this.env,
      sql: this.ctx.storage.sql,
      getOwnerUserId: () => this.getOwnerUserId(),
      getPreferredLocale: () => this.getEffectiveLocale(),
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
    });
  }

  private async generateTopicArticle(payload: Record<string, unknown>): Promise<void> {
    await generateTopicArticleContent(payload, {
      env: this.env,
      sql: this.ctx.storage.sql,
      getOwnerUserId: () => this.getOwnerUserId(),
      getPreferredLocale: () => this.getEffectiveLocale(),
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
    });
  }

  private async getArticleMarkdown(articleId: string, r2Key: string): Promise<string> {
    return getArticleMarkdownContent(this.env, this.ctx.storage.sql, articleId, r2Key);
  }

  private toHourBucket(asOf: string): string {
    return `${asOf.slice(0, 13)}:00:00.000Z`;
  }

  private toDateBucket(asOf: string): string {
    return asOf.slice(0, 10);
  }

  private savePortfolioSnapshot(asOf: string, totalUsd: number, holdings: unknown[]): void {
    const safeTotalUsd = Number.isFinite(totalUsd) ? totalUsd : 0;
    const hourBucket = this.toHourBucket(asOf);
    const dateBucket = this.toDateBucket(asOf);
    this.ctx.storage.sql.exec(
      `INSERT INTO portfolio_snapshots_hourly (
         bucket_hour_utc, total_usd, holdings_json, as_of, created_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bucket_hour_utc) DO UPDATE SET
         total_usd = excluded.total_usd,
         holdings_json = excluded.holdings_json,
         as_of = excluded.as_of,
         created_at = excluded.created_at`,
      hourBucket,
      safeTotalUsd,
      JSON.stringify(holdings ?? []),
      asOf,
      asOf,
    );

    const isUtcMidnight = asOf.slice(11, 13) === '00';
    if (isUtcMidnight) {
      this.ctx.storage.sql.exec(
        `INSERT INTO portfolio_snapshots_daily (
           bucket_date_utc, total_usd, as_of, created_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(bucket_date_utc) DO UPDATE SET
           total_usd = excluded.total_usd,
           as_of = excluded.as_of,
           created_at = excluded.created_at`,
        dateBucket,
        safeTotalUsd,
        asOf,
        asOf,
      );
    }

    this.cleanupPortfolioSnapshots(asOf);
  }

  private cleanupPortfolioSnapshots(asOf: string): void {
    const nowTs = Date.parse(asOf);
    if (!Number.isFinite(nowTs)) return;
    const hourlyCutoff = new Date(nowTs - HOURLY_SNAPSHOT_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
    const dailyCutoff = new Date(nowTs - DAILY_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    this.ctx.storage.sql.exec('DELETE FROM portfolio_snapshots_hourly WHERE bucket_hour_utc < ?', hourlyCutoff);
    this.ctx.storage.sql.exec('DELETE FROM portfolio_snapshots_daily WHERE bucket_date_utc < ?', dailyCutoff);
  }

  private listPortfolioSnapshots(period: '24h' | '7d' | '30d'): PortfolioSnapshotPoint[] {
    if (period === '24h') {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT bucket_hour_utc as ts, total_usd
           FROM portfolio_snapshots_hourly
           ORDER BY bucket_hour_utc DESC
           LIMIT 24`,
        )
        .toArray() as Array<{ ts?: string; total_usd?: number }>;
      return rows
        .reverse()
        .map((row) => ({
          ts: normalizeSqlString(row.ts) ?? '',
          total_usd: normalizeSqlNumber(row.total_usd),
        }))
        .filter((row) => Boolean(row.ts));
    }

    const limit = period === '7d' ? 7 : 30;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT bucket_date_utc as ts, total_usd
         FROM portfolio_snapshots_daily
         ORDER BY bucket_date_utc DESC
         LIMIT ?`,
        limit,
      )
      .toArray() as Array<{ ts?: string; total_usd?: number }>;
    return rows
      .reverse()
      .map((row) => {
        const day = normalizeSqlString(row.ts);
        return {
          ts: day ? `${day}T00:00:00.000Z` : '',
          total_usd: normalizeSqlNumber(row.total_usd),
        };
      })
      .filter((row) => Boolean(row.ts));
  }
}
