import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

export type Bindings = {
  DB: D1Database;
  USER_AGENT: DurableObjectNamespace;
  APP_SECRET: string;
  WEBAUTHN_RP_NAME: string;
  SIM_API_KEY?: string;
  PORTFOLIO_CHAIN_IDS?: string;
  WEBAUTHN_REQUIRE_UV?: string;
  ETHEREUM_RPC_URL?: string;
  BASE_RPC_URL?: string;
  BNB_RPC_URL?: string;
  BICONOMY_MEE_VERSION?: string;
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
};

export type Variables = {
  userId: string;
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
