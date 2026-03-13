import { safeJsonParse } from '../utils/json';
import { normalizeSqlString, retryBackoffMs } from './userAgentHelpers';
import type { JobRow, JobType } from './userAgentTypes';

export const JOB_STATUS_QUEUED = 'queued';
export const JOB_STATUS_RUNNING = 'running';
export const JOB_STATUS_SUCCEEDED = 'succeeded';
export const JOB_STATUS_FAILED = 'failed';
const MAX_JOB_RETRIES = 3;

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => { toArray(): unknown[] };
};

type AlarmStorage = {
  setAlarm: (scheduledTime: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
};

export async function runDueJobs(params: {
  sql: SqlStorage;
  alarmStorage: AlarmStorage;
  executeJob: (jobType: JobType, payload: Record<string, unknown>) => Promise<void>;
}): Promise<void> {
  const now = new Date();
  const dueJobs = params.sql
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
       LIMIT 1`,
      JOB_STATUS_QUEUED,
      now.toISOString(),
    )
    .toArray() as JobRow[];

  for (const job of dueJobs) {
    await runSingleJob({
      sql: params.sql,
      executeJob: params.executeJob,
      job,
    });
  }

  await scheduleNextAlarm({
    sql: params.sql,
    alarmStorage: params.alarmStorage,
  });
}

export async function enqueueJob(params: {
  sql: SqlStorage;
  alarmStorage: AlarmStorage;
  jobType: JobType;
  runAtIso: string;
  payload: Record<string, unknown>;
  jobKey: string | null;
}): Promise<{ jobId: string; deduped: boolean }> {
  const normalizedJobKey = params.jobKey?.trim() || null;
  if (normalizedJobKey) {
    const existing = params.sql
      .exec('SELECT id FROM jobs WHERE job_key = ? LIMIT 1', normalizedJobKey)
      .toArray()[0] as Record<string, unknown> | undefined;
    const existingId = normalizeSqlString(existing?.id);
    if (existingId) {
      return { jobId: existingId, deduped: true };
    }
  }

  const jobId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  params.sql.exec(
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
    params.jobType,
    params.runAtIso,
    JOB_STATUS_QUEUED,
    JSON.stringify(params.payload),
    0,
    normalizedJobKey,
    nowIso,
    nowIso,
  );

  await scheduleNextAlarm({
    sql: params.sql,
    alarmStorage: params.alarmStorage,
  });
  return { jobId, deduped: false };
}

async function runSingleJob(params: {
  sql: SqlStorage;
  executeJob: (jobType: JobType, payload: Record<string, unknown>) => Promise<void>;
  job: JobRow;
}): Promise<void> {
  const startedAtMs = Date.now();
  const nowIso = new Date().toISOString();
  console.log('user_agent_job_started', {
    jobId: params.job.id,
    jobType: params.job.job_type,
    runAt: params.job.run_at,
    retryCount: params.job.retry_count,
  });
  params.sql.exec('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?', JOB_STATUS_RUNNING, nowIso, params.job.id);

  try {
    const payload = safeJsonParse<Record<string, unknown>>(params.job.payload_json) ?? {};
    await params.executeJob(params.job.job_type, payload);
    params.sql.exec(
      'UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?',
      JOB_STATUS_SUCCEEDED,
      new Date().toISOString(),
      params.job.id,
    );
    console.log('user_agent_job_succeeded', {
      jobId: params.job.id,
      jobType: params.job.job_type,
      durationMs: Date.now() - startedAtMs,
    });
  } catch (error) {
    const nextRetry = params.job.retry_count + 1;
    const durationMs = Date.now() - startedAtMs;
    if (nextRetry > MAX_JOB_RETRIES) {
      params.sql.exec(
        'UPDATE jobs SET status = ?, retry_count = ?, updated_at = ? WHERE id = ?',
        JOB_STATUS_FAILED,
        nextRetry,
        new Date().toISOString(),
        params.job.id,
      );
      console.error('user_agent_job_failed', {
        jobId: params.job.id,
        jobType: params.job.job_type,
        retryCount: nextRetry,
        durationMs,
        finalFailed: true,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const nextRun = new Date(Date.now() + retryBackoffMs(nextRetry)).toISOString();
    params.sql.exec(
      'UPDATE jobs SET status = ?, retry_count = ?, run_at = ?, updated_at = ? WHERE id = ?',
      JOB_STATUS_QUEUED,
      nextRetry,
      nextRun,
      new Date().toISOString(),
      params.job.id,
    );
    console.error('user_agent_job_failed', {
      jobId: params.job.id,
      jobType: params.job.job_type,
      retryCount: nextRetry,
      durationMs,
      finalFailed: false,
      nextRun,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function scheduleNextAlarm(params: { sql: SqlStorage; alarmStorage: AlarmStorage }): Promise<void> {
  const nextRow = params.sql
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
    await params.alarmStorage.deleteAlarm();
    return;
  }

  const nextTs = Date.parse(runAtIso);
  if (!Number.isFinite(nextTs)) {
    await params.alarmStorage.deleteAlarm();
    return;
  }

  await params.alarmStorage.setAlarm(nextTs);
}
