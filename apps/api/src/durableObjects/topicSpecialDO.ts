import { DurableObject } from 'cloudflare:workers';
import { generateTopicSpecialBatch, getTopicSpecialSlotKey, type TopicSpecialGenerationResult } from '../services/topicSpecials';
import type { Bindings } from '../types';

const JOB_STATUS_QUEUED = 'queued';
const JOB_STATUS_RUNNING = 'running';
const JOB_STATUS_SUCCEEDED = 'succeeded';
const JOB_STATUS_FAILED = 'failed';
const MAX_JOB_RETRIES = 3;

type TopicSpecialJobRow = {
  id: string;
  slot_key: string;
  force: number;
  trigger: string;
  status: string;
  retry_count: number;
  run_at: string;
};

export class TopicSpecialDO extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  async enqueueGenerationRpc(input?: {
    force?: boolean;
    slotKey?: string;
    trigger?: string;
  }): Promise<{
    jobId: string;
    deduped: boolean;
    slotKey: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
  }> {
    const slotKey = normalizeSlotKey(input?.slotKey) ?? getTopicSpecialSlotKey(new Date());
    const force = input?.force === true;
    const trigger = normalizeTrigger(input?.trigger);
    const activeJob = this.ctx.storage.sql
      .exec(
        `SELECT id, status
         FROM topic_special_jobs
         WHERE slot_key = ?
           AND status IN (?, ?)
         ORDER BY created_at DESC
         LIMIT 1`,
        slotKey,
        JOB_STATUS_QUEUED,
        JOB_STATUS_RUNNING,
      )
      .toArray()[0] as { id?: string; status?: string } | undefined;

    if (typeof activeJob?.id === 'string' && isJobStatus(activeJob.status)) {
      return {
        jobId: activeJob.id,
        deduped: true,
        slotKey,
        status: activeJob.status,
      };
    }

    const jobId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO topic_special_jobs (
        id,
        slot_key,
        force,
        trigger,
        status,
        retry_count,
        run_at,
        result_json,
        error_message,
        created_at,
        updated_at,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      jobId,
      slotKey,
      force ? 1 : 0,
      trigger,
      JOB_STATUS_QUEUED,
      0,
      nowIso,
      null,
      null,
      nowIso,
      nowIso,
      null,
      null,
    );
    await this.scheduleNextAlarm();
    return {
      jobId,
      deduped: false,
      slotKey,
      status: JOB_STATUS_QUEUED,
    };
  }

  async alarm(): Promise<void> {
    const job = this.getNextDueJob();
    if (!job) {
      await this.scheduleNextAlarm();
      return;
    }

    const startedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE topic_special_jobs
       SET status = ?, updated_at = ?, started_at = ?, error_message = NULL
       WHERE id = ?`,
      JOB_STATUS_RUNNING,
      startedAt,
      startedAt,
      job.id,
    );
    console.log('topic_special_job_started', {
      jobId: job.id,
      slotKey: job.slot_key,
      force: job.force === 1,
      trigger: job.trigger,
      retryCount: job.retry_count,
    });

    try {
      const result = await generateTopicSpecialBatch(this.env, {
        force: job.force === 1,
        slotKey: job.slot_key,
      });
      this.completeJob(job.id, result);
    } catch (error) {
      this.failJob(job, error);
    }

    await this.scheduleNextAlarm();
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS topic_special_jobs (
        id TEXT PRIMARY KEY,
        slot_key TEXT NOT NULL,
        force INTEGER NOT NULL DEFAULT 0,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        run_at TEXT NOT NULL,
        result_json TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      )`,
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_topic_special_jobs_status_run_at ON topic_special_jobs(status, run_at)',
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_topic_special_jobs_slot_created_at ON topic_special_jobs(slot_key, created_at DESC)',
    );
  }

  private getNextDueJob(): TopicSpecialJobRow | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT
           id,
           slot_key,
           force,
           trigger,
           status,
           retry_count,
           run_at
         FROM topic_special_jobs
         WHERE status = ?
           AND run_at <= ?
         ORDER BY run_at ASC, created_at ASC
         LIMIT 1`,
        JOB_STATUS_QUEUED,
        new Date().toISOString(),
      )
      .toArray()[0] as TopicSpecialJobRow | undefined;
    return row ?? null;
  }

  private completeJob(jobId: string, result: TopicSpecialGenerationResult): void {
    const completedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE topic_special_jobs
       SET status = ?, result_json = ?, error_message = NULL, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      JOB_STATUS_SUCCEEDED,
      JSON.stringify(result),
      completedAt,
      completedAt,
      jobId,
    );
    console.log('topic_special_job_succeeded', {
      jobId,
      slotKey: result.slotKey,
      generated: result.generated,
      skipped: result.skipped,
      totalInSlot: result.totalInSlot,
    });
  }

  private failJob(job: TopicSpecialJobRow, error: unknown): void {
    const retryCount = job.retry_count + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (retryCount > MAX_JOB_RETRIES) {
      const failedAt = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `UPDATE topic_special_jobs
         SET status = ?, retry_count = ?, error_message = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
        JOB_STATUS_FAILED,
        retryCount,
        message,
        failedAt,
        failedAt,
        job.id,
      );
      console.error('topic_special_job_failed', {
        jobId: job.id,
        slotKey: job.slot_key,
        retryCount,
        finalFailed: true,
        error: message,
      });
      return;
    }

    const nextRunAt = new Date(Date.now() + retryBackoffMs(retryCount)).toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE topic_special_jobs
       SET status = ?, retry_count = ?, run_at = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
      JOB_STATUS_QUEUED,
      retryCount,
      nextRunAt,
      message,
      new Date().toISOString(),
      job.id,
    );
    console.error('topic_special_job_failed', {
      jobId: job.id,
      slotKey: job.slot_key,
      retryCount,
      finalFailed: false,
      nextRunAt,
      error: message,
    });
  }

  private async scheduleNextAlarm(): Promise<void> {
    const nextRow = this.ctx.storage.sql
      .exec(
        `SELECT run_at
         FROM topic_special_jobs
         WHERE status = ?
         ORDER BY run_at ASC
         LIMIT 1`,
        JOB_STATUS_QUEUED,
      )
      .toArray()[0] as { run_at?: string } | undefined;
    if (!nextRow?.run_at) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const nextTs = Date.parse(nextRow.run_at);
    if (!Number.isFinite(nextTs)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextTs);
  }
}

function normalizeSlotKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[2]);
  if (!Number.isFinite(hour) || hour < 0 || hour >= 24 || hour % 4 !== 0) return null;
  return value;
}

function normalizeTrigger(raw: string | undefined): string {
  const value = raw?.trim().toLowerCase() ?? '';
  return value || 'unknown';
}

function isJobStatus(value: unknown): value is 'queued' | 'running' | 'succeeded' | 'failed' {
  return value === JOB_STATUS_QUEUED || value === JOB_STATUS_RUNNING || value === JOB_STATUS_SUCCEEDED || value === JOB_STATUS_FAILED;
}

function retryBackoffMs(retryCount: number): number {
  if (retryCount <= 1) return 30_000;
  if (retryCount === 2) return 2 * 60_000;
  return 5 * 60_000;
}
