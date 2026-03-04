import type { Bindings } from '../types';
import { nowIso } from '../utils/time';
import { getMarketChainByChainId, getSupportedChainIds } from '../config/appConfig';
import { buildAssetId, buildChainAssetId, NATIVE_CONTRACT_KEY } from './assetIdentity';
import { resolveCoinGeckoAssetIdForContract } from './coingecko';

type SimBalanceRow = {
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
  token_metadata?: {
    logo?: string;
    logoURI?: string;
    url?: string;
  };
};

export type MergedHoldingVariant = SimBalanceRow & {
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
  balances: SimBalanceRow[];
  error?: string;
  message?: string;
};

const FALLBACK_ASSET_NAME_BY_ID: Record<string, string> = {
  'coingecko:ethereum': 'Ethereum',
  'coingecko:binancecoin': 'BNB',
  'coingecko:bitcoin': 'Bitcoin',
  'coingecko:tether': 'Tether',
  'coingecko:usd-coin': 'USD Coin',
};

const FALLBACK_ASSET_NAME_BY_SYMBOL: Record<string, string> = {
  ETH: 'Ethereum',
  BNB: 'BNB',
  BTC: 'Bitcoin',
  USDT: 'Tether',
  USDC: 'USD Coin',
};

function normalizeAddress(raw: string | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  return normalized;
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeAssetId(raw: unknown): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  return value.toLowerCase();
}

function resolveHoldingLogo(row: SimBalanceRow): string | null {
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
  return value;
}

function resolveHoldingMarketChain(row: SimBalanceRow): string {
  const fromConfig = getMarketChainByChainId(Number(row.chain_id));
  if (fromConfig) return fromConfig;
  return normalizeMarketChain(row.chain);
}

function resolveHoldingContractKey(row: SimBalanceRow): string {
  const address = normalizeAddress(row.address);
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

export async function fetchWalletPortfolio(
  env: Bindings,
  walletAddress: string,
): Promise<{ totalUsd: number; holdings: SimBalanceRow[]; asOf: string }> {
  const simApiKey = env.SIM_API_KEY?.trim();
  if (!simApiKey) {
    throw new Error('sim_api_key_not_configured');
  }

  const chainIds = getSupportedChainIds().join(',');
  const simResponse = await fetch(
    `https://api.sim.dune.com/v1/evm/balances/${walletAddress}?metadata=logo,url&chain_ids=${encodeURIComponent(chainIds)}`,
    {
      method: 'GET',
      headers: {
        'X-Sim-Api-Key': simApiKey,
      },
    },
  );

  const simData = (await simResponse.json()) as SimBalancesResponse;
  if (!simResponse.ok) {
    throw new Error(simData.message ?? simData.error ?? 'failed_to_fetch_portfolio');
  }

  const holdings = (simData.balances ?? [])
    .filter((row) => Number(row.value_usd ?? 0) > 0 || hasPositiveAmount(row.amount))
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
  holdings: SimBalanceRow[],
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
