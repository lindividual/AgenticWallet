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
