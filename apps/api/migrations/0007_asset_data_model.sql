CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY,
  asset_class TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  logo_uri TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'resolver',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_class ON assets(asset_class);
CREATE INDEX IF NOT EXISTS idx_assets_symbol ON assets(symbol);
CREATE INDEX IF NOT EXISTS idx_assets_updated_at ON assets(updated_at DESC);

CREATE TABLE IF NOT EXISTS instruments (
  instrument_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  market_type TEXT NOT NULL,
  venue TEXT,
  symbol TEXT,
  chain TEXT,
  contract_key TEXT,
  source TEXT NOT NULL DEFAULT 'resolver',
  source_item_id TEXT,
  metadata_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(asset_id)
);

CREATE INDEX IF NOT EXISTS idx_instruments_asset_id ON instruments(asset_id);
CREATE INDEX IF NOT EXISTS idx_instruments_market_type ON instruments(market_type);
CREATE INDEX IF NOT EXISTS idx_instruments_source_item_id ON instruments(source_item_id);
CREATE INDEX IF NOT EXISTS idx_instruments_chain_contract ON instruments(chain, contract_key);

CREATE TABLE IF NOT EXISTS instrument_refs (
  provider TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_key),
  FOREIGN KEY (instrument_id) REFERENCES instruments(instrument_id)
);

CREATE INDEX IF NOT EXISTS idx_instrument_refs_instrument_id ON instrument_refs(instrument_id);

CREATE TABLE IF NOT EXISTS asset_links (
  source_asset_id TEXT NOT NULL,
  target_asset_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_asset_id, target_asset_id, link_type),
  FOREIGN KEY (source_asset_id) REFERENCES assets(asset_id),
  FOREIGN KEY (target_asset_id) REFERENCES assets(asset_id)
);

CREATE INDEX IF NOT EXISTS idx_asset_links_target ON asset_links(target_asset_id, link_type);
