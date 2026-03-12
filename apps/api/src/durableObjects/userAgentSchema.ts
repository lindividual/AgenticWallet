type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => { toArray(): unknown[] };
};

type SqlTableInfoRow = {
  name?: string;
};

function tableHasColumn(sql: SqlStorage, table: string, column: string): boolean {
  try {
    const rows = sql.exec(`PRAGMA table_info(${table})`).toArray() as SqlTableInfoRow[];
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

function migrateLegacyUserEvents(sql: SqlStorage): void {
  if (!tableHasColumn(sql, 'user_events', 'user_id')) return;

  sql.exec('ALTER TABLE user_events RENAME TO user_events_legacy_v1');
  sql.exec(
    `CREATE TABLE user_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      dedupe_key TEXT,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL
    )`,
  );
  sql.exec(
    `INSERT INTO user_events (id, event_type, payload_json, dedupe_key, occurred_at, received_at)
     SELECT id, event_type, payload_json, dedupe_key, occurred_at, received_at
     FROM user_events_legacy_v1`,
  );
  sql.exec('DROP TABLE user_events_legacy_v1');
}

function migrateLegacyTransfers(sql: SqlStorage): void {
  if (!tableHasColumn(sql, 'transfers', 'user_id')) return;

  sql.exec('ALTER TABLE transfers RENAME TO transfers_legacy_v1');
  sql.exec(
    `CREATE TABLE transfers (
      id TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      token_address TEXT,
      token_symbol TEXT,
      token_decimals INTEGER NOT NULL DEFAULT 18,
      amount_input TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      tx_value TEXT NOT NULL,
      tx_hash TEXT,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      confirmed_at TEXT
    )`,
  );
  sql.exec(
    `INSERT INTO transfers (
      id,
      chain_id,
      from_address,
      to_address,
      token_address,
      token_symbol,
      token_decimals,
      amount_input,
      amount_raw,
      tx_value,
      tx_hash,
      status,
      error_code,
      error_message,
      idempotency_key,
      created_at,
      updated_at,
      submitted_at,
      confirmed_at
    )
    SELECT
      id,
      chain_id,
      from_address,
      to_address,
      token_address,
      token_symbol,
      token_decimals,
      amount_input,
      amount_raw,
      tx_value,
      tx_hash,
      status,
      error_code,
      error_message,
      idempotency_key,
      created_at,
      updated_at,
      submitted_at,
      confirmed_at
    FROM transfers_legacy_v1`,
  );
  sql.exec('DROP TABLE transfers_legacy_v1');
}

function migrateLegacyWatchlist(sql: SqlStorage): void {
  if (!tableHasColumn(sql, 'user_watchlist_assets', 'user_id')) return;

  sql.exec('ALTER TABLE user_watchlist_assets RENAME TO user_watchlist_assets_legacy_v1');
  sql.exec(
    `CREATE TABLE user_watchlist_assets (
      id TEXT PRIMARY KEY,
      watch_type TEXT NOT NULL DEFAULT 'crypto',
      item_id TEXT,
      chain TEXT NOT NULL,
      contract TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      image TEXT,
      source TEXT,
      change_24h REAL,
      external_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(chain, contract)
    )`,
  );
  sql.exec(
    `INSERT OR REPLACE INTO user_watchlist_assets (
      id,
      watch_type,
      item_id,
      chain,
      contract,
      symbol,
      name,
      image,
      source,
      change_24h,
      external_url,
      created_at,
      updated_at
    )
    SELECT
      id,
      watch_type,
      item_id,
      chain,
      contract,
      symbol,
      name,
      image,
      source,
      change_24h,
      external_url,
      created_at,
      updated_at
    FROM user_watchlist_assets_legacy_v1
    ORDER BY updated_at ASC`,
  );
  sql.exec('DROP TABLE user_watchlist_assets_legacy_v1');
}

export function initializeAgentSchema(sql: SqlStorage): void {
  migrateLegacyUserEvents(sql);
  migrateLegacyTransfers(sql);
  migrateLegacyWatchlist(sql);

  sql.exec(
    `CREATE TABLE IF NOT EXISTS agent_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS user_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      dedupe_key TEXT,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL
    )`,
  );
  sql.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_events_dedupe_key ON user_events(dedupe_key) WHERE dedupe_key IS NOT NULL',
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_user_events_occurred_at ON user_events(occurred_at DESC)',
  );

  sql.exec(
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
    sql.exec('ALTER TABLE jobs ADD COLUMN job_key TEXT');
  } catch {
    // Column already exists on new tables; ignore on older instances.
  }
  sql.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_job_key ON jobs(job_key) WHERE job_key IS NOT NULL',
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, run_at)',
  );

  sql.exec(
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

  sql.exec(
    `CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      asset_name TEXT NOT NULL,
      asset_symbol TEXT,
      asset_chain TEXT,
      asset_contract TEXT,
      asset_instrument_id TEXT,
      asset_display_name TEXT,
      asset_image TEXT,
      asset_price_change_24h REAL,
      reason TEXT NOT NULL,
      score REAL NOT NULL,
      generated_at TEXT NOT NULL,
      valid_until TEXT
    )`,
  );
  try {
    sql.exec('ALTER TABLE recommendations ADD COLUMN asset_symbol TEXT');
  } catch {
    // Column already exists.
  }
  try {
    sql.exec('ALTER TABLE recommendations ADD COLUMN asset_chain TEXT');
  } catch {
    // Column already exists.
  }
  try {
    sql.exec('ALTER TABLE recommendations ADD COLUMN asset_contract TEXT');
  } catch {
    // Column already exists.
  }
  try {
    sql.exec('ALTER TABLE recommendations ADD COLUMN asset_instrument_id TEXT');
  } catch {
    // Column already exists.
  }
  try {
    sql.exec('ALTER TABLE recommendations ADD COLUMN asset_display_name TEXT');
  } catch {
    // Column already exists.
  }
  try {
    sql.exec('ALTER TABLE recommendations ADD COLUMN asset_image TEXT');
  } catch {
    // Column already exists.
  }
  try {
    sql.exec('ALTER TABLE recommendations ADD COLUMN asset_price_change_24h REAL');
  } catch {
    // Column already exists.
  }

  sql.exec(
    `CREATE TABLE IF NOT EXISTS portfolio_snapshots_hourly (
      bucket_hour_utc TEXT PRIMARY KEY,
      total_usd REAL NOT NULL,
      holdings_json TEXT NOT NULL,
      as_of TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS portfolio_snapshots_daily (
      bucket_date_utc TEXT PRIMARY KEY,
      total_usd REAL NOT NULL,
      as_of TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      token_address TEXT,
      token_symbol TEXT,
      token_decimals INTEGER NOT NULL DEFAULT 18,
      amount_input TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      tx_value TEXT NOT NULL,
      tx_hash TEXT,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      confirmed_at TEXT
    )`,
  );
  try {
    sql.exec('ALTER TABLE transfers ADD COLUMN idempotency_key TEXT');
  } catch {
    // Column already exists.
  }
  sql.exec('CREATE INDEX IF NOT EXISTS idx_transfers_created_at ON transfers(created_at DESC)');
  sql.exec('CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status, created_at DESC)');
  sql.exec('CREATE INDEX IF NOT EXISTS idx_transfers_tx_hash ON transfers(tx_hash)');
  sql.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_idempotency_key ON transfers(idempotency_key) WHERE idempotency_key IS NOT NULL',
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS user_watchlist_assets (
      id TEXT PRIMARY KEY,
      watch_type TEXT NOT NULL DEFAULT 'crypto',
      item_id TEXT,
      chain TEXT NOT NULL,
      contract TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      image TEXT,
      source TEXT,
      change_24h REAL,
      external_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(chain, contract)
    )`,
  );
  try {
    sql.exec('ALTER TABLE user_watchlist_assets ADD COLUMN watch_type TEXT NOT NULL DEFAULT \'crypto\'');
  } catch {
    // Column already exists.
  }
  try {
    sql.exec('ALTER TABLE user_watchlist_assets ADD COLUMN item_id TEXT');
  } catch {
    // Column already exists.
  }
  try {
    sql.exec('ALTER TABLE user_watchlist_assets ADD COLUMN change_24h REAL');
  } catch {
    // Column already exists.
  }
  try {
    sql.exec('ALTER TABLE user_watchlist_assets ADD COLUMN external_url TEXT');
  } catch {
    // Column already exists.
  }
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_user_watchlist_assets_updated_at ON user_watchlist_assets(updated_at DESC)',
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_user_watchlist_assets_type_updated_at ON user_watchlist_assets(watch_type, updated_at DESC)',
  );
}
