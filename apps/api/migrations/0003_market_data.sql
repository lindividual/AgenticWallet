CREATE TABLE IF NOT EXISTS token_catalog (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  decimals INTEGER,
  logo_uri TEXT,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, address)
);

CREATE INDEX IF NOT EXISTS idx_token_catalog_symbol ON token_catalog(symbol);
CREATE INDEX IF NOT EXISTS idx_token_catalog_updated_at ON token_catalog(updated_at DESC);
