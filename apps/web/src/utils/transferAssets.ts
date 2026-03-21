import type { SimEvmBalance, WalletPortfolioResponse } from '../api';
import { buildChainAssetId } from './assetIdentity';
import { inferProtocolFromChain, normalizeContractForChain, normalizeMarketChain, type WalletProtocol } from './chainIdentity';

export type TransferSelectableAsset = {
  key: string;
  assetId: string | null;
  chainAssetId: string;
  networkKey: string;
  chainId: number | null;
  chain: string;
  protocol: WalletProtocol;
  symbol: string;
  name: string;
  logo: string | null;
  tokenAddress?: string;
  tokenDecimals: number;
  amountRaw: string;
  amountValue: number;
  amountText: string;
  valueUsd: number;
  isNative: boolean;
};

type TransferAssetSource = SimEvmBalance & {
  market_chain?: string;
  contract_key?: string;
};

type TransferAssetOverrides = {
  assetId?: string | null;
  chainAssetId?: string | null;
  symbol?: string | null;
  name?: string | null;
  logo?: string | null;
};

const NATIVE_SYMBOL_BY_CHAIN: Record<string, string> = {
  eth: 'ETH',
  base: 'ETH',
  bnb: 'BNB',
  tron: 'TRX',
  sol: 'SOL',
  btc: 'BTC',
};

const NATIVE_NAME_BY_CHAIN: Record<string, string> = {
  eth: 'Ethereum',
  base: 'Ethereum',
  bnb: 'BNB',
  tron: 'TRON',
  sol: 'Solana',
  btc: 'Bitcoin',
};

function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '').trim();
}

function normalizeAssetId(raw: string | null | undefined): string | null {
  const value = normalizeText(raw).toLowerCase();
  return value || null;
}

function normalizeIconUrl(raw: string | null | undefined): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  if (value.startsWith('ipfs://ipfs/')) {
    return `https://ipfs.io/ipfs/${value.slice('ipfs://ipfs/'.length)}`;
  }
  if (value.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${value.slice('ipfs://'.length)}`;
  }
  return value;
}

function normalizeDecimals(raw: number | null | undefined, fallback: number): number {
  if (!Number.isFinite(Number(raw))) return fallback;
  const value = Math.trunc(Number(raw));
  if (value < 0 || value > 36) return fallback;
  return value;
}

function toDisplayAmount(rawAmount: string, decimals: number): number {
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount)) return 0;
  const divisor = 10 ** decimals;
  if (!Number.isFinite(divisor) || divisor <= 0) return amount;
  return amount / divisor;
}

function formatDisplayAmount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function hasPositiveRawAmount(rawAmount: string | null | undefined): boolean {
  const value = normalizeText(rawAmount);
  if (!value || value === '0') return false;
  if (/^\d+$/.test(value)) {
    return BigInt(value) > 0n;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function sumRawAmount(current: string, next: string): string {
  if (/^\d+$/.test(current) && /^\d+$/.test(next)) {
    return (BigInt(current) + BigInt(next)).toString();
  }
  const summed = Number(current) + Number(next);
  return Number.isFinite(summed) ? String(summed) : current;
}

function resolveProtocol(source: TransferAssetSource, chain: string): WalletProtocol {
  return source.protocol ?? inferProtocolFromChain(chain);
}

function resolveTokenDecimals(protocol: WalletProtocol, raw: number | null | undefined): number {
  if (protocol === 'svm') return normalizeDecimals(raw, 9);
  if (protocol === 'tvm') return normalizeDecimals(raw, 6);
  if (protocol === 'btc') return normalizeDecimals(raw, 8);
  return normalizeDecimals(raw, 18);
}

function resolveSymbol(chain: string, isNative: boolean, source: TransferAssetSource, overrides?: TransferAssetOverrides): string {
  const fromOverride = normalizeText(overrides?.symbol).toUpperCase();
  if (fromOverride) return fromOverride;
  const fromSource = normalizeText(source.symbol).toUpperCase();
  if (fromSource) return fromSource;
  if (isNative) return NATIVE_SYMBOL_BY_CHAIN[chain] ?? 'NATIVE';
  return 'TOKEN';
}

function resolveName(chain: string, isNative: boolean, symbol: string, source: TransferAssetSource, overrides?: TransferAssetOverrides): string {
  const fromOverride = normalizeText(overrides?.name);
  if (fromOverride) return fromOverride;
  const fromSource = normalizeText(source.name);
  if (fromSource) return fromSource;
  if (isNative) return NATIVE_NAME_BY_CHAIN[chain] ?? symbol;
  return symbol;
}

function resolveChain(source: TransferAssetSource): string {
  return normalizeMarketChain(source.market_chain ?? source.chain);
}

export function buildTransferSelectableAsset(
  source: TransferAssetSource,
  overrides?: TransferAssetOverrides,
): TransferSelectableAsset | null {
  const networkKey = normalizeText(source.network_key).toLowerCase();
  if (!networkKey) return null;

  const chain = resolveChain(source);
  const protocol = resolveProtocol(source, chain);
  const contractKey = normalizeContractForChain(chain, source.contract_key ?? source.address);
  const isNative = contractKey === 'native';
  const tokenDecimals = resolveTokenDecimals(protocol, source.decimals);
  const amountRaw = normalizeText(source.amount) || '0';
  if (!hasPositiveRawAmount(amountRaw)) return null;

  const symbol = resolveSymbol(chain, isNative, source, overrides);
  const amountValue = toDisplayAmount(amountRaw, tokenDecimals);
  const chainAssetId = normalizeText(overrides?.chainAssetId)
    || normalizeText(source.chain_asset_id)
    || buildChainAssetId(chain, contractKey);
  const assetId = normalizeAssetId(overrides?.assetId) ?? normalizeAssetId(source.asset_id);

  return {
    key: `${networkKey}:${contractKey}`,
    assetId,
    chainAssetId,
    networkKey,
    chainId: source.chain_id ?? null,
    chain,
    protocol,
    symbol,
    name: resolveName(chain, isNative, symbol, source, overrides),
    logo: normalizeIconUrl(overrides?.logo) ?? normalizeIconUrl(source.logo) ?? normalizeIconUrl(source.logo_uri) ?? normalizeIconUrl(source.url),
    tokenAddress: isNative ? undefined : contractKey,
    tokenDecimals,
    amountRaw,
    amountValue,
    amountText: formatDisplayAmount(amountValue),
    valueUsd: Number(source.value_usd ?? 0),
    isNative,
  };
}

function mergeTransferAsset(existing: TransferSelectableAsset, next: TransferSelectableAsset): TransferSelectableAsset {
  const amountRaw = sumRawAmount(existing.amountRaw, next.amountRaw);
  const amountValue = existing.amountValue + next.amountValue;
  const valueUsd = existing.valueUsd + next.valueUsd;
  return {
    ...existing,
    assetId: existing.assetId ?? next.assetId,
    logo: existing.logo ?? next.logo,
    name: existing.name || next.name,
    symbol: existing.symbol || next.symbol,
    amountRaw,
    amountValue,
    amountText: formatDisplayAmount(amountValue),
    valueUsd,
  };
}

export function buildTransferableAssets(
  portfolio: WalletPortfolioResponse | null | undefined,
  options?: {
    hiddenAssetKeys?: Set<string>;
  },
): TransferSelectableAsset[] {
  if (!portfolio) return [];

  const hiddenAssetKeys = options?.hiddenAssetKeys ?? new Set<string>();
  const byKey = new Map<string, TransferSelectableAsset>();

  const pushAsset = (asset: TransferSelectableAsset | null) => {
    if (!asset) return;
    if (hiddenAssetKeys.has(asset.chainAssetId)) return;
    const existing = byKey.get(asset.key);
    if (existing) {
      byKey.set(asset.key, mergeTransferAsset(existing, asset));
      return;
    }
    byKey.set(asset.key, asset);
  };

  const mergedHoldings = portfolio.mergedHoldings ?? [];
  if (mergedHoldings.length > 0) {
    for (const holding of mergedHoldings) {
      for (const variant of holding.variants ?? []) {
        pushAsset(buildTransferSelectableAsset(variant, {
          assetId: holding.asset_id ?? variant.asset_id ?? null,
          chainAssetId: variant.chain_asset_id,
          symbol: holding.symbol ?? variant.symbol ?? null,
          name: holding.name ?? variant.name ?? null,
          logo: holding.logo ?? variant.logo ?? variant.logo_uri ?? variant.url ?? null,
        }));
      }
    }
  } else {
    for (const holding of portfolio.holdings ?? []) {
      pushAsset(buildTransferSelectableAsset(holding));
    }
  }

  return [...byKey.values()].sort((a, b) => b.valueUsd - a.valueUsd || a.symbol.localeCompare(b.symbol));
}
