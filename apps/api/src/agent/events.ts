import { nowIso } from '../utils/time';

export const AGENT_EVENT_TYPES = [
  'asset_holding_snapshot',
  'asset_viewed',
  'asset_favorited',
  'trade_buy',
  'trade_sell',
  'article_read',
  'article_favorited',
  'page_dwell',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export type AgentEventIngestRequest = {
  type: AgentEventType;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  occurredAt?: string;
};

export type AgentEventRecord = {
  eventId: string;
  userId: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  occurredAt: string;
  receivedAt: string;
};

const AGENT_EVENT_TYPE_SET = new Set<string>(AGENT_EVENT_TYPES);

export function isAgentEventType(input: unknown): input is AgentEventType {
  return typeof input === 'string' && AGENT_EVENT_TYPE_SET.has(input);
}

export function buildAgentEventRecord(userId: string, request: AgentEventIngestRequest): AgentEventRecord {
  return {
    eventId: crypto.randomUUID(),
    userId,
    type: request.type,
    payload: request.payload ?? {},
    dedupeKey: normalizeDedupeKey(request.dedupeKey),
    occurredAt: normalizeOccurredAt(request.occurredAt),
    receivedAt: nowIso(),
  };
}

function normalizeOccurredAt(value: string | undefined): string {
  if (!value) return nowIso();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? nowIso() : new Date(parsed).toISOString();
}

function normalizeDedupeKey(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}
