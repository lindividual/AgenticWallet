export type JobType = 'daily_digest' | 'portfolio_snapshot' | 'trade_shelf_refresh';

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

export type JobRow = {
  id: string;
  job_type: JobType;
  run_at: string;
  status: string;
  payload_json: string;
  result_json: string | null;
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
  network_key: string;
  chain_id: number | null;
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

export type WatchlistAssetRow = {
  id: string;
  watch_type: 'crypto' | 'perps' | 'prediction';
  item_id: string | null;
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  image: string | null;
  source: string | null;
  change_24h: number | null;
  external_url: string | null;
  created_at: string;
  updated_at: string;
};

export type TradeShelfSectionId = 'holdings' | 'behavior' | 'fresh';

export type TradeShelfItemKind = 'spot' | 'perp' | 'prediction';

export type TradeShelfReasonTag =
  | 'Based on holdings'
  | 'In your watchlist'
  | 'Recently viewed'
  | 'Recently traded'
  | 'Trending now'
  | 'Diversification';

export type TradeShelfStateRow = {
  id: string;
  dirty: number;
  last_refreshed_at: string | null;
  generated_at: string | null;
  updated_at: string;
};

export type TradeShelfItemRow = {
  id: string;
  section_id: TradeShelfSectionId;
  section_title: string;
  item_rank: number;
  item_kind: TradeShelfItemKind;
  item_id: string;
  symbol: string;
  title: string;
  image: string | null;
  chain: string | null;
  contract: string | null;
  current_price: number | null;
  change_24h: number | null;
  probability: number | null;
  volume_24h: number | null;
  reason_tag: TradeShelfReasonTag;
  score: number;
  created_at: string;
  updated_at: string;
};

export type TradeShelfItem = {
  id: string;
  kind: TradeShelfItemKind;
  itemId: string;
  symbol: string;
  title: string;
  image: string | null;
  chain: string | null;
  contract: string | null;
  currentPrice: number | null;
  change24h: number | null;
  probability: number | null;
  volume24h: number | null;
  reasonTag: TradeShelfReasonTag;
};

export type TradeShelfSection = {
  id: TradeShelfSectionId;
  title: string;
  items: TradeShelfItem[];
};

export type TradeShelfResponse = {
  generatedAt: string | null;
  refreshState: {
    dirty: boolean;
    lastRefreshedAt: string | null;
    needsRefresh: boolean;
  };
  sections: TradeShelfSection[];
};
