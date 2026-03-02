import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

export type Bindings = {
  DB: D1Database;
  USER_AGENT: DurableObjectNamespace;
  AGENT_ARTICLES: R2Bucket;
  APP_SECRET: string;
  WEBAUTHN_RP_NAME: string;
  SIM_API_KEY?: string;
  WEBAUTHN_REQUIRE_UV?: string;
  ETHEREUM_RPC_URL?: string;
  BASE_RPC_URL?: string;
  BNB_RPC_URL?: string;
  BICONOMY_MEE_VERSION?: string;
  BICONOMY_BUNDLER_API_KEY?: string;
  BICONOMY_BUNDLER_URL?: string;
  MEE_ENABLE_SIMULATION?: string;
  MEE_TRANSFER_CALL_GAS_LIMIT?: string;
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
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
};

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
    chainId: number;
    address: string;
  }>;
};

export type TransferStatus = 'created' | 'submitted' | 'confirmed' | 'failed';

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

export type TransferSubmitRequest = TransferQuoteRequest & {
  idempotencyKey?: string;
};
