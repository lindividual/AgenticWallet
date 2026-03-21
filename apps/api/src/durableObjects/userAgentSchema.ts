type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => { toArray(): unknown[] };
};

function ensureColumn(sql: SqlStorage, table: string, column: string, definition: string): void {
  try {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('duplicate column')) {
      throw error;
    }
  }
}

export function initializeAgentSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS agent_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS wallet (
      address TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      encrypted_private_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS wallet_chain_accounts (
      network_key TEXT PRIMARY KEY,
      chain_id INTEGER,
      protocol TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS wallet_protocol_keys (
      protocol TEXT PRIMARY KEY,
      encrypted_key_material TEXT NOT NULL,
      key_format TEXT NOT NULL,
      created_at TEXT NOT NULL,
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
      result_json TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      job_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  ensureColumn(sql, 'jobs', 'result_json', 'TEXT');
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
    `CREATE TABLE IF NOT EXISTS user_topic_feed (
      article_id TEXT PRIMARY KEY,
      feed_rank INTEGER NOT NULL,
      delivered_at TEXT NOT NULL,
      generated_at TEXT NOT NULL
    )`,
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_user_topic_feed_rank ON user_topic_feed(feed_rank ASC)',
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_user_topic_feed_generated_at ON user_topic_feed(generated_at DESC)',
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      asset_name TEXT NOT NULL,
      asset_symbol TEXT,
      asset_chain TEXT,
      asset_contract TEXT,
      asset_display_name TEXT,
      asset_image TEXT,
      asset_price_change_24h REAL,
      reason TEXT NOT NULL,
      score REAL NOT NULL,
      generated_at TEXT NOT NULL,
      valid_until TEXT
    )`,
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS trade_shelf_state (
      id TEXT PRIMARY KEY,
      dirty INTEGER NOT NULL DEFAULT 1,
      last_refreshed_at TEXT,
      generated_at TEXT,
      updated_at TEXT NOT NULL
    )`,
  );

  sql.exec(
    `CREATE TABLE IF NOT EXISTS trade_shelf_items (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL,
      section_title TEXT NOT NULL,
      item_rank INTEGER NOT NULL,
      item_kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      title TEXT NOT NULL,
      image TEXT,
      chain TEXT,
      contract TEXT,
      current_price REAL,
      change_24h REAL,
      probability REAL,
      volume_24h REAL,
      reason_tag TEXT NOT NULL,
      score REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_shelf_items_section_rank ON trade_shelf_items(section_id, item_rank ASC)',
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_trade_shelf_items_updated_at ON trade_shelf_items(updated_at DESC)',
  );

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
      network_key TEXT NOT NULL,
      chain_id INTEGER,
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
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_user_watchlist_assets_updated_at ON user_watchlist_assets(updated_at DESC)',
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_user_watchlist_assets_type_updated_at ON user_watchlist_assets(watch_type, updated_at DESC)',
  );
}
