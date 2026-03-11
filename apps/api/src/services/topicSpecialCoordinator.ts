import type { Bindings } from '../types';

export type TopicSpecialEnqueueResult = {
  jobId: string;
  deduped: boolean;
  slotKey: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
};

type TopicSpecialRpcStub = DurableObjectStub & {
  enqueueGenerationRpc(input?: {
    force?: boolean;
    slotKey?: string;
    trigger?: string;
  }): Promise<TopicSpecialEnqueueResult>;
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
