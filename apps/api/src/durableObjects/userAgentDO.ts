import { DurableObject } from 'cloudflare:workers';
import type { AgentEventRecord } from '../agent/events';
import { generateWithLlm, getLlmStatus } from '../services/llm';
import type { Bindings } from '../types';
import { safeJsonParse } from '../utils/json';

const OWNER_KEY = 'owner_user_id';
const JOB_STATUS_QUEUED = 'queued';
const JOB_STATUS_RUNNING = 'running';
const JOB_STATUS_SUCCEEDED = 'succeeded';
const JOB_STATUS_FAILED = 'failed';
const MAX_JOB_RETRIES = 3;

type JobType = 'daily_digest' | 'recommendation_refresh' | 'topic_generation' | 'cleanup';

type EventRow = {
  id: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  payload_json: string;
  dedupe_key: string | null;
};

type RecommendationRow = {
  id: string;
  category: string;
  asset_name: string;
  reason: string;
  score: number;
  generated_at: string;
  valid_until: string | null;
};

type ArticleRow = {
  id: string;
  article_type: string;
  title: string;
  summary: string;
  r2_key: string;
  tags_json: string;
  created_at: string;
  status: string;
};

type ArticleContentRow = {
  article_id: string;
  markdown: string;
};

type JobRow = {
  id: string;
  job_type: JobType;
  run_at: string;
  status: string;
  payload_json: string;
  retry_count: number;
  job_key: string | null;
};

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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'GET' || url.pathname !== '/health') {
      await this.ensureDailyDigestJobs();
    }

    if (request.method === 'POST' && url.pathname === '/events') {
      const body = (await request.json()) as AgentEventRecord;
      return Response.json(await this.ingestEvent(body));
    }

    if (request.method === 'POST' && url.pathname === '/jobs/enqueue') {
      const body = (await request.json()) as {
        userId?: string;
        jobType: string;
        runAt?: string;
        payload?: Record<string, unknown>;
        jobKey?: string;
      };
      if (!isJobType(body.jobType)) {
        return Response.json({ error: 'invalid_job_type' }, { status: 400 });
      }
      if (body.userId) {
        this.ensureOwner(body.userId);
      }
      const runAt = normalizeOccurredAt(body.runAt);
      const result = await this.enqueueJob(body.jobType, runAt, body.payload ?? {}, body.jobKey ?? null);
      return Response.json({ ok: true, ...result });
    }

    if (request.method === 'POST' && url.pathname === '/jobs/run-now') {
      await this.alarm();
      return Response.json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/events/latest') {
      return Response.json({ events: this.getLatestEvents() });
    }

    if (request.method === 'GET' && url.pathname === '/recommendations') {
      const limit = Number(url.searchParams.get('limit') ?? 10);
      return Response.json({ recommendations: this.getRecommendations(limit) });
    }

    if (request.method === 'GET' && url.pathname === '/articles') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const articleType = url.searchParams.get('type');
      return Response.json({ articles: this.getArticles(limit, articleType) });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/articles/')) {
      const articleId = decodeURIComponent(url.pathname.replace('/articles/', '').trim());
      if (!articleId) {
        return Response.json({ error: 'invalid_article_id' }, { status: 400 });
      }
      const detail = this.getArticleDetail(articleId);
      if (!detail) {
        return Response.json({ error: 'article_not_found' }, { status: 404 });
      }
      return Response.json(detail);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'not_found' }, { status: 404 });
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
        .one() as Record<string, unknown> | null;
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
      .one() as Record<string, unknown> | null;
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
      .one() as Record<string, unknown> | null;
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

  private getArticleDetail(articleId: string): { article: ArticleRow; markdown: string } | null {
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
      .one() as ArticleRow | null;

    if (!article) {
      return null;
    }

    const content = this.ctx.storage.sql
      .exec('SELECT article_id, markdown FROM article_contents WHERE article_id = ? LIMIT 1', articleId)
      .one() as ArticleContentRow | null;

    return {
      article,
      markdown: content?.markdown ?? '',
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
      .one();

    if (!hasTodayArticle) {
      await this.enqueueJob('daily_digest', new Date(Date.now() + 5000).toISOString(), {}, `daily_digest:${today}`);
    }

    const nextRun = nextUtcHour(now, 8);
    const nextDate = isoDate(nextRun);
    await this.enqueueJob('daily_digest', nextRun.toISOString(), {}, `daily_digest:${nextDate}`);
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
        .one() as Record<string, unknown> | null;
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
    const nowIso = new Date().toISOString();
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
    } catch (error) {
      const nextRetry = job.retry_count + 1;
      if (nextRetry > MAX_JOB_RETRIES) {
        this.ctx.storage.sql.exec(
          'UPDATE jobs SET status = ?, retry_count = ?, updated_at = ? WHERE id = ?',
          JOB_STATUS_FAILED,
          nextRetry,
          new Date().toISOString(),
          job.id,
        );
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
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) {
      throw new Error('owner_user_not_initialized');
    }

    const now = new Date();
    const dateKey = isoDate(now);
    const hasTodayArticle = this.ctx.storage.sql
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
      .one();

    if (hasTodayArticle) return;

    const recentEvents = this.getLatestEvents(80);
    const eventSummary = summarizeEvents(recentEvents);
    const llmStatus = getLlmStatus(this.env);

    let markdown = buildFallbackDailyDigestMarkdown(dateKey, eventSummary);
    if (llmStatus.enabled) {
      try {
        const llmResult = await generateWithLlm(this.env, {
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
        console.error('daily_digest_llm_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const title = `日报 ${dateKey}`;
    const summary = `今日事件 ${recentEvents.length} 条，重点资产 ${eventSummary.topAssets.slice(0, 3).join(', ') || '暂无'}。`;
    const articleId = crypto.randomUUID();
    const createdAt = now.toISOString();

    this.ctx.storage.sql.exec(
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
      `inline://articles/${ownerUserId}/${dateKey}-daily.md`,
      JSON.stringify(['daily', 'personalized']),
      createdAt,
      'ready',
    );

    this.ctx.storage.sql.exec(
      'INSERT INTO article_contents (article_id, markdown) VALUES (?, ?)',
      articleId,
      markdown,
    );
  }

  private async refreshRecommendations(_payload: Record<string, unknown>): Promise<void> {
    const now = new Date();
    const dateKey = isoDate(now);
    const dayStart = `${dateKey}T00:00:00.000Z`;
    const dayEnd = `${tomorrowDate(dateKey)}T00:00:00.000Z`;

    const existingToday = this.ctx.storage.sql
      .exec(
        `SELECT id
         FROM recommendations
         WHERE generated_at >= ?
           AND generated_at < ?
         LIMIT 1`,
        dayStart,
        dayEnd,
      )
      .one();
    if (existingToday) return;

    const events = this.getLatestEvents(120);
    const assets = summarizeEvents(events).topAssets;
    const top = assets.slice(0, 3);
    const generatedAt = now.toISOString();
    const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    this.ctx.storage.sql.exec('DELETE FROM recommendations WHERE generated_at < ?', dayStart);

    const [tradeAsset, receiveAsset, sendAsset] = [
      top[0] ?? 'ETH',
      top[1] ?? top[0] ?? 'USDC',
      top[2] ?? top[0] ?? 'BNB',
    ];

    let rows: Array<{ category: string; asset: string; reason: string; score: number }> = buildFallbackRecommendations(
      tradeAsset,
      receiveAsset,
      sendAsset,
    );

    const llmStatus = getLlmStatus(this.env);
    if (llmStatus.enabled) {
      try {
        const llmResult = await generateWithLlm(this.env, {
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
                `Recent event counts: ${JSON.stringify(summarizeEvents(events).counts)}`,
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
        console.error('recommendation_llm_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const row of rows) {
      this.ctx.storage.sql.exec(
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

  private async generateTopicArticle(payload: Record<string, unknown>): Promise<void> {
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) {
      throw new Error('owner_user_not_initialized');
    }

    const requestedTopic = typeof payload.topic === 'string' ? payload.topic.trim() : '';
    const topic = requestedTopic || '市场热点追踪';
    const now = new Date();
    const dateKey = isoDate(now);
    const recentEvents = this.getLatestEvents(100);
    const eventSummary = summarizeEvents(recentEvents);
    const llmStatus = getLlmStatus(this.env);

    let markdown = buildFallbackTopicMarkdown(dateKey, topic, eventSummary);
    if (llmStatus.enabled) {
      try {
        const llmResult = await generateWithLlm(this.env, {
          messages: [
            {
              role: 'system',
              content:
                'You are a crypto strategy writer for wallet users. Write Chinese markdown with practical steps.',
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
        console.error('topic_generation_llm_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const articleId = crypto.randomUUID();
    const createdAt = now.toISOString();
    this.ctx.storage.sql.exec(
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
      `inline://articles/${ownerUserId}/${dateKey}-topic-${slugify(topic)}.md`,
      JSON.stringify(['topic', topic]),
      createdAt,
      'ready',
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO article_contents (article_id, markdown) VALUES (?, ?)',
      articleId,
      markdown,
    );
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
      .one() as Record<string, unknown> | null;

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

function normalizeSqlString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  return null;
}

function normalizeSqlNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sanitizeLimit(input: number, min: number, max: number): number {
  if (!Number.isFinite(input)) return min;
  const normalized = Math.floor(input);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function normalizeOccurredAt(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function tomorrowDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return isoDate(d);
}

function nextUtcHour(now: Date, hour: number): Date {
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function retryBackoffMs(retryCount: number): number {
  const base = 15_000;
  return base * Math.pow(2, retryCount - 1);
}

function isJobType(value: string): value is JobType {
  return new Set<JobType>(['daily_digest', 'recommendation_refresh', 'topic_generation', 'cleanup']).has(
    value as JobType,
  );
}

function isRecommendationTriggerEvent(eventType: string): boolean {
  return new Set([
    'asset_holding_snapshot',
    'asset_viewed',
    'asset_favorited',
    'trade_buy',
    'trade_sell',
  ]).has(eventType);
}

function summarizeEvents(events: EventRow[]): {
  counts: Record<string, number>;
  topAssets: string[];
} {
  const counts: Record<string, number> = {};
  const assetCounts: Record<string, number> = {};

  for (const event of events) {
    counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
    const payload = safeJsonParse<Record<string, unknown>>(event.payload_json) ?? {};
    const candidates = [payload.asset, payload.symbol, payload.token]
      .map((value) => (typeof value === 'string' ? value.trim().toUpperCase() : ''))
      .filter((value) => value.length >= 2 && value.length <= 16);
    for (const asset of candidates) {
      assetCounts[asset] = (assetCounts[asset] ?? 0) + 1;
    }
  }

  const topAssets = Object.entries(assetCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([asset]) => asset);

  return {
    counts,
    topAssets,
  };
}

function buildFallbackDailyDigestMarkdown(
  date: string,
  eventSummary: { counts: Record<string, number>; topAssets: string[] },
): string {
  const items = Object.entries(eventSummary.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => `- ${key}: ${count}`)
    .join('\n');

  const assets = eventSummary.topAssets.length ? eventSummary.topAssets.join(' / ') : '暂无明显偏好资产';

  return [
    `# 每日专属日报 ${date}`,
    '',
    '## 今日摘要',
    items || '- 今日暂无关键行为变化',
    '',
    '## 关注资产',
    `- ${assets}`,
    '',
    '## 可执行动作',
    '- 检查高频关注资产的波动与流动性。',
    '- 若计划转账，优先确认链与资产网络一致。',
    '- 若今日无交易计划，可先设置价格提醒。',
  ].join('\n');
}

function buildFallbackTopicMarkdown(
  date: string,
  topic: string,
  eventSummary: { counts: Record<string, number>; topAssets: string[] },
): string {
  const topAssets = eventSummary.topAssets.slice(0, 5).join(' / ') || '暂无';
  const majorEvents = Object.entries(eventSummary.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => `- ${name}: ${count}`)
    .join('\n');

  return [
    `# ${topic}（${date}）`,
    '',
    '## 核心观点',
    `- 当前用户行为集中在：${topAssets}。`,
    '',
    '## 机会与风险',
    majorEvents || '- 今日无显著新增行为数据。',
    '- 机会：围绕高频关注资产进行分批策略。',
    '- 风险：跨链与网络选择错误造成资金损耗。',
    '',
    '## 用户可执行动作',
    '- 在交易前先确认链、资产、滑点和手续费。',
    '- 对高波动资产设置分层价格提醒与仓位上限。',
  ].join('\n');
}

function buildFallbackRecommendations(
  tradeAsset: string,
  receiveAsset: string,
  sendAsset: string,
): Array<{ category: string; asset: string; reason: string; score: number }> {
  return [
    {
      category: 'trade',
      asset: tradeAsset,
      reason: `${tradeAsset} 在你的近期行为中关注度最高，适合优先交易观察。`,
      score: 0.82,
    },
    {
      category: 'receive',
      asset: receiveAsset,
      reason: `${receiveAsset} 作为接收资产可提升后续资金归集效率。`,
      score: 0.75,
    },
    {
      category: 'send',
      asset: sendAsset,
      reason: `${sendAsset} 在你常用链路中流动性较好，适合作为发送资产。`,
      score: 0.7,
    },
  ];
}

function parseLlmRecommendations(text: string): Array<{ category: string; asset: string; reason: string; score: number }> {
  const cleaned = extractJsonArray(text);
  if (!cleaned) return [];
  const parsed = safeJsonParse<unknown[]>(cleaned);
  if (!parsed || !Array.isArray(parsed)) return [];

  const normalized = parsed
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null;
      const row = item as Record<string, unknown>;
      const category = typeof row.category === 'string' ? row.category.trim() : '';
      const asset = typeof row.asset === 'string' ? row.asset.trim().toUpperCase() : '';
      const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
      const score = typeof row.score === 'number' ? row.score : Number(row.score ?? 0);
      if (!['trade', 'receive', 'send'].includes(category)) return null;
      if (!asset || !reason || !Number.isFinite(score)) return null;
      return {
        category,
        asset,
        reason,
        score: Math.max(0, Math.min(1, score)),
      };
    })
    .filter((item): item is { category: string; asset: string; reason: string; score: number } => Boolean(item));

  const byCategory = new Map<string, { category: string; asset: string; reason: string; score: number }>();
  for (const item of normalized) {
    if (!byCategory.has(item.category)) {
      byCategory.set(item.category, item);
    }
  }
  return ['trade', 'receive', 'send']
    .map((category) => byCategory.get(category))
    .filter((item): item is { category: string; asset: string; reason: string; score: number } => Boolean(item));
}

function extractJsonArray(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
