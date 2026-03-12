CREATE TABLE IF NOT EXISTS market_shelf_cache (
  shelf_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_shelf_cache_expires_at ON market_shelf_cache(expires_at);
