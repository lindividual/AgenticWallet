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
import type { ArticleRow, EventRow, JobRow, JobType, RecommendationRow, TodayDailyStatus } from './userAgentTypes';
import { safeJsonParse } from '../utils/json';

const OWNER_KEY = 'owner_user_id';
const JOB_STATUS_QUEUED = 'queued';
const JOB_STATUS_RUNNING = 'running';
const JOB_STATUS_SUCCEEDED = 'succeeded';
const JOB_STATUS_FAILED = 'failed';
const MAX_JOB_RETRIES = 3;

export class UserAgentDO extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS agent_state (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS user_events (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          dedupe_key TEXT,
          occurred_at TEXT NOT NULL,
          received_at TEXT NOT NULL
        )`,
      );
      this.ctx.storage.sql.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_events_dedupe_key ON user_events(dedupe_key) WHERE dedupe_key IS NOT NULL',
      );
      this.ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS idx_user_events_occurred_at ON user_events(occurred_at DESC)',
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL,
          run_at TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          retry_count INTEGER NOT NULL DEFAULT 0,
          job_key TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      );
      try {
        this.ctx.storage.sql.exec('ALTER TABLE jobs ADD COLUMN job_key TEXT');
      } catch {
        // Column already exists on new tables; ignore on older instances.
      }
      this.ctx.storage.sql.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_job_key ON jobs(job_key) WHERE job_key IS NOT NULL',
      );
      this.ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, run_at)',
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS article_index (
          id TEXT PRIMARY KEY,
          article_type TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          r2_key TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS article_contents (
          article_id TEXT PRIMARY KEY,
          markdown TEXT NOT NULL,
          FOREIGN KEY(article_id) REFERENCES article_index(id)
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS recommendations (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          asset_name TEXT NOT NULL,
          reason TEXT NOT NULL,
          score REAL NOT NULL,
          generated_at TEXT NOT NULL,
          valid_until TEXT
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS guide_prompts (
          id TEXT PRIMARY KEY,
          page TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
      );
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

  async alarm(): Promise<void> {
    const now = new Date();
    const dueJobs = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          job_type,
          run_at,
          status,
          payload_json,
          retry_count,
          job_key
         FROM jobs
         WHERE status = ?
           AND run_at <= ?
         ORDER BY run_at ASC
         LIMIT 10`,
        JOB_STATUS_QUEUED,
        now.toISOString(),
      )
      .toArray() as JobRow[];

    for (const job of dueJobs) {
      await this.runJob(job);
    }

    await this.scheduleNextAlarm();
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
    const normalizedJobKey = jobKey?.trim() || null;
    if (normalizedJobKey) {
      const existing = this.ctx.storage.sql
        .exec('SELECT id FROM jobs WHERE job_key = ? LIMIT 1', normalizedJobKey)
        .toArray()[0] as Record<string, unknown> | undefined;
      const existingId = normalizeSqlString(existing?.id);
      if (existingId) {
        return { jobId: existingId, deduped: true };
      }
    }

    const jobId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (
        id,
        job_type,
        run_at,
        status,
        payload_json,
        retry_count,
        job_key,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      jobId,
      jobType,
      runAtIso,
      JOB_STATUS_QUEUED,
      JSON.stringify(payload),
      0,
      normalizedJobKey,
      nowIso,
      nowIso,
    );

    await this.scheduleNextAlarm();
    return { jobId, deduped: false };
  }

  private async runJob(job: JobRow): Promise<void> {
    const startedAtMs = Date.now();
    const nowIso = new Date().toISOString();
    console.log('user_agent_job_started', {
      jobId: job.id,
      jobType: job.job_type,
      runAt: job.run_at,
      retryCount: job.retry_count,
    });
    this.ctx.storage.sql.exec(
      'UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?',
      JOB_STATUS_RUNNING,
      nowIso,
      job.id,
    );

    try {
      const payload = safeJsonParse<Record<string, unknown>>(job.payload_json) ?? {};
      await this.executeJob(job.job_type, payload);
      this.ctx.storage.sql.exec(
        'UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?',
        JOB_STATUS_SUCCEEDED,
        new Date().toISOString(),
        job.id,
      );
      console.log('user_agent_job_succeeded', {
        jobId: job.id,
        jobType: job.job_type,
        durationMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      const nextRetry = job.retry_count + 1;
      const durationMs = Date.now() - startedAtMs;
      if (nextRetry > MAX_JOB_RETRIES) {
        this.ctx.storage.sql.exec(
          'UPDATE jobs SET status = ?, retry_count = ?, updated_at = ? WHERE id = ?',
          JOB_STATUS_FAILED,
          nextRetry,
          new Date().toISOString(),
          job.id,
        );
        console.error('user_agent_job_failed', {
          jobId: job.id,
          jobType: job.job_type,
          retryCount: nextRetry,
          durationMs,
          finalFailed: true,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const nextRun = new Date(Date.now() + retryBackoffMs(nextRetry)).toISOString();
      this.ctx.storage.sql.exec(
        'UPDATE jobs SET status = ?, retry_count = ?, run_at = ?, updated_at = ? WHERE id = ?',
        JOB_STATUS_QUEUED,
        nextRetry,
        nextRun,
        new Date().toISOString(),
        job.id,
      );
      console.error('user_agent_job_failed', {
        jobId: job.id,
        jobType: job.job_type,
        retryCount: nextRetry,
        durationMs,
        finalFailed: false,
        nextRun,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
    });
  }

  private async refreshRecommendations(_payload: Record<string, unknown>): Promise<void> {
    await refreshRecommendationsContent(_payload, {
      env: this.env,
      sql: this.ctx.storage.sql,
      getOwnerUserId: () => this.getOwnerUserId(),
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
    });
  }

  private async generateTopicArticle(payload: Record<string, unknown>): Promise<void> {
    await generateTopicArticleContent(payload, {
      env: this.env,
      sql: this.ctx.storage.sql,
      getOwnerUserId: () => this.getOwnerUserId(),
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
    });
  }

  private async getArticleMarkdown(articleId: string, r2Key: string): Promise<string> {
    return getArticleMarkdownContent(this.env, this.ctx.storage.sql, articleId, r2Key);
  }

  private async scheduleNextAlarm(): Promise<void> {
    const nextRow = this.ctx.storage.sql
      .exec(
        `SELECT run_at
         FROM jobs
         WHERE status = ?
         ORDER BY run_at ASC
         LIMIT 1`,
        JOB_STATUS_QUEUED,
      )
      .toArray()[0] as Record<string, unknown> | undefined;

    const runAtIso = normalizeSqlString(nextRow?.run_at);
    if (!runAtIso) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const nextTs = Date.parse(runAtIso);
    if (!Number.isFinite(nextTs)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextTs);
  }
}
