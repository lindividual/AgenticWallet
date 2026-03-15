import {
  fetchTopicSpecialSourcePacket,
  type TopicSpecialDebugOptions,
  type TopicSpecialDraftProbeResult,
  type TopicSpecialGenerationResult,
  type TopicSpecialPreviewResult,
  type TopicSpecialSourcePacket,
} from './topicSpecials';
import type { Bindings } from '../types';

export type TopicSpecialEnqueueResult = {
  jobId: string;
  deduped: boolean;
  slotKey: string;
  status: 'queued' | 'staged' | 'running' | 'succeeded' | 'failed';
};

export type TopicSpecialOpsJob = {
  id: string;
  slotKey: string;
  force: boolean;
  trigger: string;
  status: 'queued' | 'staged' | 'running' | 'succeeded' | 'failed';
  retryCount: number;
  runAt: string;
  result: unknown | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type TopicSpecialOpsOverview = {
  generatedAt: string;
  counts: {
    queued: number;
    staged: number;
    running: number;
    succeeded: number;
    failed: number;
  };
  activeSlotKeys: string[];
  recentJobs: TopicSpecialOpsJob[];
};

type TopicSpecialRpcStub = DurableObjectStub & {
  enqueueGenerationRpc(input?: {
    force?: boolean;
    slotKey?: string;
    trigger?: string;
  }): Promise<TopicSpecialEnqueueResult>;
  generatePreviewRpc(input: {
    packet: TopicSpecialSourcePacket;
    options?: { force?: boolean; slotKey?: string } & TopicSpecialDebugOptions;
  }): Promise<TopicSpecialPreviewResult>;
  probeTopicDraftsRpc(input: {
    packet: TopicSpecialSourcePacket;
    options?: { slotKey?: string } & TopicSpecialDebugOptions;
  }): Promise<TopicSpecialDraftProbeResult>;
  runBatchFromPacketRpc(input: {
    packet: TopicSpecialSourcePacket;
    options?: { force?: boolean };
  }): Promise<TopicSpecialGenerationResult>;
  getOpsDashboardRpc(input?: { limit?: number }): Promise<TopicSpecialOpsOverview>;
};

function getTopicSpecialStub(env: Bindings): TopicSpecialRpcStub {
  const id = env.TOPIC_SPECIAL.idFromName('global');
  return env.TOPIC_SPECIAL.get(id) as TopicSpecialRpcStub;
}

export async function enqueueTopicSpecialGeneration(
  env: Bindings,
  input?: {
    force?: boolean;
    slotKey?: string;
    trigger?: string;
  },
): Promise<TopicSpecialEnqueueResult> {
  const stub = getTopicSpecialStub(env);
  return stub.enqueueGenerationRpc(input);
}

export async function generateTopicSpecialPreviewViaDo(
  env: Bindings,
  input?: { force?: boolean; slotKey?: string } & TopicSpecialDebugOptions,
): Promise<TopicSpecialPreviewResult> {
  const stub = getTopicSpecialStub(env);
  const packet = await fetchTopicSpecialSourcePacket(env, {
    slotKey: input?.slotKey,
  });
  return stub.generatePreviewRpc({
    packet,
    options: input,
  });
}

export async function probeTopicSpecialDraftsViaDo(
  env: Bindings,
  input?: { slotKey?: string } & TopicSpecialDebugOptions,
): Promise<TopicSpecialDraftProbeResult> {
  const stub = getTopicSpecialStub(env);
  const packet = await fetchTopicSpecialSourcePacket(env, {
    slotKey: input?.slotKey,
  });
  return stub.probeTopicDraftsRpc({
    packet,
    options: input,
  });
}

export async function runTopicSpecialBatchViaDo(
  env: Bindings,
  input?: { force?: boolean; slotKey?: string },
): Promise<TopicSpecialGenerationResult> {
  const stub = getTopicSpecialStub(env);
  const packet = await fetchTopicSpecialSourcePacket(env, {
    slotKey: input?.slotKey,
  });
  return stub.runBatchFromPacketRpc({
    packet,
    options: {
      force: input?.force === true,
    },
  });
}

export async function getTopicSpecialOpsOverview(
  env: Bindings,
  input?: { limit?: number },
): Promise<TopicSpecialOpsOverview> {
  const stub = getTopicSpecialStub(env);
  return stub.getOpsDashboardRpc(input);
}
