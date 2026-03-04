-- Consolidated baseline migration (merged from previous 0001-0007 migrations).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS passkeys (
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
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  ceremony TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS wallet_chain_accounts (
  user_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, chain_id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS coingecko_coin_platforms (
  coin_id TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  platforms_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coingecko_coin_platform_sync_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  changed_rows INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS topic_special_articles (
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

-- Ensure deprecated table is absent in fresh or partially migrated local DBs.
DROP TABLE IF EXISTS token_catalog;

CREATE INDEX IF NOT EXISTS idx_passkeys_user_id ON passkeys(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_challenges_ceremony ON auth_challenges(ceremony);
CREATE INDEX IF NOT EXISTS idx_wallet_chain_accounts_user_id ON wallet_chain_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_coingecko_coin_platforms_symbol ON coingecko_coin_platforms(symbol);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_special_slot_slug ON topic_special_articles(slot_key, topic_slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_special_r2_key ON topic_special_articles(r2_key);
CREATE INDEX IF NOT EXISTS idx_topic_special_generated_at ON topic_special_articles(generated_at DESC);
