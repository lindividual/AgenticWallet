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

CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_special_slot_slug
  ON topic_special_articles(slot_key, topic_slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_special_r2_key
  ON topic_special_articles(r2_key);

CREATE INDEX IF NOT EXISTS idx_topic_special_generated_at
  ON topic_special_articles(generated_at DESC);
