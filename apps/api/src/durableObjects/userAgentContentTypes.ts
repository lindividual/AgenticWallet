import type { Bindings } from '../types';
import type { EventRow } from './userAgentTypes';

export type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => { toArray(): unknown[] };
};

export type ContentDeps = {
  env: Bindings;
  sql: SqlStorage;
  getOwnerUserId: () => string | null;
  getPreferredLocale?: () => string | null;
  getLatestEvents: (limit?: number) => EventRow[];
};
