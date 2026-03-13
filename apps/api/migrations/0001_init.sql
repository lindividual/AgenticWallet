-- Baseline D1 schema snapshot as of 2026-03-13.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key_b64 TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports_json TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  ceremony TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE wallets (
  user_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE wallet_chain_accounts (
  user_id TEXT NOT NULL,
  network_key TEXT NOT NULL,
  chain_id INTEGER,
  protocol TEXT NOT NULL DEFAULT 'evm',
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, network_key),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE wallet_protocol_keys (
  user_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  encrypted_key_material TEXT NOT NULL,
  key_format TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, protocol),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE coingecko_coin_platforms (
  coin_id TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  platforms_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE coingecko_coin_platform_sync_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  changed_rows INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE prediction_events (
  prediction_event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_event_id TEXT,
  primary_market_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  image TEXT,
  url TEXT,
  start_date TEXT,
  end_date TEXT,
  layout TEXT NOT NULL,
  probability REAL,
  volume24h REAL,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT,
  expires_at TEXT
);

CREATE TABLE prediction_markets (
  prediction_market_id TEXT PRIMARY KEY,
  prediction_event_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_market_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  volume24h REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (prediction_event_id) REFERENCES prediction_events(prediction_event_id)
);

CREATE TABLE prediction_outcomes (
  prediction_outcome_id TEXT PRIMARY KEY,
  prediction_event_id TEXT NOT NULL,
  prediction_market_id TEXT NOT NULL,
  source_outcome_id TEXT NOT NULL,
  label TEXT NOT NULL,
  yes_token_id TEXT,
  no_token_id TEXT,
  yes_probability REAL,
  no_probability REAL,
  volume24h REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (prediction_event_id) REFERENCES prediction_events(prediction_event_id),
  FOREIGN KEY (prediction_market_id) REFERENCES prediction_markets(prediction_market_id)
);

CREATE TABLE market_shelf_cache (
  shelf_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE topic_special_articles (
  id TEXT PRIMARY KEY,
  slot_key TEXT NOT NULL,
  topic_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  related_assets_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready'
);

CREATE INDEX idx_passkeys_user_id ON passkeys(user_id);
CREATE INDEX idx_challenges_ceremony ON auth_challenges(ceremony);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_wallet_chain_accounts_user_id ON wallet_chain_accounts(user_id);
CREATE INDEX idx_coingecko_coin_platforms_symbol ON coingecko_coin_platforms(symbol);
CREATE INDEX idx_prediction_events_primary_market_id ON prediction_events(primary_market_id);
CREATE INDEX idx_prediction_events_source_event_id ON prediction_events(source_event_id);
CREATE INDEX idx_prediction_events_expires_at ON prediction_events(expires_at);
CREATE INDEX idx_prediction_markets_event_id ON prediction_markets(prediction_event_id);
CREATE INDEX idx_prediction_markets_source_market_id ON prediction_markets(source_market_id);
CREATE INDEX idx_prediction_outcomes_event_id ON prediction_outcomes(prediction_event_id);
CREATE INDEX idx_prediction_outcomes_market_id ON prediction_outcomes(prediction_market_id);
CREATE INDEX idx_prediction_outcomes_yes_token_id ON prediction_outcomes(yes_token_id);
CREATE INDEX idx_market_shelf_cache_expires_at ON market_shelf_cache(expires_at);
CREATE UNIQUE INDEX idx_topic_special_slot_slug ON topic_special_articles(slot_key, topic_slug);
CREATE UNIQUE INDEX idx_topic_special_r2_key ON topic_special_articles(r2_key);
CREATE INDEX idx_topic_special_generated_at ON topic_special_articles(generated_at DESC);
