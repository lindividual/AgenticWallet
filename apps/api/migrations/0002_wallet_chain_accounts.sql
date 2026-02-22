CREATE TABLE IF NOT EXISTS wallet_chain_accounts (
  user_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, chain_id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_wallet_chain_accounts_user_id ON wallet_chain_accounts(user_id);
