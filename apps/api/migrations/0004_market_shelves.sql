CREATE TABLE IF NOT EXISTS token_taxonomy (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  sector TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  risk_level TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL NOT NULL DEFAULT 0.5,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, address)
);

CREATE INDEX IF NOT EXISTS idx_token_taxonomy_sector ON token_taxonomy(sector);
CREATE INDEX IF NOT EXISTS idx_token_taxonomy_language ON token_taxonomy(language);

CREATE TABLE IF NOT EXISTS market_shelf_configs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  list_name TEXT NOT NULL DEFAULT 'topGainers',
  chains_json TEXT NOT NULL DEFAULT '[]',
  category TEXT,
  limit_count INTEGER NOT NULL DEFAULT 12,
  sort_order INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_market_shelf_sort ON market_shelf_configs(enabled, sort_order);

INSERT OR IGNORE INTO market_shelf_configs (id, title, description, source, list_name, chains_json, category, limit_count, sort_order, enabled)
VALUES
  ('meme_trending_global', 'Meme Trending', 'Global meme momentum shelf', 'auto', 'topGainers', '["eth","base","bnb"]', 'meme-token', 12, 10, 1),
  ('meme_trending_base', 'Base Meme', 'Meme tokens trending on Base', 'auto', 'topGainers', '["base"]', 'meme-token', 10, 20, 1),
  ('meme_trending_bnb', 'BNB Meme', 'Meme tokens trending on BNB Chain', 'auto', 'topGainers', '["bnb"]', 'meme-token', 10, 30, 1),
  ('defi_bluechips', 'DeFi Bluechips', 'Large-cap DeFi names by market cap', 'auto', 'marketCap', '["eth","base","bnb"]', 'decentralized-finance-defi', 12, 40, 1),
  ('defi_momentum', 'DeFi Momentum', '24h DeFi movers', 'auto', 'topGainers', '["eth","base","bnb"]', 'decentralized-finance-defi', 12, 50, 1),
  ('market_cap_leaders', 'Market Cap Leaders', 'Top assets by market cap', 'auto', 'marketCap', '["eth","base","bnb"]', NULL, 12, 60, 1);
