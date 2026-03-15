import { DurableObject } from 'cloudflare:workers';
import {
  fetchTopicSpecialSourcePacket,
  generateTopicSpecialBatchFromSourcePacket,
  generateTopicSpecialPreviewFromSourcePacket,
  getTopicSpecialSlotKey,
  persistTopicSpecialArticle,
  probeTopicSpecialDraftsFromSourcePacket,
  type TopicSpecialDebugOptions,
  type TopicSpecialDraftProbeResult,
  type TopicSpecialGenerationResult,
  type TopicSpecialPersistInput,
  type TopicSpecialPreviewResult,
  type TopicSpecialSourcePacket,
} from '../services/topicSpecials';
import type { Bindings } from '../types';
import type { TopicSpecialOpsOverview } from '../services/topicSpecialCoordinator';

const JOB_STATUS_QUEUED = 'queued';
const JOB_STATUS_STAGED = 'staged';
const JOB_STATUS_RUNNING = 'running';
const JOB_STATUS_SUCCEEDED = 'succeeded';
const JOB_STATUS_FAILED = 'failed';
const MAX_JOB_RETRIES = 3;
const JOB_STORAGE_PREFIX = 'topic-special-job:';
const STAGE_STORAGE_PREFIX = 'topic-special-stage:';

type TopicSpecialJobStatus =
  | typeof JOB_STATUS_QUEUED
  | typeof JOB_STATUS_STAGED
  | typeof JOB_STATUS_RUNNING
  | typeof JOB_STATUS_SUCCEEDED
  | typeof JOB_STATUS_FAILED;

type TopicSpecialJobRecord = {
  id: string;
  slotKey: string;
  force: boolean;
  trigger: string;
  status: TopicSpecialJobStatus;
  retryCount: number;
  runAt: string;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export class TopicSpecialSqliteDO extends DurableObject<Bindings> {
  async enqueueGenerationRpc(input?: {
    force?: boolean;
    slotKey?: string;
    trigger?: string;
  }): Promise<{
    jobId: string;
    deduped: boolean;
    slotKey: string;
    status: 'queued' | 'staged' | 'running' | 'succeeded' | 'failed';
  }> {
    const slotKey = normalizeSlotKey(input?.slotKey) ?? getTopicSpecialSlotKey(new Date());
    const force = input?.force === true;
    const trigger = normalizeTrigger(input?.trigger);
    const activeJob = await this.findLatestActiveJobForSlot(slotKey);

    if (activeJob) {
      return {
        jobId: activeJob.id,
        deduped: true,
        slotKey,
        status: activeJob.status,
      };
    }

    const nowIso = new Date().toISOString();
    const job: TopicSpecialJobRecord = {
      id: crypto.randomUUID(),
      slotKey,
      force,
      trigger,
      status: JOB_STATUS_QUEUED,
      retryCount: 0,
      runAt: nowIso,
      resultJson: null,
      errorMessage: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      startedAt: null,
      completedAt: null,
    };
    await this.putJob(job);
    await this.scheduleNextAlarm();
    return {
      jobId: job.id,
      deduped: false,
      slotKey,
      status: job.status,
    };
  }

  async persistTopicSpecialArticleRpc(input: TopicSpecialPersistInput): Promise<void> {
    await persistTopicSpecialArticle(this.env, input);
  }

  async generatePreviewRpc(input: {
    packet: TopicSpecialSourcePacket;
    options?: { force?: boolean; slotKey?: string } & TopicSpecialDebugOptions;
  }): Promise<TopicSpecialPreviewResult> {
    return generateTopicSpecialPreviewFromSourcePacket(this.env, input.packet, input.options);
  }

  async probeTopicDraftsRpc(input: {
    packet: TopicSpecialSourcePacket;
    options?: { slotKey?: string } & TopicSpecialDebugOptions;
  }): Promise<TopicSpecialDraftProbeResult> {
    return probeTopicSpecialDraftsFromSourcePacket(this.env, input.packet, input.options);
  }

  async runBatchFromPacketRpc(input: {
    packet: TopicSpecialSourcePacket;
    options?: { force?: boolean };
  }): Promise<TopicSpecialGenerationResult> {
    return generateTopicSpecialBatchFromSourcePacket(this.env, input.packet, input.options);
  }

  async getOpsDashboardRpc(input?: { limit?: number }): Promise<TopicSpecialOpsOverview> {
    const jobs = await this.listJobs();
    const limit = clampOpsLimit(input?.limit);
    const counts = {
      queued: 0,
      staged: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };

    for (const job of jobs) {
      if (job.status === JOB_STATUS_QUEUED) counts.queued += 1;
      if (job.status === JOB_STATUS_STAGED) counts.staged += 1;
      if (job.status === JOB_STATUS_RUNNING) counts.running += 1;
      if (job.status === JOB_STATUS_SUCCEEDED) counts.succeeded += 1;
      if (job.status === JOB_STATUS_FAILED) counts.failed += 1;
    }

    const activeSlotKeys = Array.from(
      new Set(
        jobs
          .filter((job) =>
            job.status === JOB_STATUS_QUEUED || job.status === JOB_STATUS_STAGED || job.status === JOB_STATUS_RUNNING)
          .map((job) => job.slotKey),
      ),
    ).sort((a, b) => b.localeCompare(a));

    const recentJobs = jobs
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((job) => ({
        id: job.id,
        slotKey: job.slotKey,
        force: job.force,
        trigger: job.trigger,
        status: job.status,
        retryCount: job.retryCount,
        runAt: job.runAt,
        result: parseJobResult(job.resultJson),
        errorMessage: job.errorMessage,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      }));

    return {
      generatedAt: new Date().toISOString(),
      counts,
      activeSlotKeys,
      recentJobs,
    };
  }

  async alarm(): Promise<void> {
    const job = await this.getNextDueJob();
    if (!job) {
      await this.scheduleNextAlarm();
      return;
    }

    try {
      if (job.status === JOB_STATUS_STAGED) {
        await this.runStagedJob(job);
      } else {
        await this.stageJob(job);
      }
    } catch (error) {
      await this.failJob(job, error, job.status === JOB_STATUS_STAGED ? JOB_STATUS_STAGED : JOB_STATUS_QUEUED);
    }

    await this.scheduleNextAlarm();
  }

  private async listJobs(): Promise<TopicSpecialJobRecord[]> {
    const entries = await this.ctx.storage.list<TopicSpecialJobRecord>({
      prefix: JOB_STORAGE_PREFIX,
    });
    return Array.from(entries.values());
  }

  private async findLatestActiveJobForSlot(slotKey: string): Promise<TopicSpecialJobRecord | null> {
    const jobs = await this.listJobs();
    return jobs
      .filter((job) =>
        job.slotKey === slotKey
        && (job.status === JOB_STATUS_QUEUED || job.status === JOB_STATUS_STAGED || job.status === JOB_STATUS_RUNNING))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  private async getNextDueJob(): Promise<TopicSpecialJobRecord | null> {
    const nowIso = new Date().toISOString();
    const jobs = await this.listJobs();
    return jobs
      .filter((job) =>
        (job.status === JOB_STATUS_QUEUED || job.status === JOB_STATUS_STAGED)
        && job.runAt <= nowIso)
      .sort((a, b) => a.runAt.localeCompare(b.runAt) || a.createdAt.localeCompare(b.createdAt))[0] ?? null;
  }

  private async putJob(job: TopicSpecialJobRecord): Promise<void> {
    await this.ctx.storage.put(jobStorageKey(job.id), job);
  }

  private async deleteStage(jobId: string): Promise<void> {
    await this.ctx.storage.delete(stageStorageKey(jobId));
  }

  private async completeJob(job: TopicSpecialJobRecord, result: TopicSpecialGenerationResult): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.putJob({
      ...job,
      status: JOB_STATUS_SUCCEEDED,
      resultJson: JSON.stringify(result),
      errorMessage: null,
      updatedAt: completedAt,
      completedAt,
    });
    await this.deleteStage(job.id);
    console.log('topic_special_job_succeeded', {
      jobId: job.id,
      slotKey: result.slotKey,
      generated: result.generated,
      skipped: result.skipped,
      totalInSlot: result.totalInSlot,
    });
  }

  private async failJob(
    job: TopicSpecialJobRecord,
    error: unknown,
    retryStatus: typeof JOB_STATUS_QUEUED | typeof JOB_STATUS_STAGED,
  ): Promise<void> {
    const retryCount = job.retryCount + 1;
    const message = error instanceof Error ? error.message : String(error);

    if (retryCount > MAX_JOB_RETRIES) {
      const failedAt = new Date().toISOString();
      await this.putJob({
        ...job,
        status: JOB_STATUS_FAILED,
        retryCount,
        errorMessage: message,
        updatedAt: failedAt,
        completedAt: failedAt,
      });
      await this.deleteStage(job.id);
      console.error('topic_special_job_failed', {
        jobId: job.id,
        slotKey: job.slotKey,
        retryCount,
        finalFailed: true,
        error: message,
      });
      return;
    }

    const nextRunAt = new Date(Date.now() + retryBackoffMs(retryCount)).toISOString();
    await this.putJob({
      ...job,
      status: retryStatus,
      retryCount,
      runAt: nextRunAt,
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    });
    console.error('topic_special_job_failed', {
      jobId: job.id,
      slotKey: job.slotKey,
      retryCount,
      finalFailed: false,
      nextRunAt,
      error: message,
    });
  }

  private async stageJob(job: TopicSpecialJobRecord): Promise<void> {
    console.log('topic_special_job_stage_started', {
      jobId: job.id,
      slotKey: job.slotKey,
      force: job.force,
      trigger: job.trigger,
      retryCount: job.retryCount,
    });

    const packet = await fetchTopicSpecialSourcePacket(this.env, {
      slotKey: job.slotKey,
    });
    await this.ctx.storage.put(stageStorageKey(job.id), packet);

    const stagedAt = new Date().toISOString();
    await this.putJob({
      ...job,
      status: JOB_STATUS_STAGED,
      runAt: stagedAt,
      resultJson: JSON.stringify({
        stage: 'sources_loaded',
        sourceRefCount: packet.sourceRefs.length,
        defaultAssetCount: packet.defaultAssets.length,
        newsCount: packet.newsItems.length,
        twitterCount: packet.twitterItems.length,
        rssHeadlineCount: packet.rssHeadlines.length,
        marketAssetCount: packet.marketAssets.length,
        memeHeatCount: packet.memeHeatItems.length,
        perpCount: packet.perps.length,
        predictionCount: packet.predictions.length,
      }),
      errorMessage: null,
      updatedAt: stagedAt,
    });

    console.log('topic_special_job_stage_completed', {
      jobId: job.id,
      slotKey: job.slotKey,
      sourceRefCount: packet.sourceRefs.length,
      defaultAssetCount: packet.defaultAssets.length,
      newsCount: packet.newsItems.length,
      twitterCount: packet.twitterItems.length,
      rssHeadlineCount: packet.rssHeadlines.length,
      marketAssetCount: packet.marketAssets.length,
      memeHeatCount: packet.memeHeatItems.length,
      perpCount: packet.perps.length,
      predictionCount: packet.predictions.length,
    });
  }

  private async runStagedJob(job: TopicSpecialJobRecord): Promise<void> {
    const packet = await this.ctx.storage.get<TopicSpecialSourcePacket>(stageStorageKey(job.id));
    if (!packet) {
      throw new Error('topic_special_stage_packet_missing');
    }

    const startedAt = new Date().toISOString();
    const runningJob: TopicSpecialJobRecord = {
      ...job,
      status: JOB_STATUS_RUNNING,
      updatedAt: startedAt,
      startedAt,
      errorMessage: null,
    };
    await this.putJob(runningJob);

    console.log('topic_special_job_started', {
      jobId: job.id,
      slotKey: job.slotKey,
      force: job.force,
      trigger: job.trigger,
      retryCount: job.retryCount,
      stagedSourceRefCount: packet.sourceRefs.length,
      stagedDefaultAssetCount: packet.defaultAssets.length,
    });

    const result = await generateTopicSpecialBatchFromSourcePacket(this.env, packet, {
      force: job.force,
    });
    await this.completeJob(runningJob, result);
  }

  private async scheduleNextAlarm(): Promise<void> {
    const jobs = await this.listJobs();
    const nextJob = jobs
      .filter((job) => job.status === JOB_STATUS_QUEUED || job.status === JOB_STATUS_STAGED)
      .sort((a, b) => a.runAt.localeCompare(b.runAt))[0];

    if (!nextJob) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const nextTs = Date.parse(nextJob.runAt);
    if (!Number.isFinite(nextTs)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextTs);
  }
}

export { TopicSpecialSqliteDO as TopicSpecialDO };

function jobStorageKey(jobId: string): string {
  return `${JOB_STORAGE_PREFIX}${jobId}`;
}

function stageStorageKey(jobId: string): string {
  return `${STAGE_STORAGE_PREFIX}${jobId}`;
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

function retryBackoffMs(retryCount: number): number {
  if (retryCount <= 1) return 30_000;
  if (retryCount === 2) return 2 * 60_000;
  return 5 * 60_000;
}

function parseJobResult(value: string | null): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function clampOpsLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 12;
  return Math.max(1, Math.min(30, Math.trunc(value as number)));
}
