CREATE TABLE IF NOT EXISTS prediction_events (
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
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prediction_events_source_event_id ON prediction_events(source_event_id);
CREATE INDEX IF NOT EXISTS idx_prediction_events_primary_market_id ON prediction_events(primary_market_id);

CREATE TABLE IF NOT EXISTS prediction_markets (
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

CREATE INDEX IF NOT EXISTS idx_prediction_markets_event_id ON prediction_markets(prediction_event_id);
CREATE INDEX IF NOT EXISTS idx_prediction_markets_source_market_id ON prediction_markets(source_market_id);

CREATE TABLE IF NOT EXISTS prediction_outcomes (
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

CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_event_id ON prediction_outcomes(prediction_event_id);
CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_market_id ON prediction_outcomes(prediction_market_id);
CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_yes_token_id ON prediction_outcomes(yes_token_id);
