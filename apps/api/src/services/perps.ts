import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import type { ExchangeSingleWalletConfig } from '@nktkas/hyperliquid';
import type { AbstractWallet } from '@nktkas/hyperliquid/signing';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  Bindings,
  PerpsAccountSnapshot,
  PerpsCancelOrderRequest,
  PerpsCancelOrderResponse,
  PerpsOpenOrderSnapshot,
  PerpsOrderRequest,
  PerpsOrderResponse,
  PerpsPositionSnapshot,
  WalletSummary,
} from '../types';
import { ensureWalletForUser, ensureWalletWithPrivateKey } from './wallet';
import { decryptString } from '../utils/crypto';
import { nowIso } from '../utils/time';

const DEFAULT_HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz';
const DEFAULT_PERPS_SLIPPAGE_BPS = 100;
const META_CACHE_TTL_MS = 60_000;

type CachedUniverse = {
  expiresAt: number;
  value: Map<string, UniverseEntry>;
};

type UniverseEntry = {
  asset: number;
  coin: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  marginMode: 'strictIsolated' | 'noCross' | null;
  markPx: number | null;
  oraclePx: number | null;
};

let cachedUniverse: CachedUniverse | null = null;
let cachedUniverseInFlight: Promise<Map<string, UniverseEntry>> | null = null;

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function toFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function resolveHyperliquidTransport(env: Bindings): HttpTransport {
  const customApiUrl = normalizeText(env.HYPERLIQUID_API_URL);
  const isTestnet = ['1', 'true', 'yes', 'on'].includes((env.HYPERLIQUID_TESTNET ?? '').trim().toLowerCase());
  return new HttpTransport({
    apiUrl: customApiUrl ?? DEFAULT_HYPERLIQUID_API_URL,
    isTestnet,
    timeout: 12_000,
  });
}

function createInfoClient(env: Bindings): InfoClient {
  return new InfoClient({
    transport: resolveHyperliquidTransport(env),
  });
}

async function buildExchangeClient(env: Bindings, userId: string): Promise<{
  exchange: ExchangeClient<ExchangeSingleWalletConfig>;
  userAddress: Address;
}> {
  const walletWithKey = await ensureWalletWithPrivateKey(env, userId);
  let privateKey: string;
  try {
    privateKey = await decryptString(walletWithKey.encryptedPrivateKey, env.APP_SECRET);
  } catch {
    throw new Error('wallet_key_decryption_failed');
  }
  const signer = privateKeyToAccount(privateKey as `0x${string}`);
  const exchangeWallet = {
    ...signer,
    address: signer.address as Address,
  } as AbstractWallet;
  return {
    exchange: new ExchangeClient<ExchangeSingleWalletConfig>({
      transport: resolveHyperliquidTransport(env),
      wallet: exchangeWallet,
    }),
    userAddress: signer.address as Address,
  };
}

function resolvePerpsUserAddress(wallet: WalletSummary | null): Address | null {
  const evmAddress = wallet?.chainAccounts.find((item) => item.protocol === 'evm')?.address ?? wallet?.address ?? null;
  const normalized = normalizeText(evmAddress);
  if (!normalized?.startsWith('0x')) return null;
  return normalized as Address;
}

async function getUniverseMap(env: Bindings): Promise<Map<string, UniverseEntry>> {
  const now = Date.now();
  if (cachedUniverse && cachedUniverse.expiresAt > now) {
    return cachedUniverse.value;
  }
  if (cachedUniverseInFlight) {
    return cachedUniverseInFlight;
  }

  const task = (async () => {
    const info = createInfoClient(env);
    const [meta, ctxs] = await info.metaAndAssetCtxs();
    const output = new Map<string, UniverseEntry>();
    const maxLength = Math.min(meta.universe.length, ctxs.length);
    for (let index = 0; index < maxLength; index += 1) {
      const item = meta.universe[index];
      const ctx = ctxs[index];
      const coin = normalizeText(item.name)?.toUpperCase();
      if (!coin) continue;
      output.set(coin, {
        asset: index,
        coin,
        szDecimals: item.szDecimals,
        maxLeverage: item.maxLeverage,
        onlyIsolated: item.onlyIsolated === true || item.marginMode === 'strictIsolated' || item.marginMode === 'noCross',
        marginMode: item.marginMode ?? null,
        markPx: toFiniteNumber(ctx.markPx) ?? toFiniteNumber(ctx.midPx) ?? toFiniteNumber(ctx.oraclePx),
        oraclePx: toFiniteNumber(ctx.oraclePx),
      });
    }
    cachedUniverse = {
      expiresAt: Date.now() + META_CACHE_TTL_MS,
      value: output,
    };
    return output;
  })().finally(() => {
    cachedUniverseInFlight = null;
  });

  cachedUniverseInFlight = task;
  return task;
}

function resolvePerpsSlippageBps(env: Bindings, input?: number): number {
  if (Number.isFinite(Number(input))) {
    const normalized = Math.floor(Number(input));
    if (normalized >= 5 && normalized <= 2_000) return normalized;
  }

  const fromEnv = Number(env.HYPERLIQUID_DEFAULT_SLIPPAGE_BPS);
  if (Number.isFinite(fromEnv)) {
    const normalized = Math.floor(fromEnv);
    if (normalized >= 5 && normalized <= 2_000) return normalized;
  }

  return DEFAULT_PERPS_SLIPPAGE_BPS;
}

function resolveMarginMode(raw: unknown): 'cross' | 'isolated' {
  return normalizeText(raw)?.toLowerCase() === 'isolated' ? 'isolated' : 'cross';
}

function resolveOrderSide(raw: unknown): 'long' | 'short' {
  return normalizeText(raw)?.toLowerCase() === 'short' ? 'short' : 'long';
}

function resolveOrderType(raw: unknown): 'market' | 'limit' {
  return normalizeText(raw)?.toLowerCase() === 'limit' ? 'limit' : 'market';
}

function normalizePositiveDecimalString(raw: unknown, field: string): string {
  const value = normalizeText(raw);
  if (!value || !/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`invalid_${field}`);
  }
  return value.replace(/^0+(?=\d)/, '') || '0';
}

function normalizeSizeForCoin(raw: string, decimals: number): string {
  const value = normalizePositiveDecimalString(raw, 'perps_size');
  const [, fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new Error('invalid_perps_size_precision');
  }
  return value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function normalizeLeverage(raw: unknown, maxLeverage: number): number | null {
  if (!Number.isFinite(Number(raw))) return null;
  const value = Math.floor(Number(raw));
  if (value < 1) throw new Error('invalid_perps_leverage');
  return Math.min(value, maxLeverage);
}

function toOrderPriceString(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('invalid_perps_order_price');
  }
  const decimals =
    value >= 10_000 ? 0
      : value >= 1_000 ? 1
        : value >= 100 ? 2
          : value >= 1 ? 4
            : 6;
  return value.toFixed(decimals).replace(/\.?0+$/, '');
}

async function resolveMarketablePrice(
  env: Bindings,
  coin: string,
  side: 'long' | 'short',
  slippageBps: number,
): Promise<string> {
  const info = createInfoClient(env);
  const [book, universe] = await Promise.all([
    info.l2Book({ coin }).catch(() => null),
    getUniverseMap(env),
  ]);
  const universeEntry = universe.get(coin);
  const bestPrice = side === 'long'
    ? toFiniteNumber(book?.levels?.[1]?.[0]?.px) ?? universeEntry?.markPx ?? universeEntry?.oraclePx ?? null
    : toFiniteNumber(book?.levels?.[0]?.[0]?.px) ?? universeEntry?.markPx ?? universeEntry?.oraclePx ?? null;
  if (!bestPrice || bestPrice <= 0) {
    throw new Error('perps_price_unavailable');
  }
  const multiplier = side === 'long'
    ? 1 + (slippageBps / 10_000)
    : Math.max(0.01, 1 - (slippageBps / 10_000));
  return toOrderPriceString(bestPrice * multiplier);
}

function mapPosition(input: {
  coin: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: number | null;
  markPrice: number | null;
  positionValueUsd: number | null;
  unrealizedPnlUsd: number | null;
  returnOnEquityPct: number | null;
  liquidationPrice: number | null;
  marginUsedUsd: number | null;
  leverageType: 'cross' | 'isolated';
  leverageValue: number | null;
  maxLeverage: number | null;
}): PerpsPositionSnapshot {
  const notionalUsd = input.positionValueUsd != null ? Math.abs(input.positionValueUsd) : null;
  return {
    coin: input.coin,
    size: input.size,
    side: input.side,
    entryPrice: input.entryPrice,
    markPrice: input.markPrice,
    positionValueUsd: input.positionValueUsd,
    notionalUsd,
    unrealizedPnlUsd: input.unrealizedPnlUsd,
    returnOnEquityPct: input.returnOnEquityPct == null ? null : input.returnOnEquityPct * 100,
    liquidationPrice: input.liquidationPrice,
    marginUsedUsd: input.marginUsedUsd,
    leverageType: input.leverageType,
    leverageValue: input.leverageValue,
    maxLeverage: input.maxLeverage,
  };
}

function mapOpenOrder(input: {
  coin: string;
  side: 'long' | 'short';
  limitPrice: number | null;
  size: string;
  originalSize: string;
  orderId: number;
  timestamp: number;
  reduceOnly: boolean;
}): PerpsOpenOrderSnapshot {
  return {
    coin: input.coin,
    side: input.side,
    limitPrice: input.limitPrice,
    size: input.size,
    originalSize: input.originalSize,
    orderId: input.orderId,
    timestamp: input.timestamp,
    reduceOnly: input.reduceOnly,
  };
}

export async function getPerpsAccount(env: Bindings, userId: string): Promise<PerpsAccountSnapshot> {
  const wallet = await ensureWalletForUser(env, userId);
  const userAddress = resolvePerpsUserAddress(wallet);
  if (!userAddress) {
    return {
      available: false,
      provider: 'hyperliquid',
      userAddress: null,
      balanceUsd: null,
      withdrawableUsd: null,
      marginUsedUsd: null,
      totalPositionNotionalUsd: null,
      unrealizedPnlUsd: null,
      openOrderCount: 0,
      positions: [],
      openOrders: [],
      error: 'wallet_not_found',
      updatedAt: nowIso(),
    };
  }

  const info = createInfoClient(env);
  const universe = await getUniverseMap(env).catch(() => new Map<string, UniverseEntry>());
  const [accountState, openOrders] = await Promise.all([
    info.clearinghouseState({ user: userAddress }),
    info.openOrders({ user: userAddress }).catch(() => []),
  ]);

  const positions = accountState.assetPositions.flatMap((row) => {
    const position = row.position;
    const numericSize = toFiniteNumber(position.szi);
    if (!numericSize || numericSize === 0) return [];
    const coin = normalizeText(position.coin)?.toUpperCase();
    if (!coin) return [];
    const universeEntry = universe.get(coin);
    return [
      mapPosition({
        coin,
        side: numericSize >= 0 ? 'long' : 'short',
        size: String(Math.abs(numericSize)),
        entryPrice: toFiniteNumber(position.entryPx),
        markPrice: universeEntry?.markPx ?? universeEntry?.oraclePx ?? null,
        positionValueUsd: toFiniteNumber(position.positionValue),
        unrealizedPnlUsd: toFiniteNumber(position.unrealizedPnl),
        returnOnEquityPct: toFiniteNumber(position.returnOnEquity),
        liquidationPrice: toFiniteNumber(position.liquidationPx),
        marginUsedUsd: toFiniteNumber(position.marginUsed),
        leverageType: position.leverage.type === 'isolated' ? 'isolated' : 'cross',
        leverageValue: toFiniteNumber(position.leverage.value),
        maxLeverage: toFiniteNumber(position.maxLeverage),
      }),
    ];
  });

  const mappedOrders = openOrders.map((order) => mapOpenOrder({
    coin: normalizeText(order.coin)?.toUpperCase() ?? '--',
    side: order.side === 'A' ? 'short' : 'long',
    limitPrice: toFiniteNumber(order.limitPx),
    size: order.sz,
    originalSize: order.origSz,
    orderId: order.oid,
    timestamp: order.timestamp,
    reduceOnly: order.reduceOnly === true,
  }));

  const unrealizedPnlUsd = positions.reduce((sum, item) => sum + Number(item.unrealizedPnlUsd ?? 0), 0);
  return {
    available: true,
    provider: 'hyperliquid',
    userAddress,
    balanceUsd: toFiniteNumber(accountState.marginSummary.accountValue),
    withdrawableUsd: toFiniteNumber(accountState.withdrawable),
    marginUsedUsd: toFiniteNumber(accountState.marginSummary.totalMarginUsed),
    totalPositionNotionalUsd: toFiniteNumber(accountState.marginSummary.totalNtlPos),
    unrealizedPnlUsd: Number.isFinite(unrealizedPnlUsd) ? unrealizedPnlUsd : null,
    openOrderCount: mappedOrders.length,
    positions,
    openOrders: mappedOrders,
    error: null,
    updatedAt: nowIso(),
  };
}

export async function getPerpsAccountSafe(env: Bindings, userId: string): Promise<PerpsAccountSnapshot> {
  try {
    return await getPerpsAccount(env, userId);
  } catch (error) {
    return {
      available: false,
      provider: 'hyperliquid',
      userAddress: null,
      balanceUsd: null,
      withdrawableUsd: null,
      marginUsedUsd: null,
      totalPositionNotionalUsd: null,
      unrealizedPnlUsd: null,
      openOrderCount: 0,
      positions: [],
      openOrders: [],
      error: error instanceof Error ? error.message : 'perps_account_unavailable',
      updatedAt: nowIso(),
    };
  }
}

function extractOrderStatus(status: unknown): {
  status: PerpsOrderResponse['status'];
  orderId: number | null;
  avgFillPrice: string | null;
  totalFilledSize: string | null;
} {
  if (status === 'waitingForFill') {
    return { status: 'waitingForFill', orderId: null, avgFillPrice: null, totalFilledSize: null };
  }
  if (status === 'waitingForTrigger') {
    return { status: 'waitingForTrigger', orderId: null, avgFillPrice: null, totalFilledSize: null };
  }
  if (status && typeof status === 'object' && 'filled' in status) {
    const filled = (status as { filled: { oid: number; avgPx: string; totalSz: string } }).filled;
    return {
      status: 'filled',
      orderId: filled.oid,
      avgFillPrice: filled.avgPx,
      totalFilledSize: filled.totalSz,
    };
  }
  if (status && typeof status === 'object' && 'resting' in status) {
    const resting = (status as { resting: { oid: number } }).resting;
    return {
      status: 'resting',
      orderId: resting.oid,
      avgFillPrice: null,
      totalFilledSize: null,
    };
  }
  if (status && typeof status === 'object' && 'error' in status) {
    const error = normalizeText((status as { error?: unknown }).error) ?? 'perps_order_failed';
    throw new Error(error);
  }
  throw new Error('perps_order_failed');
}

export async function placePerpsOrder(
  env: Bindings,
  userId: string,
  input: PerpsOrderRequest,
): Promise<PerpsOrderResponse> {
  const coin = normalizeText(input.coin)?.toUpperCase();
  if (!coin) {
    throw new Error('invalid_perps_coin');
  }

  const universe = await getUniverseMap(env);
  const universeEntry = universe.get(coin);
  if (!universeEntry) {
    throw new Error('invalid_perps_coin');
  }

  const side = resolveOrderSide(input.side);
  const marginMode = resolveMarginMode(input.marginMode);
  if (marginMode === 'cross' && universeEntry.onlyIsolated) {
    throw new Error('perps_cross_margin_unsupported');
  }

  const size = normalizeSizeForCoin(input.size, universeEntry.szDecimals);
  const orderType = resolveOrderType(input.orderType);
  const reduceOnly = input.reduceOnly === true;
  const leverage = normalizeLeverage(input.leverage, universeEntry.maxLeverage);
  const { exchange } = await buildExchangeClient(env, userId);

  if (leverage != null) {
    await exchange.updateLeverage({
      asset: universeEntry.asset,
      isCross: marginMode === 'cross',
      leverage,
    });
  }

  let limitPrice: string;
  if (orderType === 'limit') {
    limitPrice = normalizePositiveDecimalString(input.limitPrice, 'perps_limit_price');
  } else {
    limitPrice = await resolveMarketablePrice(
      env,
      coin,
      side,
      resolvePerpsSlippageBps(env, input.slippageBps),
    );
  }

  const result = await exchange.order({
    orders: [{
      a: universeEntry.asset,
      b: side === 'long',
      p: limitPrice,
      s: size,
      r: reduceOnly,
      t: { limit: { tif: orderType === 'market' ? 'FrontendMarket' : 'Gtc' } },
    }],
    grouping: 'na',
  });

  const primaryStatus = result.response.data.statuses[0];
  const parsed = extractOrderStatus(primaryStatus);
  return {
    success: true,
    coin,
    side,
    size,
    orderType,
    limitPrice,
    reduceOnly,
    leverage,
    marginMode,
    orderId: parsed.orderId,
    status: parsed.status,
    avgFillPrice: parsed.avgFillPrice,
    totalFilledSize: parsed.totalFilledSize,
    updatedAt: nowIso(),
  };
}

export async function cancelPerpsOrder(
  env: Bindings,
  userId: string,
  input: PerpsCancelOrderRequest,
): Promise<PerpsCancelOrderResponse> {
  const coin = normalizeText(input.coin)?.toUpperCase();
  if (!coin) {
    throw new Error('invalid_perps_coin');
  }
  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('invalid_perps_order_id');
  }

  const universe = await getUniverseMap(env);
  const universeEntry = universe.get(coin);
  if (!universeEntry) {
    throw new Error('invalid_perps_coin');
  }

  const { exchange } = await buildExchangeClient(env, userId);
  await exchange.cancel({
    cancels: [{
      a: universeEntry.asset,
      o: Math.floor(orderId),
    }],
  });

  return {
    success: true,
    coin,
    orderId: Math.floor(orderId),
    updatedAt: nowIso(),
  };
}
