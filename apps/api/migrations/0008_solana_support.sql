ALTER TABLE wallet_chain_accounts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'evm';

UPDATE wallet_chain_accounts
SET protocol = 'evm'
WHERE protocol IS NULL OR TRIM(protocol) = '';

CREATE TABLE IF NOT EXISTS wallet_protocol_keys (
  user_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  encrypted_key_material TEXT NOT NULL,
  key_format TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, protocol),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

