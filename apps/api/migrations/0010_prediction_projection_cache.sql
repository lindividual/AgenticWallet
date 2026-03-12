ALTER TABLE prediction_events ADD COLUMN synced_at TEXT;
ALTER TABLE prediction_events ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_prediction_events_expires_at ON prediction_events(expires_at);
