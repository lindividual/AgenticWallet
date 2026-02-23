import { DurableObject } from 'cloudflare:workers';
import type { AgentEventRecord } from '../agent/events';
import type { Bindings } from '../types';

const OWNER_KEY = 'owner_user_id';

type EventRow = {
  id: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  payload_json: string;
  dedupe_key: string | null;
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
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
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
    if (request.method === 'POST' && url.pathname === '/events') {
      const body = (await request.json()) as AgentEventRecord;
      return Response.json(await this.ingestEvent(body));
    }

    if (request.method === 'GET' && url.pathname === '/events/latest') {
      return Response.json({ events: this.getLatestEvents() });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'not_found' }, { status: 404 });
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
        limit,
      )
      .toArray() as EventRow[];
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
