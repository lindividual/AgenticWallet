import type { Bindings } from '../types';
import { nowIso } from '../utils/time';
import { fetchWithTimeout } from '../utils/fetch';
import { getChainConfigByChainId, getMarketChainByChainId, getMarketChainByNetworkKey } from '../config/appConfig';
import { buildAssetId, buildChainAssetId, inferProtocolFromChain, NATIVE_CONTRACT_KEY, toContractKey } from './assetIdentity';
import { resolveCoinGeckoAssetIdForContract } from './coingecko';
import { fetchSolanaPortfolio as fetchSolanaPortfolioViaRpc } from './solana';
import type { WalletSummary } from '../types';
import { BITCOIN_NETWORK_KEY, SOLANA_NETWORK_KEY, TRON_NETWORK_KEY } from './wallet';

type PortfolioBalanceRow = {
  protocol?: 'evm' | 'svm' | 'tvm' | 'btc';
  network_key: string;
  chain: string;
  chain_id: number | null;
  address: string;
  asset_id?: string;
  chain_asset_id?: string;
  amount: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  price_usd?: number | null;
  value_usd?: number | null;
  logo?: string | null;
  logo_uri?: string | null;
  url?: string | null;
  token_metadata?: {
    logo?: string | null;
    logoURI?: string | null;
    url?: string | null;
  };
};

export type MergedHoldingVariant = PortfolioBalanceRow & {
  market_chain: string;
  contract_key: string;
  chain_asset_id: string;
  asset_id: string;
};

export type MergedPortfolioHolding = {
  asset_id: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  total_value_usd: number;
  variants: MergedHoldingVariant[];
};

type SimBalancesResponse = {
  wallet_address: string;
  balances: PortfolioBalanceRow[];
  error?: string;
  message?: string;
};

type SimSvmBalanceRow = {
  chain?: string;
  address?: string;
  amount?: string;
  value_usd?: number | string | null;
  decimals?: number | string;
  name?: string;
  symbol?: string;
  price_usd?: number | string | null;
  uri?: string | null;
};

type SimSvmBalancesResponse = {
  wallet_address?: string;
  balances?: SimSvmBalanceRow[];
  next_offset?: string | null;
  error?: string;
  message?: string;
};

type BitcoinAddressStats = {
  funded_txo_sum?: number;
  spent_txo_sum?: number;
};

type BitcoinAddressResponse = {
  chain_stats?: BitcoinAddressStats;
  mempool_stats?: BitcoinAddressStats;
};

type TronScanTokenRow = {
  amount?: string | number | null;
  quantity?: string | number | null;
  tokenId?: string | null;
  tokenName?: string | null;
  tokenAbbr?: string | null;
  tokenLogo?: string | null;
  tokenPriceInUsd?: string | number | null;
  amountInUsd?: string | number | null;
  balance?: string | number | null;
  tokenDecimal?: string | number | null;
  tokenType?: string | null;
};

type TronScanAccountTokensResponse = {
  total?: string | number | null;
  data?: TronScanTokenRow[];
};

const FALLBACK_ASSET_NAME_BY_ID: Record<string, string> = {
  'coingecko:ethereum': 'Ethereum',
  'coingecko:binancecoin': 'BNB',
  'coingecko:tron': 'TRON',
  'coingecko:bitcoin': 'Bitcoin',
  'coingecko:tether': 'Tether',
  'coingecko:usd-coin': 'USD Coin',
};

const FALLBACK_ASSET_NAME_BY_SYMBOL: Record<string, string> = {
  ETH: 'Ethereum',
  BNB: 'BNB',
  TRX: 'TRON',
  BTC: 'Bitcoin',
  USDT: 'Tether',
  USDC: 'USD Coin',
};
const PORTFOLIO_FETCH_TIMEOUT_MS = 15_000;

function normalizeEvmAddress(raw: string | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  return normalized;
}

function normalizeBase58(raw: string | undefined): string | null {
  const normalized = normalizeText(raw);
  return normalized ?? null;
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeAssetId(raw: unknown): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  return value.toLowerCase();
}

function resolveHoldingLogo(row: PortfolioBalanceRow): string | null {
  return (
    normalizeText(row.logo) ??
    normalizeText(row.logo_uri) ??
    normalizeText(row.url) ??
    normalizeText(row.token_metadata?.logo) ??
    normalizeText(row.token_metadata?.logoURI) ??
    normalizeText(row.token_metadata?.url)
  );
}

function normalizeMarketChain(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value === 'ethereum') return 'eth';
  if (value === 'bsc' || value === 'binance-smart-chain') return 'bnb';
  if (value === 'trx' || value === 'trc20') return 'tron';
  return value;
}

function resolveHoldingMarketChain(row: PortfolioBalanceRow): string {
  const fromNetworkKey = getMarketChainByNetworkKey(row.network_key);
  if (fromNetworkKey) return fromNetworkKey;
  const fromConfig = row.chain_id != null ? getMarketChainByChainId(Number(row.chain_id)) : null;
  if (fromConfig) return fromConfig;
  return normalizeMarketChain(row.chain);
}

function resolveHoldingContractKey(row: PortfolioBalanceRow): string {
  const marketChain = resolveHoldingMarketChain(row);
  const protocol = row.protocol ?? inferProtocolFromChain(marketChain);
  if (protocol === 'svm') {
    const address = normalizeBase58(row.address);
    if (!address || address === NATIVE_CONTRACT_KEY) return NATIVE_CONTRACT_KEY;
    return address;
  }
  if (protocol === 'tvm') {
    const address = normalizeText(row.address);
    if (!address || address === NATIVE_CONTRACT_KEY) return NATIVE_CONTRACT_KEY;
    return address;
  }
  if (protocol === 'btc') {
    const address = normalizeText(row.address);
    if (!address || address === NATIVE_CONTRACT_KEY) return NATIVE_CONTRACT_KEY;
    return address.toLowerCase();
  }

  const address = normalizeEvmAddress(row.address);
  if (!address || /^0x0{40}$/.test(address)) return NATIVE_CONTRACT_KEY;
  return address;
}

function resolveManualAssetIdOverride(marketChain: string, contractKey: string): string | null {
  // Manual normalization: treat BNB bridged USDC as canonical USDC for wallet aggregation.
  if (marketChain === 'bnb' && contractKey === '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d') {
    return 'coingecko:usd-coin';
  }
  return null;
}

function hasPositiveAmount(rawAmount: string | undefined): boolean {
  if (!rawAmount) return false;
  const normalized = rawAmount.trim();
  if (!normalized || normalized === '0') return false;
  if (/^\d+$/.test(normalized)) {
    return BigInt(normalized) > 0n;
  }
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) && asNumber > 0;
}

function resolveFallbackAssetName(assetId: string | null | undefined, symbol: string | null | undefined): string | null {
  const normalizedAssetId = normalizeAssetId(assetId);
  if (normalizedAssetId && FALLBACK_ASSET_NAME_BY_ID[normalizedAssetId]) {
    return FALLBACK_ASSET_NAME_BY_ID[normalizedAssetId];
  }
  const normalizedSymbol = normalizeText(symbol)?.toUpperCase();
  if (!normalizedSymbol) return null;
  return FALLBACK_ASSET_NAME_BY_SYMBOL[normalizedSymbol] ?? null;
}

async function fetchEvmPortfolio(
  env: Bindings,
  walletAddress: string,
): Promise<PortfolioBalanceRow[]> {
  const simApiKey = env.SIM_API_KEY?.trim();
  if (!simApiKey) {
    return [];
  }

  const chainIds = [1, 8453, 56].join(',');
  const simResponse = await fetchWithTimeout(
    `https://api.sim.dune.com/v1/evm/balances/${walletAddress}?metadata=logo,url&chain_ids=${encodeURIComponent(chainIds)}`,
    {
      method: 'GET',
      headers: {
        'X-Sim-Api-Key': simApiKey,
      },
    },
    PORTFOLIO_FETCH_TIMEOUT_MS,
  );

  const simData = (await simResponse.json()) as SimBalancesResponse;
  if (!simResponse.ok) {
    throw new Error(simData.message ?? simData.error ?? 'failed_to_fetch_portfolio');
  }

  return (simData.balances ?? [])
    .map((row) => ({
      ...row,
      network_key: getChainConfigByChainId(Number(row.chain_id))?.networkKey ?? `evm:${String(row.chain_id)}`,
      protocol: 'evm' as const,
    }))
    .filter((row) => Number(row.value_usd ?? 0) > 0 || hasPositiveAmount(row.amount))
    .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
}

async function fetchSolanaPortfolioViaSim(
  env: Bindings,
  walletAddress: string,
): Promise<PortfolioBalanceRow[]> {
  const simApiKey = env.SIM_API_KEY?.trim();
  if (!simApiKey) {
    throw new Error('missing_sim_api_key');
  }

  const balances: PortfolioBalanceRow[] = [];
  let nextOffset: string | null = null;

  do {
    const url = new URL(`https://api.sim.dune.com/beta/svm/balances/${encodeURIComponent(walletAddress)}`);
    url.searchParams.set('chains', 'solana');
    url.searchParams.set('limit', '1000');
    if (nextOffset) {
      url.searchParams.set('offset', nextOffset);
    }

    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: {
          'X-Sim-Api-Key': simApiKey,
        },
      },
      PORTFOLIO_FETCH_TIMEOUT_MS,
    );

    const payload = (await response.json()) as SimSvmBalancesResponse;
    if (!response.ok) {
      throw new Error(payload.message ?? payload.error ?? 'failed_to_fetch_solana_portfolio');
    }

    balances.push(
      ...(payload.balances ?? [])
        .map((row) => {
          const contractKey = toContractKey(row.address, 'sol');
          return {
            protocol: 'svm' as const,
            network_key: SOLANA_NETWORK_KEY,
            chain: 'sol',
            chain_id: null,
            address: contractKey,
            asset_id: buildAssetId('sol', contractKey),
            chain_asset_id: buildChainAssetId('sol', contractKey),
            amount: normalizeText(row.amount) ?? '0',
            symbol: normalizeText(row.symbol) ?? undefined,
            name: normalizeText(row.name) ?? undefined,
            decimals: normalizeFiniteNumber(row.decimals) ?? undefined,
            price_usd: normalizeFiniteNumber(row.price_usd),
            value_usd: normalizeFiniteNumber(row.value_usd),
            logo: null,
            logo_uri: null,
            url: null,
          } satisfies PortfolioBalanceRow;
        })
        .filter((row) => Number(row.value_usd ?? 0) > 0 || hasPositiveAmount(row.amount)),
    );

    nextOffset = normalizeText(payload.next_offset);
  } while (nextOffset);

  return balances.sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
}

async function fetchSolanaPortfolio(
  env: Bindings,
  walletAddress: string,
): Promise<PortfolioBalanceRow[]> {
  try {
    return await fetchSolanaPortfolioViaSim(env, walletAddress);
  } catch (error) {
    console.warn('[wallet/portfolio][solana] sim_failed_fallback_rpc', {
      walletAddress,
      message: error instanceof Error ? error.message : 'unknown_error',
    });
    return fetchSolanaPortfolioViaRpc(env, walletAddress);
  }
}

function normalizeTronTokenType(raw: unknown): string | null {
  const value = normalizeText(raw)?.toLowerCase();
  return value || null;
}

function isSupportedTronTokenType(raw: unknown): boolean {
  const tokenType = normalizeTronTokenType(raw);
  return tokenType === 'trc10' || tokenType === 'trc20';
}

function resolveTronContractKey(row: TronScanTokenRow): string {
  const tokenId = normalizeText(row.tokenId);
  const symbol = normalizeText(row.tokenAbbr)?.toUpperCase();
  if (!tokenId || tokenId === '_' || symbol === 'TRX') {
    return NATIVE_CONTRACT_KEY;
  }
  return toContractKey(tokenId, 'tron');
}

function resolveTronValueUsd(row: TronScanTokenRow): number | null {
  const direct = normalizeFiniteNumber(row.amountInUsd);
  if (direct != null) return direct;
  const quantity = normalizeFiniteNumber(row.quantity ?? row.amount);
  const price = normalizeFiniteNumber(row.tokenPriceInUsd);
  if (quantity != null && price != null) {
    return quantity * price;
  }
  return null;
}

async function fetchTronPortfolio(
  env: Bindings,
  walletAddress: string,
): Promise<PortfolioBalanceRow[]> {
  const tronScanApiKey = env.TRONSCAN_API_KEY?.trim();
  if (!tronScanApiKey) {
    return [];
  }

  const balances: PortfolioBalanceRow[] = [];
  let start = 0;
  let total = Number.POSITIVE_INFINITY;
  const limit = 200;

  while (start < total) {
    const url = new URL('https://apilist.tronscanapi.com/api/account/tokens');
    url.searchParams.set('address', walletAddress);
    url.searchParams.set('start', String(start));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('hidden', '0');
    url.searchParams.set('show', '0');
    url.searchParams.set('sortType', '0');
    url.searchParams.set('sortBy', '2');
    url.searchParams.set('assetType', '1');

    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'TRON-PRO-API-KEY': tronScanApiKey,
        },
      },
      PORTFOLIO_FETCH_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`failed_to_fetch_tron_portfolio:${response.status}`);
    }

    const payload = (await response.json()) as TronScanAccountTokensResponse;
    const rows = Array.isArray(payload.data) ? payload.data : [];
    total = Math.max(normalizeFiniteNumber(payload.total) ?? rows.length, rows.length);

    balances.push(
      ...rows
        .filter((row) => isSupportedTronTokenType(row.tokenType))
        .map((row) => {
          const contractKey = resolveTronContractKey(row);
          const priceUsd = normalizeFiniteNumber(row.tokenPriceInUsd);
          const valueUsd = resolveTronValueUsd(row);
          return {
            protocol: 'tvm' as const,
            network_key: TRON_NETWORK_KEY,
            chain: 'tron',
            chain_id: null,
            address: contractKey,
            asset_id: buildAssetId('tron', contractKey),
            chain_asset_id: buildChainAssetId('tron', contractKey),
            amount: normalizeText(row.balance) ?? '0',
            symbol: normalizeText(row.tokenAbbr)?.toUpperCase() ?? undefined,
            name: normalizeText(row.tokenName) ?? undefined,
            decimals: normalizeFiniteNumber(row.tokenDecimal) ?? undefined,
            price_usd: priceUsd,
            value_usd: valueUsd,
            logo: normalizeText(row.tokenLogo),
            logo_uri: null,
            url: null,
          } satisfies PortfolioBalanceRow;
        })
        .filter((row) => Number(row.value_usd ?? 0) > 0 || hasPositiveAmount(row.amount)),
    );

    if (rows.length < limit) break;
    start += rows.length;
  }

  return balances.sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
}

function getBitcoinBalanceSats(response: BitcoinAddressResponse): bigint {
  const chainFunded = BigInt(response.chain_stats?.funded_txo_sum ?? 0);
  const chainSpent = BigInt(response.chain_stats?.spent_txo_sum ?? 0);
  const mempoolFunded = BigInt(response.mempool_stats?.funded_txo_sum ?? 0);
  const mempoolSpent = BigInt(response.mempool_stats?.spent_txo_sum ?? 0);
  return chainFunded - chainSpent + mempoolFunded - mempoolSpent;
}

async function fetchBitcoinPriceUsd(env: Bindings): Promise<number | null> {
  const baseUrl = (env.COINGECKO_API_BASE_URL?.trim() || 'https://api.coingecko.com/api/v3').replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${baseUrl}/simple/price?ids=bitcoin&vs_currencies=usd`,
    {},
    PORTFOLIO_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) return null;
  const data = (await response.json()) as {
    bitcoin?: {
      usd?: number;
    };
  };
  const price = Number(data.bitcoin?.usd);
  return Number.isFinite(price) ? price : null;
}

async function fetchBitcoinPortfolio(
  env: Bindings,
  walletAddress: string,
): Promise<PortfolioBalanceRow[]> {
  const [balanceResponse, priceUsd] = await Promise.all([
    fetchWithTimeout(
      `https://mempool.space/api/address/${encodeURIComponent(walletAddress)}`,
      {},
      PORTFOLIO_FETCH_TIMEOUT_MS,
    ),
    fetchBitcoinPriceUsd(env).catch(() => null),
  ]);
  if (!balanceResponse.ok) {
    throw new Error('failed_to_fetch_bitcoin_portfolio');
  }

  const balanceData = (await balanceResponse.json()) as BitcoinAddressResponse;
  const balanceSats = getBitcoinBalanceSats(balanceData);
  if (balanceSats <= 0n) {
    return [];
  }

  const numericBalance = Number(balanceSats) / 100_000_000;
  const valueUsd = priceUsd != null ? numericBalance * priceUsd : null;

  return [
    {
      protocol: 'btc',
      network_key: BITCOIN_NETWORK_KEY,
      chain: 'btc',
      chain_id: null,
      address: NATIVE_CONTRACT_KEY,
      asset_id: 'coingecko:bitcoin',
      chain_asset_id: buildChainAssetId('btc', NATIVE_CONTRACT_KEY),
      amount: balanceSats.toString(),
      symbol: 'BTC',
      name: 'Bitcoin',
      decimals: 8,
      price_usd: priceUsd,
      value_usd: valueUsd,
      logo: null,
      logo_uri: null,
      url: null,
    },
  ];
}

export async function fetchWalletPortfolio(
  env: Bindings,
  wallet: WalletSummary,
): Promise<{ totalUsd: number; holdings: PortfolioBalanceRow[]; asOf: string }> {
  const evmAccounts = wallet.chainAccounts.filter((row) => row.protocol === 'evm');
  const tronAccount = wallet.chainAccounts.find((row) => row.networkKey === TRON_NETWORK_KEY);
  const solanaAccount = wallet.chainAccounts.find((row) => row.networkKey === SOLANA_NETWORK_KEY);
  const bitcoinAccount = wallet.chainAccounts.find((row) => row.networkKey === BITCOIN_NETWORK_KEY);
  const evmPrimary = evmAccounts[0]?.address ?? wallet.address;
  const [evmHoldings, tronHoldings, solanaHoldings, bitcoinHoldings] = await Promise.all([
    evmPrimary ? fetchEvmPortfolio(env, evmPrimary).catch(() => []) : Promise.resolve([]),
    tronAccount ? fetchTronPortfolio(env, tronAccount.address).catch(() => []) : Promise.resolve([]),
    solanaAccount ? fetchSolanaPortfolio(env, solanaAccount.address).catch(() => []) : Promise.resolve([]),
    bitcoinAccount ? fetchBitcoinPortfolio(env, bitcoinAccount.address).catch(() => []) : Promise.resolve([]),
  ]);
  const holdings = [...evmHoldings, ...tronHoldings, ...solanaHoldings, ...bitcoinHoldings]
    .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
  const totalUsd = holdings.reduce((acc, row) => acc + Number(row.value_usd ?? 0), 0);
  return {
    totalUsd,
    holdings,
    asOf: nowIso(),
  };
}

export async function buildMergedPortfolioHoldings(
  env: Bindings,
  holdings: PortfolioBalanceRow[],
): Promise<MergedPortfolioHolding[]> {
  const byAssetId = new Map<string, MergedPortfolioHolding>();
  const preferredAssetIdByChainAssetId = new Map<string, string | null>();

  for (const row of holdings) {
    const marketChain = resolveHoldingMarketChain(row);
    const contractKey = resolveHoldingContractKey(row);
    const chainAssetId = normalizeText(row.chain_asset_id) ?? buildChainAssetId(marketChain, contractKey);
    const upstreamAssetId = normalizeAssetId(row.asset_id);
    const manualOverrideAssetId = resolveManualAssetIdOverride(marketChain, contractKey);

    let assetId = manualOverrideAssetId ?? upstreamAssetId;
    if (!assetId) {
      if (!preferredAssetIdByChainAssetId.has(chainAssetId)) {
        if (contractKey === NATIVE_CONTRACT_KEY) {
          preferredAssetIdByChainAssetId.set(chainAssetId, null);
        } else {
          try {
            preferredAssetIdByChainAssetId.set(
              chainAssetId,
              await resolveCoinGeckoAssetIdForContract(env, marketChain, contractKey),
            );
          } catch {
            preferredAssetIdByChainAssetId.set(chainAssetId, null);
          }
        }
      }
      assetId = buildAssetId(
        marketChain,
        contractKey,
        preferredAssetIdByChainAssetId.get(chainAssetId) ?? undefined,
      );
    }

    const valueUsd = Number(row.value_usd ?? 0);
    const variant: MergedHoldingVariant = {
      ...row,
      market_chain: marketChain,
      contract_key: contractKey,
      chain_asset_id: chainAssetId,
      asset_id: assetId,
    };

    const current = byAssetId.get(assetId);
    if (current) {
      current.total_value_usd += valueUsd;
      current.variants.push(variant);
      continue;
    }
    byAssetId.set(assetId, {
      asset_id: assetId,
      symbol: normalizeText(row.symbol)?.toUpperCase() ?? null,
      name: normalizeText(row.name),
      logo: resolveHoldingLogo(row),
      total_value_usd: valueUsd,
      variants: [variant],
    });
  }

  const merged = [...byAssetId.values()];
  for (const item of merged) {
    item.variants.sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
    if (!item.symbol) {
      item.symbol = item.variants
        .map((variant) => normalizeText(variant.symbol)?.toUpperCase() ?? null)
        .find((symbol): symbol is string => Boolean(symbol))
        ?? null;
    }
    if (!item.name) {
      item.name = item.variants
        .map((variant) => normalizeText(variant.name))
        .find((name): name is string => Boolean(name))
        ?? null;
    }
    if (!item.name) {
      item.name = resolveFallbackAssetName(item.asset_id, item.symbol);
    }
    if (!item.logo) {
      item.logo = item.variants
        .map((variant) => resolveHoldingLogo(variant))
        .find((logo): logo is string => Boolean(logo))
        ?? null;
    }
  }

  return merged.sort((a, b) => b.total_value_usd - a.total_value_usd);
}
