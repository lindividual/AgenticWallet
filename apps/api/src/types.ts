import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

export type Bindings = {
  DB: D1Database;
  USER_AGENT: DurableObjectNamespace;
  TOPIC_SPECIAL: DurableObjectNamespace;
  AGENT_ARTICLES: R2Bucket;
  APP_SECRET: string;
  WEBAUTHN_RP_NAME: string;
  SIM_API_KEY?: string;
  WEBAUTHN_REQUIRE_UV?: string;
  ETHEREUM_RPC_URL?: string;
  BASE_RPC_URL?: string;
  BNB_RPC_URL?: string;
  ARBITRUM_RPC_URL?: string;
  OPTIMISM_RPC_URL?: string;
  POLYGON_RPC_URL?: string;
  TRON_RPC_URL?: string;
  SOLANA_RPC_URL?: string;
  BICONOMY_API_KEY?: string;
  BICONOMY_API_BASE_URL?: string;
  BICONOMY_MEE_VERSION?: string;
  BICONOMY_BUNDLER_API_KEY?: string;
  BICONOMY_BUNDLER_URL?: string;
  MEE_ENABLE_SIMULATION?: string;
  MEE_TRANSFER_CALL_GAS_LIMIT?: string;
  MEE_SPONSORSHIP_ENABLED?: string;
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_FALLBACK_PROVIDER?: string;
  LLM_FALLBACK_BASE_URL?: string;
  LLM_FALLBACK_API_KEY?: string;
  LLM_FALLBACK_MODEL?: string;
  CF_AI_GATEWAY_ACCOUNT_ID?: string;
  CF_AI_GATEWAY_GATEWAY_ID?: string;
  CF_AI_GATEWAY_TOKEN?: string;
  CF_AIG_TOKEN?: string;
  DAILY_NEWS_FEEDS?: string;
  TOKEN_LIST_URLS?: string;
  TOKEN_LIST_MAX_TOKENS?: string;
  BGW_API_KEY?: string;
  BGW_API_SECRET?: string;
  COINGECKO_API_KEY?: string;
  COINGECKO_API_BASE_URL?: string;
  COINGECKO_USER_AGENT?: string;
  TRON_PRO_API_KEY?: string;
  TRONSCAN_API_KEY?: string;
  LIFI_API_KEY?: string;
  LIFI_API_BASE_URL?: string;
  OPENNEWS_TOKEN?: string;
  TWITTER_TOKEN?: string;
  ADMIN_API_TOKEN?: string;
  TOPIC_SPECIAL_ADMIN_TOKEN?: string;
  TRADE_AGGREGATOR_BASE_URL?: string;
  TRADE_AGGREGATOR_API_KEY?: string;
  TRADE_DEFAULT_SLIPPAGE_BPS?: string;
  HYPERLIQUID_API_URL?: string;
  HYPERLIQUID_TESTNET?: string;
  HYPERLIQUID_DEFAULT_SLIPPAGE_BPS?: string;
  JUPITER_API_BASE_URL?: string;
  PREDICTION_CLOB_HOST?: string;
  PREDICTION_SIGNATURE_TYPE?: string;
};

export type WalletProtocol = 'evm' | 'svm' | 'tvm' | 'btc';
export type WalletNetworkKey = string;

export type Variables = {
  userId: string;
  sessionToken: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type RegisterOptionsRequest = {
  displayName?: string;
};

export type RegisterVerifyRequest = {
  userId: string;
  challengeId: string;
  response: RegistrationResponseJSON;
};

export type LoginVerifyRequest = {
  challengeId: string;
  response: AuthenticationResponseJSON;
};

export type PayVerifyConfirmRequest = {
  challengeId: string;
  response: AuthenticationResponseJSON;
};

export type WebAuthnConfig = {
  origin: string;
  rpId: string;
  rpName: string;
  requireUserVerification: boolean;
};

export type UserSummary = {
  id: string;
  handle: string;
  displayName: string;
};

export type WalletSummary = {
  address: string;
  provider: string;
  chainAccounts: Array<{
    networkKey: WalletNetworkKey;
    chainId: number | null;
    protocol: WalletProtocol;
    address: string;
  }>;
};

export type TransferStatus = 'created' | 'submitted' | 'confirmed' | 'failed';

export type TransferQuoteRequest = {
  networkKey: WalletNetworkKey;
  toAddress: string;
  amount: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  feeTokenAddress?: string;
  feeTokenChainId?: number;
};

export type TransferQuoteResponse = {
  networkKey: WalletNetworkKey;
  chainId: number | null;
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
  estimatedFeeTokenSymbol: string | null;
  estimatedFeeTokenDecimals: number | null;
  insufficientFeeTokenBalance: boolean;
  estimatedGas: {
    preVerificationGas: string | null;
    verificationGasLimit: string | null;
    callGasLimit: string | null;
    maxFeePerGas: string | null;
    maxPriorityFeePerGas: string | null;
  };
};

export type TransferSubmitRequest = TransferQuoteRequest & {
  idempotencyKey?: string;
};

export type SupportedStablecoinSymbol = 'USDT' | 'USDC';

export type CrossChainTransferQuoteRequest = {
  toAddress: string;
  destinationNetworkKey: WalletNetworkKey;
  destinationTokenSymbol: SupportedStablecoinSymbol;
  amount: string;
  sourceNetworkKey?: WalletNetworkKey;
};

export type CrossChainTransferSourceOption = {
  networkKey: WalletNetworkKey;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: SupportedStablecoinSymbol;
  tokenDecimals: number;
  availableAmountRaw: string;
};

export type CrossChainTransferLegQuote = {
  kind: 'direct' | 'bridge';
  fromNetworkKey: WalletNetworkKey;
  fromChainId: number;
  fromTokenAddress: string;
  fromTokenSymbol: string | null;
  fromTokenDecimals: number;
  fromAmountRaw: string;
  fromAmountInput: string;
  fromAddress: string;
  toNetworkKey: WalletNetworkKey;
  toChainId: number;
  toTokenAddress: string;
  toTokenSymbol: string | null;
  toTokenDecimals: number;
  toAmountRaw: string;
  toAmountMinRaw: string | null;
  recipientAddress: string;
  tool: string | null;
  approvalAddress: string | null;
  estimatedDurationSeconds: number | null;
  estimatedGasCostUsd: string | null;
  estimatedFeeCostUsd: string | null;
};

export type CrossChainTransferQuoteResponse = {
  executionMode: 'direct' | 'single_source_bridge' | 'multi_source_bridge' | 'insufficient_balance';
  canSubmit: boolean;
  toAddress: string;
  destinationNetworkKey: WalletNetworkKey;
  destinationChainId: number;
  destinationTokenAddress: string;
  destinationTokenSymbol: SupportedStablecoinSymbol;
  destinationTokenDecimals: number;
  requestedAmountInput: string;
  requestedAmountRaw: string;
  estimatedReceivedAmountRaw: string;
  shortfallAmountRaw: string;
  recommendedSourceNetworkKey: WalletNetworkKey | null;
  selectedSourceNetworkKey: WalletNetworkKey | null;
  availableSourceOptions: CrossChainTransferSourceOption[];
  legs: CrossChainTransferLegQuote[];
};

export type CrossChainTransferSubmitRequest = CrossChainTransferQuoteRequest;

export type CrossChainTransferSubmitLegResult = {
  kind: 'direct' | 'bridge';
  fromNetworkKey: WalletNetworkKey;
  txHash: string;
  approvalTxHash: string | null;
  sourceStatus: 'confirmed' | 'failed' | 'pending' | 'submitted';
  tool: string | null;
};

export type CrossChainTransferSubmitResponse = {
  status: 'confirmed' | 'failed' | 'pending' | 'submitted';
  quote: CrossChainTransferQuoteResponse;
  legs: CrossChainTransferSubmitLegResult[];
};

export type TradeQuoteRequest = {
  networkKey: WalletNetworkKey;
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
  networkKey: WalletNetworkKey;
  chainId: number | null;
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

export type TradeSubmitRequest = TradeQuoteRequest & {
  idempotencyKey?: string;
};

export type PerpsPositionSnapshot = {
  coin: string;
  size: string;
  side: 'long' | 'short';
  entryPrice: number | null;
  markPrice: number | null;
  positionValueUsd: number | null;
  notionalUsd: number | null;
  unrealizedPnlUsd: number | null;
  returnOnEquityPct: number | null;
  liquidationPrice: number | null;
  marginUsedUsd: number | null;
  leverageType: 'cross' | 'isolated';
  leverageValue: number | null;
  maxLeverage: number | null;
};

export type PerpsOpenOrderSnapshot = {
  coin: string;
  side: 'long' | 'short';
  limitPrice: number | null;
  size: string;
  originalSize: string;
  orderId: number;
  timestamp: number;
  reduceOnly: boolean;
};

export type PerpsAccountSnapshot = {
  available: boolean;
  provider: 'hyperliquid';
  userAddress: string | null;
  balanceUsd: number | null;
  withdrawableUsd: number | null;
  marginUsedUsd: number | null;
  totalPositionNotionalUsd: number | null;
  unrealizedPnlUsd: number | null;
  openOrderCount: number;
  positions: PerpsPositionSnapshot[];
  openOrders: PerpsOpenOrderSnapshot[];
  error: string | null;
  updatedAt: string;
};

export type PerpsOrderRequest = {
  coin: string;
  side?: 'long' | 'short';
  size: string;
  orderType?: 'market' | 'limit';
  limitPrice?: string;
  reduceOnly?: boolean;
  leverage?: number;
  marginMode?: 'cross' | 'isolated';
  slippageBps?: number;
};

export type PerpsOrderResponse = {
  success: true;
  coin: string;
  side: 'long' | 'short';
  size: string;
  orderType: 'market' | 'limit';
  limitPrice: string;
  reduceOnly: boolean;
  leverage: number | null;
  marginMode: 'cross' | 'isolated';
  orderId: number | null;
  status: 'filled' | 'resting' | 'waitingForFill' | 'waitingForTrigger';
  avgFillPrice: string | null;
  totalFilledSize: string | null;
  updatedAt: string;
};

export type PerpsCancelOrderRequest = {
  coin: string;
  orderId: number;
};

export type PerpsCancelOrderResponse = {
  success: true;
  coin: string;
  orderId: number;
  updatedAt: string;
};

export type PredictionBetRequest = {
  tokenId: string;
  amount: string;
  side?: 'buy' | 'sell';
  orderType?: 'fok' | 'fak';
  slippageBps?: number;
  signatureType?: 'proxy' | 'eoa' | 'gnosis-safe';
};
