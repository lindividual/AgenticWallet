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
  SOLANA_RPC_URL?: string;
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
  OPENNEWS_TOKEN?: string;
  TWITTER_TOKEN?: string;
  TOPIC_SPECIAL_ADMIN_TOKEN?: string;
  TRADE_AGGREGATOR_BASE_URL?: string;
  TRADE_AGGREGATOR_API_KEY?: string;
  TRADE_DEFAULT_SLIPPAGE_BPS?: string;
  JUPITER_API_BASE_URL?: string;
  PREDICTION_CLOB_HOST?: string;
  PREDICTION_SIGNATURE_TYPE?: string;
};

export type WalletProtocol = 'evm' | 'svm' | 'btc';
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

export type PredictionBetRequest = {
  tokenId: string;
  amount: string;
  side?: 'buy' | 'sell';
  orderType?: 'fok' | 'fak';
  slippageBps?: number;
  signatureType?: 'proxy' | 'eoa' | 'gnosis-safe';
};
