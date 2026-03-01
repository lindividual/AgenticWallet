CREATE TABLE IF NOT EXISTS coingecko_coin_platforms (
  coin_id TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  platforms_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coingecko_coin_platforms_symbol
  ON coingecko_coin_platforms(symbol);

CREATE TABLE IF NOT EXISTS coingecko_coin_platform_sync_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  changed_rows INTEGER NOT NULL DEFAULT 0
);
