import { normalizeContractForChain } from './utils/chainIdentity';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
const TOKEN_KEY = 'agentic_wallet_access_token';

export type RegisterOptionsResponse = {
  userId: string;
  challengeId: string;
  options: Record<string, unknown>;
};

export type LoginOptionsResponse = {
  challengeId: string;
  options: Record<string, unknown>;
};

export type PayVerifyOptionsResponse = {
  challengeId: string;
  options: Record<string, unknown>;
};

export type AuthVerifyResponse = {
  verified: boolean;
  accessToken: string;
  sessionExpiresAt: string;
  user: {
    id: string;
    handle: string;
    displayName: string;
  };
  wallet: {
    address: string;
    provider: string;
    chainAccounts?: Array<{
      chainId: number;
      protocol: 'evm' | 'svm';
      address: string;
    }>;
  } | null;
};

export type PayVerifyConfirmResponse = {
  verified: boolean;
  verifiedAt: string;
  scope: 'payment';
};

export type MeResponse = {
  user: {
    id: string;
    handle: string;
    displayName: string;
  };
  wallet: {
    address: string;
    provider: string;
    chainAccounts?: Array<{
      chainId: number;
      protocol: 'evm' | 'svm';
      address: string;
    }>;
  } | null;
};

export type ChainsResponse = {
  chains: Array<{
    chainId: number;
    name: string;
    symbol: string;
    marketChain: string;
    protocol: 'evm' | 'svm';
  }>;
};

export type AppConfigResponse = {
  supportedChains: Array<{
    chainId: number;
    name: string;
    symbol: string;
    marketChain: string;
    protocol: 'evm' | 'svm';
  }>;
  defaultReceiveTokens: string[];
};

export type SimEvmBalance = {
  protocol?: 'evm' | 'svm';
  chain: string;
  chain_id: number;
  address: string;
  asset_id?: string;
  chain_asset_id?: string;
  amount: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  price_usd?: number;
  value_usd?: number;
  logo?: string;
  logo_uri?: string;
  url?: string;
};

export type WalletPortfolioResponse = {
  walletAddress: string;
  totalUsd: number;
  holdings: SimEvmBalance[];
  mergedHoldings?: WalletMergedHolding[];
  predictionAccount?: PredictionAccountSnapshot | null;
};

export type PortfolioSnapshotPeriod = '24h' | '7d' | '30d';

export type PortfolioSnapshotPoint = {
  ts: string;
  total_usd: number;
};

export type WalletPortfolioSnapshotsResponse = {
  period: string;
  points: PortfolioSnapshotPoint[];
};

export type WalletMergedHoldingVariant = SimEvmBalance & {
  market_chain: string;
  contract_key: string;
  chain_asset_id: string;
  asset_id: string;
};

export type WalletMergedHolding = {
  asset_id: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  total_value_usd: number;
  variants: WalletMergedHoldingVariant[];
};

export type PredictionAccountSnapshot = {
  available: boolean;
  chainId: number;
  chain: 'polygon';
  signatureType: 'proxy' | 'eoa' | 'gnosis-safe';
  eoaAddress: string | null;
  proxyAddress: string | null;
  depositAddress: string | null;
  collateralSymbol: 'USDC';
  collateralTokenAddress: string;
  collateralDecimals: number;
  balanceRaw: string | null;
  balance: string | null;
  balanceUsd: number | null;
  allowanceRaw: string | null;
  allowance: string | null;
  error: string | null;
  updatedAt: string;
};

export type PredictionDepositInfo = {
  chainId: number;
  chain: 'polygon';
  tokenSymbol: 'USDC';
  tokenAddress: string;
  decimals: number;
  depositAddress: string;
  eoaAddress: string;
  proxyAddress: string;
  note: string;
};

export type PredictionBetRequest = {
  tokenId: string;
  amount: string;
  side?: 'buy' | 'sell';
  orderType?: 'fok' | 'fak';
  slippageBps?: number;
  signatureType?: 'proxy' | 'eoa' | 'gnosis-safe';
};

export type PredictionBetResponse = {
  success: true;
  orderId: string | null;
  status: string | null;
  makingAmount: string | null;
  takingAmount: string | null;
  transactionsHashes: string[];
  side: 'buy' | 'sell';
  amount: string;
  tokenId: string;
  priceUsed: number;
  tickSize: '0.1' | '0.01' | '0.001' | '0.0001';
  negRisk: boolean;
  feeRateBps: number;
  signatureType: 'proxy' | 'eoa' | 'gnosis-safe';
  eoaAddress: string;
  proxyAddress: string;
};

export type TransferQuoteRequest = {
  chainId: number;
  toAddress: string;
  amount: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  feeTokenAddress?: string;
  feeTokenChainId?: number;
};

export type TransferQuoteResponse = {
  chainId: number;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number;
  amountInput: string;
  amountRaw: string;
  estimatedFeeWei: string | null;
  estimatedFeeTokenAmount: string | null;
  estimatedFeeTokenWei: string | null;
  estimatedFeeTokenAddress: string | null;
  estimatedFeeTokenChainId: number | null;
  insufficientFeeTokenBalance: boolean;
  estimatedGas: {
    preVerificationGas: string | null;
    verificationGasLimit: string | null;
    callGasLimit: string | null;
    maxFeePerGas: string | null;
    maxPriorityFeePerGas: string | null;
  };
};

export type TransferRecord = {
  id: string;
  source: 'app' | 'sim';
  chainId: number;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number;
  amountInput: string;
  amountRaw: string;
  txValue: string;
  txHash: string | null;
  status: 'created' | 'submitted' | 'confirmed' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
};

export type TradeQuoteRequest = {
  chainId: number;
  sellTokenAddress: string;
  buyTokenAddress: string;
  sellAmount: string;
  sellTokenSymbol?: string;
  buyTokenSymbol?: string;
  sellTokenDecimals?: number;
  buyTokenDecimals?: number;
  slippageBps?: number;
};

export type TradeQuoteResponse = {
  chainId: number;
  fromAddress: string;
  sellTokenAddress: string;
  sellTokenSymbol: string | null;
  sellTokenDecimals: number;
  buyTokenAddress: string;
  buyTokenSymbol: string | null;
  buyTokenDecimals: number;
  sellAmountInput: string;
  sellAmountRaw: string;
  expectedBuyAmountRaw: string;
  price: number | null;
  slippageBps: number;
  allowanceTarget: string | null;
  needsApproval: boolean;
  estimatedFeeWei: string | null;
  estimatedGas: {
    preVerificationGas: string | null;
    verificationGasLimit: string | null;
    callGasLimit: string | null;
    maxFeePerGas: string | null;
    maxPriorityFeePerGas: string | null;
  };
  provider: '0x' | 'jupiter';
};

export type TradeSubmitResponse = {
  txHash: string;
  status: 'confirmed' | 'failed' | 'pending';
  quote: TradeQuoteResponse;
};

export type TopMarketAsset = {
  id: string;
  asset_id: string;
  instrument_id?: string;
  chain_asset_id: string;
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  image: string | null;
  current_price: number | null;
  market_cap_rank: number | null;
  market_cap: number | null;
  price_change_percentage_24h: number | null;
  turnover_24h: number | null;
  risk_level: string | null;
};

export type TopAssetListName = 'topGainers' | 'topLosers' | 'topVolume' | 'marketCap' | 'trending';
export type TopAssetSource = 'auto' | 'coingecko' | 'bitget';

export type CoinDetail = {
  asset_id: string;
  instrument_id?: string;
  chain_asset_id: string;
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  image: string | null;
  priceChange24h: number | null;
  currentPriceUsd: number | null;
  holders: number | null;
  totalSupply: number | null;
  liquidityUsd: number | null;
  top10HolderPercent: number | null;
  devHolderPercent: number | null;
  lockLpPercent: number | null;
};

export type TokenSecurityCheck = {
  labelName: string | null;
  status: number | null;
  priority: number | null;
  type: number | null;
  values: Record<string, string | number | boolean | null> | null;
};

export type TokenSecurityAudit = {
  asset_id: string;
  instrument_id?: string;
  chain_asset_id: string;
  chain: string;
  contract: string;
  riskChecks: TokenSecurityCheck[];
  warnChecks: TokenSecurityCheck[];
  lowChecks: TokenSecurityCheck[];
  riskCount: number;
  warnCount: number;
  totalChecks: number;
  checkStatus: number | null;
  supported: boolean;
  checking: boolean;
  buyTax: number | null;
  sellTax: number | null;
  freezeAuth: boolean;
  mintAuth: boolean;
  token2022: boolean;
  lpLock: boolean;
  top10HolderRiskLevel: number | null;
  highRisk: boolean;
  cannotSellAll: boolean;
  isProxy: boolean;
};

export type CoinDetailBatchItem = {
  key: string;
  chain: string;
  contract: string;
  detail: CoinDetail | null;
};

export type KlinePeriod = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | 'all';

export type KlineCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number | null;
};

export type TradeBrowseMarketItem = {
  id: string;
  asset_id?: string;
  instrument_id?: string;
  symbol: string;
  name: string;
  image: string | null;
  chain: string | null;
  contract: string | null;
  currentPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
  source: 'bitget' | 'coingecko' | 'hyperliquid' | 'binance';
  metaLabel: string | null;
  metaValue: number | null;
  externalUrl: string | null;
};

export type TradeBrowsePredictionItem = {
  id: string;
  asset_id?: string;
  instrument_id?: string;
  title: string;
  image: string | null;
  description: string | null;
  probability: number | null;
  volume24h: number | null;
  url: string | null;
  startDate: string | null;
  endDate: string | null;
  layout?: 'binary' | 'winner';
  eventId?: string | null;
  outcomeRows?: TradeBrowsePredictionOutcomeRow[];
  options: TradeBrowsePredictionOption[];
  source: 'polymarket';
};

export type TradeBrowsePredictionOption = {
  id: string;
  label: string;
  tokenId: string | null;
  probability: number | null;
};

export type TradeBrowsePredictionOutcomeRow = {
  id: string;
  marketId: string;
  label: string;
  volume: number | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  yesProbability: number | null;
  noProbability: number | null;
};

export type PredictionEventOutcome = {
  id: string;
  eventId: string | null;
  marketId: string;
  label: string;
  probability: number | null;
  noProbability: number | null;
  volume24h: number | null;
  yesTokenId: string | null;
  noTokenId: string | null;
};

export type PredictionEventDetail = {
  kind: 'prediction_event';
  id: string;
  eventId: string | null;
  title: string;
  image: string | null;
  description: string | null;
  probability: number | null;
  volume24h: number | null;
  url: string | null;
  startDate: string | null;
  endDate: string | null;
  layout: 'binary' | 'winner';
  source: 'polymarket';
  outcomes: PredictionEventOutcome[];
};

export type PredictionEventSeries = {
  outcomeId: string;
  label: string;
  tokenId: string | null;
  latestValue: number | null;
  candles: KlineCandle[];
};

export type TradeBrowseResponse = {
  generatedAt: string;
  topMovers: TradeBrowseMarketItem[];
  trendings: TradeBrowseMarketItem[];
  stocks: TradeBrowseMarketItem[];
  perps: TradeBrowseMarketItem[];
  predictions: TradeBrowsePredictionItem[];
};

export type TradeMarketDetailType = 'stock' | 'perp' | 'prediction';
export type InstrumentMarketType = 'spot' | 'perp' | 'prediction';
export type AssetClass = 'crypto' | 'equity_exposure' | 'event_outcome' | 'fiat' | 'index';

export type AssetResolveRequest = {
  chain?: string;
  contract?: string;
  itemId?: string;
  marketType?: InstrumentMarketType;
  venue?: string;
  symbol?: string;
  marketId?: string;
  outcomeId?: string;
  assetClassHint?: AssetClass;
  nameHint?: string;
};

export type AssetResolveResponse = {
  asset_id: string;
  instrument_id: string;
  market_type: InstrumentMarketType;
  confidence: number;
};

export type AssetResolveBatchItemResult =
  | {
      ok: true;
      result: AssetResolveResponse;
    }
  | {
      ok: false;
      error: string;
    };

export type AssetSummary = {
  asset_id: string;
  asset_class: AssetClass;
  symbol: string | null;
  name: string | null;
  logo_uri: string | null;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
};

export type AssetInstrument = {
  instrument_id: string;
  asset_id: string;
  market_type: InstrumentMarketType;
  venue: string | null;
  symbol: string | null;
  chain: string | null;
  contract_key: string | null;
  source: string;
  source_item_id: string | null;
  metadata_json: string | null;
  metadata?: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
};

export type MarketByInstrumentResponse = {
  instrument: AssetInstrument;
  asset: AssetSummary | null;
  refs: Array<{
    provider: string;
    provider_key: string;
    confidence: number;
  }>;
  providerDetail: unknown;
};

export type WatchlistAsset = {
  id: string;
  watch_type: 'crypto' | 'perps' | 'stock' | 'prediction';
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

export type AgentRecommendation = {
  id: string;
  kind: string;
  title: string;
  content: string;
  asset?: {
    symbol: string;
    chain: string | null;
    contract: string | null;
    name: string;
    image: string | null;
    price_change_percentage_24h: number | null;
  };
  score?: number;
  created_at: string;
  valid_until?: string;
  source: 'do';
};

export type AgentArticle = {
  id: string;
  type: 'daily' | 'topic';
  title: string;
  summary: string;
  mdKey: string;
  tags: string[];
  created_at: string;
  status: string;
};

export type AgentArticleRelatedAsset = {
  symbol: string;
  market_type: 'spot' | 'perp' | 'prediction' | null;
  market_item_id: string | null;
  asset_id: string | null;
  instrument_id: string | null;
  chain: string | null;
  contract: string | null;
  name: string;
  image: string | null;
  price_change_percentage_24h: number | null;
};

export type AgentArticleDetailResponse = {
  article: AgentArticle;
  markdown: string;
  relatedAssets: AgentArticleRelatedAsset[];
};

export type AgentTodayDailyResponse = {
  date: string;
  status: 'ready' | 'generating' | 'failed' | 'stale';
  article: AgentArticle | null;
  lastReadyArticle: AgentArticle | null;
};

export type AgentEventType =
  | 'asset_holding_snapshot'
  | 'asset_viewed'
  | 'asset_favorited'
  | 'trade_buy'
  | 'trade_sell'
  | 'article_read'
  | 'article_favorited'
  | 'page_dwell';

export async function postJson<T>(path: string, body: unknown, withAuth = false): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (withAuth && token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? 'request_failed');
  }

  return data as T;
}

export async function getJson<T>(path: string, withAuth = false): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {};

  if (withAuth && token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? 'request_failed');
  }

  return data as T;
}

export async function getWalletPortfolio(): Promise<WalletPortfolioResponse> {
  return getJson<WalletPortfolioResponse>('/v1/wallet/portfolio', true);
}

export async function getWalletPortfolioSnapshots(
  period: PortfolioSnapshotPeriod = '24h',
): Promise<WalletPortfolioSnapshotsResponse> {
  const query = new URLSearchParams();
  query.set('period', period);
  return getJson<WalletPortfolioSnapshotsResponse>(
    `/v1/wallet/portfolio/snapshots?${query.toString()}`,
    true,
  );
}

export async function logout(): Promise<{ ok: true }> {
  return postJson<{ ok: true }>('/v1/auth/logout', {}, true);
}

export async function quoteTransfer(request: TransferQuoteRequest): Promise<TransferQuoteResponse> {
  return postJson<TransferQuoteResponse>('/v1/transfer/quote', request, true);
}

export async function submitTransfer(
  request: TransferQuoteRequest & { idempotencyKey?: string },
): Promise<{ transfer: TransferRecord; deduped: boolean }> {
  return postJson<{ transfer: TransferRecord; deduped: boolean }>('/v1/transfer/submit', request, true);
}

export async function quoteTrade(request: TradeQuoteRequest): Promise<TradeQuoteResponse> {
  return postJson<TradeQuoteResponse>('/v1/trade/quote', request, true);
}

export async function submitTrade(
  request: TradeQuoteRequest & { idempotencyKey?: string },
): Promise<TradeSubmitResponse> {
  return postJson<TradeSubmitResponse>('/v1/trade/submit', request, true);
}

export async function getPredictionAccount(params?: {
  signatureType?: 'proxy' | 'eoa' | 'gnosis-safe';
}): Promise<PredictionAccountSnapshot> {
  const query = new URLSearchParams();
  if (params?.signatureType) query.set('signatureType', params.signatureType);
  const suffix = query.toString();
  return getJson<PredictionAccountSnapshot>(`/v1/prediction/account${suffix ? `?${suffix}` : ''}`, true);
}

export async function getPredictionDepositInfo(): Promise<PredictionDepositInfo> {
  return getJson<PredictionDepositInfo>('/v1/prediction/deposit', true);
}

export async function submitPredictionBet(request: PredictionBetRequest): Promise<PredictionBetResponse> {
  return postJson<PredictionBetResponse>('/v1/prediction/bet', request, true);
}

export async function getTransferHistory(params?: {
  limit?: number;
  status?: TransferRecord['status'];
  chainId?: number;
  tokenAddress?: string | null;
  tokenSymbol?: string;
  assetType?: 'native' | 'erc20';
}): Promise<{ transfers: TransferRecord[] }> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.status) query.set('status', params.status);
  if (params?.chainId) query.set('chainId', String(params.chainId));
  if (params?.tokenAddress !== undefined) {
    query.set('tokenAddress', params.tokenAddress ?? 'native');
  }
  if (params?.tokenSymbol) query.set('tokenSymbol', params.tokenSymbol);
  if (params?.assetType) query.set('assetType', params.assetType);
  const suffix = query.toString();
  return getJson<{ transfers: TransferRecord[] }>(`/v1/transfer/history${suffix ? `?${suffix}` : ''}`, true);
}

export async function getAppConfig(): Promise<AppConfigResponse> {
  return getJson<AppConfigResponse>('/v1/app-config');
}

export async function getTopMarketAssets(params?: {
  limit?: number;
  name?: TopAssetListName;
  source?: TopAssetSource;
  chains?: string[];
  category?: string;
}): Promise<TopMarketAsset[]> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.name) query.set('name', params.name);
  if (params?.source) query.set('source', params.source);
  if (params?.chains?.length) query.set('chains', params.chains.join(','));
  if (params?.category) query.set('category', params.category);
  const suffix = query.toString();
  const response = await getJson<{ assets: TopMarketAsset[] }>(
    `/v1/market/top-assets${suffix ? `?${suffix}` : ''}`,
    true,
  );
  return response.assets;
}

export async function getCoinDetail(chain: string, contract: string): Promise<CoinDetail> {
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedContract = normalizeContractForChain(normalizedChain, contract);
  const query = new URLSearchParams();
  query.set('chain', normalizedChain);
  query.set('contract', normalizedContract);
  const response = await getJson<{ detail: CoinDetail }>(`/v1/market/token-detail?${query.toString()}`, true);
  return response.detail;
}

export async function getCoinDetailsBatch(tokens: Array<{ chain: string; contract: string }>): Promise<CoinDetailBatchItem[]> {
  const normalizedTokens = tokens
    .map((item) => ({
      chain: item.chain.trim().toLowerCase(),
      contract: normalizeContractForChain(item.chain, item.contract),
    }))
    .filter((item) => Boolean(item.chain));
  if (normalizedTokens.length === 0) return [];
  const response = await postJson<{ details: CoinDetailBatchItem[] }>(
    '/v1/market/token-details',
    { tokens: normalizedTokens },
    true,
  );
  return response.details;
}

export async function getTokenSecurityAudit(
  chain: string,
  contract: string,
): Promise<TokenSecurityAudit | null> {
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedContract = normalizeContractForChain(normalizedChain, contract);
  const query = new URLSearchParams();
  query.set('chain', normalizedChain);
  query.set('contract', normalizedContract);
  const response = await getJson<{ audit: TokenSecurityAudit | null }>(
    `/v1/market/token-security?${query.toString()}`,
    true,
  );
  return response.audit;
}

export async function getTokenKline(
  chain: string,
  contract: string,
  period: KlinePeriod = '1h',
  size = 60,
): Promise<KlineCandle[]> {
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedContract = normalizeContractForChain(normalizedChain, contract);
  const query = new URLSearchParams();
  query.set('chain', normalizedChain);
  query.set('contract', normalizedContract);
  query.set('period', period);
  query.set('size', String(size));
  const response = await getJson<{ candles: KlineCandle[] }>(`/v1/market/kline?${query.toString()}`, true);
  return response.candles;
}

export async function getTradeMarketKline(
  type: TradeMarketDetailType,
  id: string,
  period: KlinePeriod = '1h',
  size = 60,
  optionTokenId?: string | null,
): Promise<KlineCandle[]> {
  const query = new URLSearchParams();
  query.set('type', type);
  query.set('id', id.trim());
  query.set('period', period);
  query.set('size', String(size));
  if (optionTokenId) {
    query.set('optionTokenId', optionTokenId.trim());
  }
  const response = await getJson<{ candles: KlineCandle[] }>(`/v1/market/trade-kline?${query.toString()}`, true);
  return response.candles;
}

export async function getTradeMarketDetail(
  type: TradeMarketDetailType,
  id: string,
): Promise<TradeBrowseMarketItem | TradeBrowsePredictionItem> {
  const query = new URLSearchParams();
  query.set('type', type);
  query.set('id', id.trim());
  const response = await getJson<{ detail: TradeBrowseMarketItem | TradeBrowsePredictionItem }>(
    `/v1/market/trade-detail?${query.toString()}`,
    true,
  );
  return response.detail;
}

export async function getPredictionEventDetail(id: string): Promise<PredictionEventDetail> {
  const query = new URLSearchParams();
  query.set('id', id.trim());
  const response = await getJson<{ detail: PredictionEventDetail }>(
    `/v1/market/prediction-detail?${query.toString()}`,
    true,
  );
  return response.detail;
}

export async function getPredictionEventKline(
  id: string,
  period: KlinePeriod = 'all',
  size = 240,
): Promise<PredictionEventSeries[]> {
  const query = new URLSearchParams();
  query.set('id', id.trim());
  query.set('period', period);
  query.set('size', String(size));
  const response = await getJson<{ series: PredictionEventSeries[] }>(
    `/v1/market/prediction-kline?${query.toString()}`,
    true,
  );
  return response.series;
}

export async function getTradeBrowse(): Promise<TradeBrowseResponse> {
  return getJson<TradeBrowseResponse>('/v1/market/trade-browse', true);
}

export async function resolveAssetIdentity(input: AssetResolveRequest): Promise<AssetResolveResponse> {
  return postJson<AssetResolveResponse>('/v1/assets/resolve', input, true);
}

export async function resolveAssetIdentityBatch(
  inputs: AssetResolveRequest[],
): Promise<AssetResolveBatchItemResult[]> {
  if (!inputs.length) return [];
  const response = await postJson<{ results: AssetResolveBatchItemResult[] }>(
    '/v1/assets/resolve/batch',
    { items: inputs },
    true,
  );
  return response.results;
}

export async function getAssetById(assetId: string): Promise<{
  asset: AssetSummary;
  marketCount: number;
  defaultInstrumentId: string | null;
  instruments: Array<{
    instrument_id: string;
    market_type: InstrumentMarketType;
    venue: string | null;
    symbol: string | null;
    chain: string | null;
    contract_key: string | null;
  }>;
}> {
  return getJson(`/v1/assets/${encodeURIComponent(assetId)}`, true);
}

export async function getAssetInstruments(assetId: string): Promise<{
  asset_id: string;
  instruments: AssetInstrument[];
}> {
  return getJson(`/v1/assets/${encodeURIComponent(assetId)}/instruments`, true);
}

export async function getMarketByInstrumentId(instrumentId: string): Promise<MarketByInstrumentResponse> {
  return getJson(`/v1/markets/${encodeURIComponent(instrumentId)}`, true);
}

export async function getMarketCandlesByInstrumentId(
  instrumentId: string,
  period: KlinePeriod = '1h',
  size = 60,
  optionTokenId?: string | null,
): Promise<KlineCandle[]> {
  const query = new URLSearchParams();
  query.set('period', period);
  query.set('size', String(size));
  if (optionTokenId) query.set('optionTokenId', optionTokenId.trim());
  const response = await getJson<{ candles: KlineCandle[] }>(
    `/v1/markets/${encodeURIComponent(instrumentId)}/candles?${query.toString()}`,
    true,
  );
  return response.candles;
}

export async function getMarketWatchlist(params?: {
  limit?: number;
}): Promise<{ assets: WatchlistAsset[] }> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return getJson<{ assets: WatchlistAsset[] }>(`/v1/market/watchlist${suffix ? `?${suffix}` : ''}`, true);
}

export async function addMarketWatchlistAsset(input: {
  watchType?: 'crypto' | 'perps' | 'stock' | 'prediction';
  itemId?: string | null;
  chain?: string | null;
  contract?: string | null;
  symbol?: string;
  name?: string;
  image?: string | null;
  source?: string;
  change24h?: number | null;
  externalUrl?: string | null;
}): Promise<WatchlistAsset> {
  const response = await postJson<{ ok: true; asset: WatchlistAsset }>(
    '/v1/market/watchlist',
    input,
    true,
  );
  return response.asset;
}

export async function removeMarketWatchlistAsset(input: {
  id?: string | null;
  chain?: string | null;
  contract?: string | null;
}): Promise<boolean> {
  const response = await postJson<{ ok: true; removed: boolean }>(
    '/v1/market/watchlist/remove',
    input,
    true,
  );
  return response.removed;
}

export type MarketSearchResult = {
  id: string;
  marketType: 'spot' | 'stock' | 'perp' | 'prediction';
  symbol: string;
  name: string;
  image: string | null;
  currentPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
  probability: number | null;
  source: string;
  externalUrl: string | null;
  itemId: string | null;
  chain: string | null;
  contract: string | null;
  asset_id?: string;
  instrument_id?: string;
};

export async function searchMarketTokens(q: string, limit = 20): Promise<MarketSearchResult[]> {
  const query = new URLSearchParams();
  query.set('q', q.trim());
  query.set('limit', String(limit));
  const response = await getJson<{ results: MarketSearchResult[] }>(
    `/v1/market/search?${query.toString()}`,
    true,
  );
  return response.results;
}

export async function getAgentRecommendations(): Promise<{ recommendations: AgentRecommendation[] }> {
  return getJson<{ recommendations: AgentRecommendation[] }>('/v1/agent/recommendations', true);
}

export async function getAgentArticles(params?: {
  type?: 'daily' | 'topic';
  limit?: number;
}): Promise<{ articles: AgentArticle[] }> {
  const query = new URLSearchParams();
  if (params?.type) query.set('type', params.type);
  if (params?.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return getJson<{ articles: AgentArticle[] }>(`/v1/agent/articles${suffix ? `?${suffix}` : ''}`, true);
}

export async function getAgentArticleDetail(articleId: string): Promise<AgentArticleDetailResponse> {
  return getJson<AgentArticleDetailResponse>(`/v1/agent/articles/${articleId}`, true);
}

export async function getAgentTodayDaily(): Promise<AgentTodayDailyResponse> {
  return getJson<AgentTodayDailyResponse>('/v1/agent/daily/today', true);
}

export async function setAgentPreferredLocale(locale: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(
    '/v1/agent/preferences/locale',
    {
      locale,
    },
    true,
  );
}

export type AgentChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AgentChatResponse = {
  reply: string;
  sessionId: string;
};

export async function agentChat(request: {
  sessionId: string;
  page: string;
  pageContext?: Record<string, string>;
  messages: AgentChatMessage[];
}): Promise<AgentChatResponse> {
  return postJson<AgentChatResponse>('/v1/agent/chat', request, true);
}

export async function ingestAgentEvent(
  type: AgentEventType,
  payload?: Record<string, unknown>,
  dedupeKey?: string,
): Promise<{ accepted: boolean; eventId?: string }> {
  return postJson<{ accepted: boolean; eventId?: string }>(
    '/v1/agent/events',
    {
      type,
      payload,
      dedupeKey,
    },
    true,
  );
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
