export type JobType = 'daily_digest' | 'recommendation_refresh' | 'topic_generation' | 'cleanup';

export type EventRow = {
  id: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  payload_json: string;
  dedupe_key: string | null;
};

export type RecommendationRow = {
  id: string;
  category: string;
  asset_name: string;
  asset_symbol: string | null;
  asset_chain: string | null;
  asset_contract: string | null;
  asset_display_name: string | null;
  asset_image: string | null;
  asset_price_change_24h: number | null;
  reason: string;
  score: number;
  generated_at: string;
  valid_until: string | null;
};

export type ArticleRow = {
  id: string;
  article_type: string;
  title: string;
  summary: string;
  r2_key: string;
  tags_json: string;
  created_at: string;
  status: string;
};

export type ArticleContentRow = {
  article_id: string;
  markdown: string;
};

export type JobRow = {
  id: string;
  job_type: JobType;
  run_at: string;
  status: string;
  payload_json: string;
  retry_count: number;
  job_key: string | null;
};

export type TodayDailyStatus = 'ready' | 'generating' | 'failed' | 'stale';

export type PortfolioSnapshotPoint = {
  ts: string;
  total_usd: number;
};

export type TransferStatus = 'created' | 'submitted' | 'confirmed' | 'failed';

export type TransferRow = {
  id: string;
  user_id: string;
  chain_id: number;
  from_address: string;
  to_address: string;
  token_address: string | null;
  token_symbol: string | null;
  token_decimals: number;
  amount_input: string;
  amount_raw: string;
  tx_value: string;
  tx_hash: string | null;
  status: TransferStatus;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
};
