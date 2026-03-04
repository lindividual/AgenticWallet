CREATE TABLE IF NOT EXISTS aggregated_asset_catalog (
  asset_id TEXT PRIMARY KEY,
  coingecko_coin_id TEXT,
  symbol TEXT,
  name TEXT,
  logo_uri TEXT,
  platforms_json TEXT,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aggregated_asset_catalog_coin_id
  ON aggregated_asset_catalog(coingecko_coin_id);

CREATE INDEX IF NOT EXISTS idx_aggregated_asset_catalog_updated_at
  ON aggregated_asset_catalog(updated_at DESC);
