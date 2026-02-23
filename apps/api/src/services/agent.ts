import type { AgentEventRecord } from '../agent/events';
import type { Bindings } from '../types';

type AgentEventIngestResult = {
  ok: true;
  eventId: string;
  deduped: boolean;
  sequence: number;
};

export async function ingestUserAgentEvent(
  env: Bindings,
  userId: string,
  event: AgentEventRecord,
): Promise<AgentEventIngestResult> {
  const id = env.USER_AGENT.idFromName(userId);
  const stub = env.USER_AGENT.get(id);
  const response = await stub.fetch(
    new Request('https://user-agent.internal/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`user_agent_do_ingest_failed: ${response.status} ${body}`);
  }

  return response.json<AgentEventIngestResult>();
}
