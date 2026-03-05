import {
  OrderType as ClobOrderType,
  OrderBuilder,
  SignatureType as ClobSignatureType,
  Side as ClobSide,
  type SignedOrder,
  type TickSize,
} from '@polymarket/clob-client';
import { privateKeyToAccount } from 'viem/accounts';
import {
  concatHex,
  formatUnits,
  getAddress,
  getCreate2Address,
  keccak256,
  type Address,
} from 'viem';
import type { Bindings } from '../types';
import { getWalletWithPrivateKey } from './wallet';
import { decryptString } from '../utils/crypto';
import { nowIso } from '../utils/time';

const POLYMARKET_CHAIN_ID = 137;
const DEFAULT_POLYMARKET_CLOB_HOST = 'https://clob.polymarket.com';
const POLYMARKET_USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PROXY_FACTORY_BY_CHAIN: Record<number, Address> = {
  137: '0xaB45c396F6C2f7AbdC10F267636b3650110c0f6a',
};
const PROXY_INIT_CODE_HASH_BY_CHAIN: Record<number, `0x${string}`> = {
  137: '0xa5f8ab95f5f9bf14f8453f0f81b21a61125ee9f4f7b4d489fe52d11ccef76c57',
};
const PREDICTION_BET_SLIPPAGE_BPS_DEFAULT = 100;
const PREDICTION_BET_SLIPPAGE_BPS_MAX = 5000;
const MESSAGE_TO_SIGN = 'This message attests that I control the given wallet';
const ZERO_HEX_32 = `0x${'00'.repeat(32)}` as const;
const SUPPORTED_TICK_SIZES = new Set<TickSize>(['0.1', '0.01', '0.001', '0.0001']);

type PredictionApiKeyCreds = {
  key: string;
  secret: string;
  passphrase: string;
};

type PredictionSignatureType = {
  label: 'proxy' | 'eoa' | 'gnosis-safe';
  numeric: ClobSignatureType;
};

type PredictionRuntimeContext = {
  host: string;
  signerAddress: Address;
  proxyAddress: Address;
  signer: ReturnType<typeof privateKeyToAccount>;
  ethersLikeSigner: {
    getAddress: () => Promise<string>;
    _signTypedData: (
      domain: Record<string, unknown>,
      types: Record<string, Array<{ name: string; type: string }>>,
      value: Record<string, unknown>,
    ) => Promise<string>;
  };
};

type BalanceAllowanceResponse = {
  balance?: string | number | null;
  allowance?: string | number | null;
  allowances?: Record<string, string | number>;
  error?: string;
  message?: string;
};

type PredictionOrderPostResponse = {
  success?: boolean;
  orderID?: string;
  orderId?: string;
  status?: string;
  error?: string;
  errorMsg?: string;
  makingAmount?: string;
  takingAmount?: string;
  transactionsHashes?: string[];
};

export type PredictionAccountSnapshot = {
  available: boolean;
  chainId: number;
  chain: 'polygon';
  signatureType: PredictionSignatureType['label'];
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

export type PredictionBetInput = {
  tokenId: string;
  amount: string;
  side?: 'buy' | 'sell';
  orderType?: 'fok' | 'fak';
  slippageBps?: number;
  signatureType?: 'proxy' | 'eoa' | 'gnosis-safe';
};

export type PredictionBetResult = {
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
  tickSize: TickSize;
  negRisk: boolean;
  feeRateBps: number;
  signatureType: PredictionSignatureType['label'];
  eoaAddress: string;
  proxyAddress: string;
};

function resolvePolymarketHost(env: Bindings): string {
  const host = (env.PREDICTION_CLOB_HOST ?? '').trim() || DEFAULT_POLYMARKET_CLOB_HOST;
  return host.replace(/\/+$/, '');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown_error';
}

function normalizeNonEmptyText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function normalizeNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeBigintString(raw: unknown): string | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return Math.trunc(raw).toString();
  }
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (!value) return null;
    try {
      return BigInt(value).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeTokenId(raw: unknown): string {
  const value = normalizeNonEmptyText(raw);
  if (!value || !/^\d+$/.test(value)) {
    throw new Error('invalid_prediction_token_id');
  }
  return value;
}

function parsePositiveDecimalInput(raw: unknown): { normalized: string; value: number } {
  const text = normalizeNonEmptyText(raw);
  if (!text || !/^\d+(\.\d+)?$/.test(text)) {
    throw new Error('invalid_prediction_amount');
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('invalid_prediction_amount');
  }
  return { normalized: text, value };
}

function clampSlippageBps(value: number | undefined): number {
  if (!Number.isFinite(Number(value))) return PREDICTION_BET_SLIPPAGE_BPS_DEFAULT;
  const normalized = Math.floor(Number(value));
  if (normalized < 0) return 0;
  if (normalized > PREDICTION_BET_SLIPPAGE_BPS_MAX) return PREDICTION_BET_SLIPPAGE_BPS_MAX;
  return normalized;
}

function resolveBetSide(value: unknown): 'buy' | 'sell' {
  const normalized = normalizeNonEmptyText(value)?.toLowerCase();
  if (normalized === 'sell') return 'sell';
  return 'buy';
}

function resolveBetOrderType(value: unknown): ClobOrderType.FOK | ClobOrderType.FAK {
  const normalized = normalizeNonEmptyText(value)?.toLowerCase();
  if (normalized === 'fak') return ClobOrderType.FAK;
  return ClobOrderType.FOK;
}

function resolvePredictionSignatureType(
  value: unknown,
  fallback: unknown,
): PredictionSignatureType {
  const normalized = normalizeNonEmptyText(value)?.toLowerCase()
    ?? normalizeNonEmptyText(fallback)?.toLowerCase()
    ?? 'proxy';
  if (normalized === 'eoa') {
    return { label: 'eoa', numeric: ClobSignatureType.EOA };
  }
  if (normalized === 'gnosis-safe' || normalized === 'gnosissafe' || normalized === 'safe') {
    return { label: 'gnosis-safe', numeric: ClobSignatureType.POLY_GNOSIS_SAFE };
  }
  return { label: 'proxy', numeric: ClobSignatureType.POLY_PROXY };
}

function normalizeTickSize(value: unknown): TickSize {
  const text = normalizeNonEmptyText(value);
  if (!text || !SUPPORTED_TICK_SIZES.has(text as TickSize)) {
    throw new Error('invalid_prediction_tick_size');
  }
  return text as TickSize;
}

function tickSizeDecimals(tickSize: TickSize): number {
  const parts = tickSize.split('.');
  return parts.length === 2 ? parts[1].length : 0;
}

function toRoundedPriceBySide(price: number, side: 'buy' | 'sell', tickSize: TickSize): number {
  const decimals = tickSizeDecimals(tickSize);
  const factor = 10 ** decimals;
  if (!Number.isFinite(factor) || factor <= 0) return price;
  if (side === 'buy') {
    return Math.ceil(price * factor) / factor;
  }
  return Math.floor(price * factor) / factor;
}

function applySlippageToPrice(
  price: number,
  side: 'buy' | 'sell',
  tickSize: TickSize,
  slippageBps: number,
): number {
  const tickValue = Number(tickSize);
  const maxPrice = 1 - tickValue;
  const multiplier = side === 'buy'
    ? 1 + slippageBps / 10_000
    : Math.max(0, 1 - slippageBps / 10_000);
  const adjusted = toRoundedPriceBySide(price * multiplier, side, tickSize);
  const bounded = Math.min(Math.max(adjusted, tickValue), maxPrice);
  if (!Number.isFinite(bounded) || bounded <= 0 || bounded >= 1) {
    throw new Error('invalid_prediction_market_price');
  }
  return Number(bounded.toFixed(tickSizeDecimals(tickSize)));
}

function deriveProxyAddress(signerAddress: Address): Address {
  const factoryAddress = PROXY_FACTORY_BY_CHAIN[POLYMARKET_CHAIN_ID];
  const initCodeHash = PROXY_INIT_CODE_HASH_BY_CHAIN[POLYMARKET_CHAIN_ID];
  if (!factoryAddress || !initCodeHash) {
    throw new Error('prediction_proxy_config_missing');
  }
  const salt = keccak256(concatHex([signerAddress as `0x${string}`, ZERO_HEX_32]));
  return getCreate2Address({
    from: factoryAddress,
    salt,
    bytecodeHash: initCodeHash,
  });
}

function createEthersLikeSigner(
  signer: ReturnType<typeof privateKeyToAccount>,
): PredictionRuntimeContext['ethersLikeSigner'] {
  return {
    getAddress: async () => signer.address,
    _signTypedData: async (domain, types, value) => {
      const normalizedTypes = { ...types };
      delete (normalizedTypes as Record<string, unknown>).EIP712Domain;
      const primaryType = Object.keys(normalizedTypes)[0];
      if (!primaryType) {
        throw new Error('invalid_prediction_typed_data');
      }
      return signer.signTypedData({
        domain: domain as never,
        types: normalizedTypes as never,
        primaryType: primaryType as never,
        message: value as never,
      } as never);
    },
  };
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const normalized = base64
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function buildPolyHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): Promise<string> {
  let message = `${timestamp}${method}${requestPath}`;
  if (body !== undefined) {
    message += body;
  }
  const keyData = base64ToArrayBuffer(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const input = new TextEncoder().encode(message);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, input);
  return arrayBufferToBase64(signature).replace(/\+/g, '-').replace(/\//g, '_');
}

async function buildL1Headers(
  signer: ReturnType<typeof privateKeyToAccount>,
  chainId = POLYMARKET_CHAIN_ID,
  nonce = 0,
  timestampSec = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const signature = await signer.signTypedData({
    domain: {
      name: 'ClobAuthDomain',
      version: '1',
      chainId,
    },
    types: {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    },
    primaryType: 'ClobAuth',
    message: {
      address: signer.address,
      timestamp: String(timestampSec),
      nonce: BigInt(nonce),
      message: MESSAGE_TO_SIGN,
    },
  } as never);

  return {
    POLY_ADDRESS: signer.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(timestampSec),
    POLY_NONCE: String(nonce),
  };
}

async function buildL2Headers(input: {
  signerAddress: string;
  creds: PredictionApiKeyCreds;
  method: string;
  requestPath: string;
  body?: string;
  timestampSec?: number;
}): Promise<Record<string, string>> {
  const timestampSec = input.timestampSec ?? Math.floor(Date.now() / 1000);
  const signature = await buildPolyHmacSignature(
    input.creds.secret,
    timestampSec,
    input.method.toUpperCase(),
    input.requestPath,
    input.body,
  );
  return {
    POLY_ADDRESS: input.signerAddress,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(timestampSec),
    POLY_API_KEY: input.creds.key,
    POLY_PASSPHRASE: input.creds.passphrase,
  };
}

async function predictionFetchJson<T>(
  host: string,
  path: string,
  init: RequestInit & { query?: URLSearchParams },
): Promise<T> {
  const url = new URL(path, host);
  if (init.query) {
    url.search = init.query.toString();
  }
  const response = await fetch(url.toString(), {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const detail = normalizeNonEmptyText(payload?.error)
      ?? normalizeNonEmptyText(payload?.message)
      ?? text.slice(0, 300)
      ?? `http_${response.status}`;
    throw new Error(`prediction_http_${response.status}:${detail}`);
  }
  if (payload == null) {
    throw new Error('prediction_invalid_response');
  }
  return payload as T;
}

function parseApiKeyCreds(payload: Record<string, unknown>): PredictionApiKeyCreds {
  const key = normalizeNonEmptyText(payload.apiKey) ?? normalizeNonEmptyText(payload.key);
  const secret = normalizeNonEmptyText(payload.secret);
  const passphrase = normalizeNonEmptyText(payload.passphrase);
  if (!key || !secret || !passphrase) {
    throw new Error('prediction_api_key_missing_fields');
  }
  return { key, secret, passphrase };
}

async function deriveOrCreateApiKey(
  host: string,
  signer: ReturnType<typeof privateKeyToAccount>,
): Promise<PredictionApiKeyCreds> {
  const headers = await buildL1Headers(signer, POLYMARKET_CHAIN_ID);
  try {
    const derived = await predictionFetchJson<Record<string, unknown>>(host, '/auth/derive-api-key', {
      method: 'GET',
      headers: {
        ...headers,
        Accept: 'application/json',
      },
    });
    return parseApiKeyCreds(derived);
  } catch {
    const created = await predictionFetchJson<Record<string, unknown>>(host, '/auth/api-key', {
      method: 'POST',
      headers: {
        ...headers,
        Accept: 'application/json',
      },
    });
    return parseApiKeyCreds(created);
  }
}

async function fetchTickSize(host: string, tokenId: string): Promise<TickSize> {
  const payload = await predictionFetchJson<Record<string, unknown>>(host, '/tick-size', {
    method: 'GET',
    query: new URLSearchParams({
      token_id: tokenId,
    }),
    headers: {
      Accept: 'application/json',
    },
  });
  return normalizeTickSize(payload.minimum_tick_size);
}

async function fetchNegRisk(host: string, tokenId: string): Promise<boolean> {
  const payload = await predictionFetchJson<Record<string, unknown>>(host, '/neg-risk', {
    method: 'GET',
    query: new URLSearchParams({
      token_id: tokenId,
    }),
    headers: {
      Accept: 'application/json',
    },
  });
  return payload.neg_risk === true;
}

async function fetchFeeRateBps(host: string, tokenId: string): Promise<number> {
  const payload = await predictionFetchJson<Record<string, unknown>>(host, '/fee-rate', {
    method: 'GET',
    query: new URLSearchParams({
      token_id: tokenId,
    }),
    headers: {
      Accept: 'application/json',
    },
  });
  const value = normalizeNumber(payload.base_fee);
  if (value == null || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

async function fetchReferencePrice(
  host: string,
  tokenId: string,
  side: 'buy' | 'sell',
): Promise<number> {
  const payload = await predictionFetchJson<Record<string, unknown>>(host, '/price', {
    method: 'GET',
    query: new URLSearchParams({
      token_id: tokenId,
      side,
    }),
    headers: {
      Accept: 'application/json',
    },
  });
  const price = normalizeNumber(payload.price);
  if (price == null || price <= 0 || price >= 1) {
    throw new Error('prediction_market_price_unavailable');
  }
  return price;
}

function buildBalanceAllowanceQuery(
  signatureType: ClobSignatureType,
  tokenId?: string,
): URLSearchParams {
  const query = new URLSearchParams();
  query.set('asset_type', 'COLLATERAL');
  query.set('signature_type', String(signatureType));
  if (tokenId) {
    query.set('token_id', tokenId);
  }
  return query;
}

async function fetchBalanceAllowance(
  context: PredictionRuntimeContext,
  creds: PredictionApiKeyCreds,
  signatureType: ClobSignatureType,
): Promise<BalanceAllowanceResponse> {
  const requestPath = '/balance-allowance';
  const headers = await buildL2Headers({
    signerAddress: context.signerAddress,
    creds,
    method: 'GET',
    requestPath,
  });
  return predictionFetchJson<BalanceAllowanceResponse>(context.host, requestPath, {
    method: 'GET',
    query: buildBalanceAllowanceQuery(signatureType),
    headers: {
      ...headers,
      Accept: 'application/json',
    },
  });
}

async function toPredictionRuntimeContext(
  env: Bindings,
  userId: string,
): Promise<PredictionRuntimeContext> {
  const wallet = await getWalletWithPrivateKey(env.DB, userId);
  if (!wallet) {
    throw new Error('wallet_not_found');
  }

  let privateKey: string;
  try {
    privateKey = await decryptString(wallet.encryptedPrivateKey, env.APP_SECRET);
  } catch {
    throw new Error('wallet_key_decryption_failed');
  }

  const signer = privateKeyToAccount(privateKey as `0x${string}`);
  const signerAddress = getAddress(signer.address);
  const proxyAddress = deriveProxyAddress(signerAddress);

  return {
    host: resolvePolymarketHost(env),
    signerAddress,
    proxyAddress,
    signer,
    ethersLikeSigner: createEthersLikeSigner(signer),
  };
}

function parseBalanceAllowance(raw: BalanceAllowanceResponse): {
  balanceRaw: string | null;
  allowanceRaw: string | null;
} {
  const balanceRaw = normalizeBigintString(raw.balance);
  const allowanceDirect = normalizeBigintString(raw.allowance);
  if (allowanceDirect) {
    return { balanceRaw, allowanceRaw: allowanceDirect };
  }
  const firstAllowance = raw.allowances
    ? Object.values(raw.allowances).map((value) => normalizeBigintString(value)).find((value): value is string => value != null)
    : null;
  return {
    balanceRaw,
    allowanceRaw: firstAllowance ?? null,
  };
}

function toDisplayUsdcAmount(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return formatUnits(BigInt(raw), 6);
  } catch {
    return null;
  }
}

function toOrderPayload(
  signedOrder: SignedOrder,
  ownerApiKey: string,
  orderType: ClobOrderType,
): {
  order: {
    salt: number;
    maker: string;
    signer: string;
    taker: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    side: ClobSide;
    expiration: string;
    nonce: string;
    feeRateBps: string;
    signatureType: number;
    signature: string;
  };
  owner: string;
  orderType: ClobOrderType;
  deferExec: boolean;
} {
  const side = signedOrder.side === 0 ? ClobSide.BUY : ClobSide.SELL;
  return {
    deferExec: false,
    orderType,
    owner: ownerApiKey,
    order: {
      salt: Number.parseInt(signedOrder.salt, 10),
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      taker: signedOrder.taker,
      tokenId: signedOrder.tokenId,
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
      side,
      expiration: signedOrder.expiration,
      nonce: signedOrder.nonce,
      feeRateBps: signedOrder.feeRateBps,
      signatureType: signedOrder.signatureType,
      signature: signedOrder.signature,
    },
  };
}

function parseOrderResult(payload: PredictionOrderPostResponse): {
  success: boolean;
  orderId: string | null;
  status: string | null;
  error: string | null;
  makingAmount: string | null;
  takingAmount: string | null;
  transactionsHashes: string[];
} {
  const orderId = normalizeNonEmptyText(payload.orderID) ?? normalizeNonEmptyText(payload.orderId);
  const success = payload.success === true || (payload.success == null && Boolean(orderId));
  const error = normalizeNonEmptyText(payload.errorMsg) ?? normalizeNonEmptyText(payload.error);
  return {
    success,
    orderId,
    status: normalizeNonEmptyText(payload.status),
    error,
    makingAmount: normalizeBigintString(payload.makingAmount),
    takingAmount: normalizeBigintString(payload.takingAmount),
    transactionsHashes: Array.isArray(payload.transactionsHashes)
      ? payload.transactionsHashes.map((item) => normalizeNonEmptyText(item)).filter((item): item is string => item != null)
      : [],
  };
}

export async function getPredictionAccount(
  env: Bindings,
  userId: string,
  input?: { signatureType?: 'proxy' | 'eoa' | 'gnosis-safe' },
): Promise<PredictionAccountSnapshot> {
  const context = await toPredictionRuntimeContext(env, userId);
  const signatureType = resolvePredictionSignatureType(input?.signatureType, env.PREDICTION_SIGNATURE_TYPE);
  const creds = await deriveOrCreateApiKey(context.host, context.signer);
  const rawBalance = await fetchBalanceAllowance(context, creds, signatureType.numeric);
  const parsed = parseBalanceAllowance(rawBalance);
  const balance = toDisplayUsdcAmount(parsed.balanceRaw);
  const allowance = toDisplayUsdcAmount(parsed.allowanceRaw);
  const balanceUsd = balance == null ? null : Number(balance);

  return {
    available: true,
    chainId: POLYMARKET_CHAIN_ID,
    chain: 'polygon',
    signatureType: signatureType.label,
    eoaAddress: context.signerAddress,
    proxyAddress: context.proxyAddress,
    depositAddress: context.proxyAddress,
    collateralSymbol: 'USDC',
    collateralTokenAddress: POLYMARKET_USDC_ADDRESS,
    collateralDecimals: 6,
    balanceRaw: parsed.balanceRaw,
    balance,
    balanceUsd: Number.isFinite(balanceUsd) ? balanceUsd : null,
    allowanceRaw: parsed.allowanceRaw,
    allowance,
    error: null,
    updatedAt: nowIso(),
  };
}

export async function getPredictionAccountSafe(
  env: Bindings,
  userId: string,
  input?: { signatureType?: 'proxy' | 'eoa' | 'gnosis-safe' },
): Promise<PredictionAccountSnapshot> {
  try {
    return await getPredictionAccount(env, userId, input);
  } catch (error) {
    return {
      available: false,
      chainId: POLYMARKET_CHAIN_ID,
      chain: 'polygon',
      signatureType: resolvePredictionSignatureType(input?.signatureType, env.PREDICTION_SIGNATURE_TYPE).label,
      eoaAddress: null,
      proxyAddress: null,
      depositAddress: null,
      collateralSymbol: 'USDC',
      collateralTokenAddress: POLYMARKET_USDC_ADDRESS,
      collateralDecimals: 6,
      balanceRaw: null,
      balance: null,
      balanceUsd: null,
      allowanceRaw: null,
      allowance: null,
      error: toErrorMessage(error),
      updatedAt: nowIso(),
    };
  }
}

export async function getPredictionDepositInfo(
  env: Bindings,
  userId: string,
): Promise<PredictionDepositInfo> {
  const context = await toPredictionRuntimeContext(env, userId);
  return {
    chainId: POLYMARKET_CHAIN_ID,
    chain: 'polygon',
    tokenSymbol: 'USDC',
    tokenAddress: POLYMARKET_USDC_ADDRESS,
    decimals: 6,
    depositAddress: context.proxyAddress,
    eoaAddress: context.signerAddress,
    proxyAddress: context.proxyAddress,
    note: 'Deposit USDC on Polygon to this address before placing prediction bets.',
  };
}

export async function placePredictionBet(
  env: Bindings,
  userId: string,
  input: PredictionBetInput,
): Promise<PredictionBetResult> {
  const tokenId = normalizeTokenId(input.tokenId);
  const amountInput = parsePositiveDecimalInput(input.amount);
  const side = resolveBetSide(input.side);
  const orderType = resolveBetOrderType(input.orderType);
  const slippageBps = clampSlippageBps(input.slippageBps);
  const context = await toPredictionRuntimeContext(env, userId);
  const signatureType = resolvePredictionSignatureType(input.signatureType, env.PREDICTION_SIGNATURE_TYPE);
  const creds = await deriveOrCreateApiKey(context.host, context.signer);

  const [tickSize, negRisk, feeRateBps, referencePrice] = await Promise.all([
    fetchTickSize(context.host, tokenId),
    fetchNegRisk(context.host, tokenId),
    fetchFeeRateBps(context.host, tokenId),
    fetchReferencePrice(context.host, tokenId, side),
  ]);
  const priceUsed = applySlippageToPrice(referencePrice, side, tickSize, slippageBps);
  const funder = signatureType.label === 'proxy' ? context.proxyAddress : context.signerAddress;
  const orderBuilder = new OrderBuilder(
    context.ethersLikeSigner,
    POLYMARKET_CHAIN_ID,
    signatureType.numeric,
    funder,
  );
  const signedOrder = await orderBuilder.buildMarketOrder(
    {
      tokenID: tokenId,
      side: side === 'buy' ? ClobSide.BUY : ClobSide.SELL,
      amount: amountInput.value,
      price: priceUsed,
      feeRateBps,
      orderType,
    },
    {
      tickSize,
      negRisk,
    },
  );
  const orderPayload = toOrderPayload(signedOrder, creds.key, orderType);
  const body = JSON.stringify(orderPayload);
  const headers = await buildL2Headers({
    signerAddress: context.signerAddress,
    creds,
    method: 'POST',
    requestPath: '/order',
    body,
  });
  const response = await predictionFetchJson<PredictionOrderPostResponse>(context.host, '/order', {
    method: 'POST',
    headers: {
      ...headers,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
  });
  const parsed = parseOrderResult(response);
  if (!parsed.success) {
    throw new Error(parsed.error ?? 'prediction_order_rejected');
  }

  return {
    success: true,
    orderId: parsed.orderId,
    status: parsed.status,
    makingAmount: parsed.makingAmount,
    takingAmount: parsed.takingAmount,
    transactionsHashes: parsed.transactionsHashes,
    side,
    amount: amountInput.normalized,
    tokenId,
    priceUsed,
    tickSize,
    negRisk,
    feeRateBps,
    signatureType: signatureType.label,
    eoaAddress: context.signerAddress,
    proxyAddress: context.proxyAddress,
  };
}
