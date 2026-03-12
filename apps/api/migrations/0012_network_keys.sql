CREATE TABLE IF NOT EXISTS wallet_chain_accounts_v2 (
  user_id TEXT NOT NULL,
  network_key TEXT NOT NULL,
  chain_id INTEGER,
  protocol TEXT NOT NULL DEFAULT 'evm',
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, network_key),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

INSERT OR REPLACE INTO wallet_chain_accounts_v2 (
  user_id,
  network_key,
  chain_id,
  protocol,
  address,
  created_at
)
SELECT
  user_id,
  CASE
    WHEN COALESCE(protocol, 'evm') = 'evm' AND chain_id = 1 THEN 'ethereum-mainnet'
    WHEN COALESCE(protocol, 'evm') = 'evm' AND chain_id = 8453 THEN 'base-mainnet'
    WHEN COALESCE(protocol, 'evm') = 'evm' AND chain_id = 56 THEN 'bnb-mainnet'
    WHEN COALESCE(protocol, 'evm') = 'svm' THEN 'solana-mainnet'
    WHEN COALESCE(protocol, 'evm') = 'btc' THEN 'bitcoin-mainnet'
    ELSE LOWER(COALESCE(protocol, 'evm')) || ':' || CAST(chain_id AS TEXT)
  END AS network_key,
  CASE
    WHEN COALESCE(protocol, 'evm') = 'evm' THEN chain_id
    ELSE NULL
  END AS chain_id,
  COALESCE(protocol, 'evm') AS protocol,
  address,
  created_at
FROM wallet_chain_accounts;

DROP TABLE wallet_chain_accounts;
ALTER TABLE wallet_chain_accounts_v2 RENAME TO wallet_chain_accounts;

CREATE INDEX IF NOT EXISTS idx_wallet_chain_accounts_user_id ON wallet_chain_accounts(user_id);
