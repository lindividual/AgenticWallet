import { buildChainAssetId } from './assetIdentity';
import { inferWalletProtocolFromAddress, normalizeContractForChain, normalizeWalletAddress } from './chainIdentity';

export type WalletCryptoFilterState = {
  networkKey: string;
  hideSmallBalances: boolean;
  hideHighRisk: boolean;
};

export type WalletAddedAsset = {
  chain: string;
  contract: string;
  networkKey: string | null;
  symbol: string;
  name: string;
  image: string | null;
  assetId: string | null;
  addedAt: string;
};

export type WalletAddedAssetInput = {
  chain: string;
  contract: string;
  networkKey?: string | null;
  symbol?: string | null;
  name?: string | null;
  image?: string | null;
  assetId?: string | null;
};

const DEFAULT_FILTER_STATE: WalletCryptoFilterState = {
  networkKey: '',
  hideSmallBalances: false,
  hideHighRisk: false,
};

function buildWalletStorageKey(walletAddress: string, suffix: string): string | null {
  const protocol = inferWalletProtocolFromAddress(walletAddress) ?? 'evm';
  const normalizedWalletAddress = normalizeWalletAddress(protocol, walletAddress);
  if (!normalizedWalletAddress) return null;
  return `wallet-${suffix}:v1:${normalizedWalletAddress}`;
}

function normalizeFilterState(raw: unknown): WalletCryptoFilterState {
  if (!raw || typeof raw !== 'object') return DEFAULT_FILTER_STATE;
  const candidate = raw as Partial<WalletCryptoFilterState>;
  return {
    networkKey: typeof candidate.networkKey === 'string' ? candidate.networkKey.trim() : '',
    hideSmallBalances: Boolean(candidate.hideSmallBalances),
    hideHighRisk: Boolean(candidate.hideHighRisk),
  };
}

function normalizeAddedAssets(raw: unknown): WalletAddedAsset[] {
  if (!Array.isArray(raw)) return [];

  const deduped = new Map<string, WalletAddedAsset>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<WalletAddedAsset>;
    const chain = typeof candidate.chain === 'string' ? candidate.chain.trim().toLowerCase() : '';
    const contract = normalizeContractForChain(chain, typeof candidate.contract === 'string' ? candidate.contract : '');
    if (!chain) continue;
    const chainAssetId = buildChainAssetId(chain, contract).trim();
    deduped.set(chainAssetId, {
      chain,
      contract,
      networkKey: typeof candidate.networkKey === 'string' && candidate.networkKey.trim() ? candidate.networkKey.trim() : null,
      symbol: typeof candidate.symbol === 'string' ? candidate.symbol.trim() : '',
      name: typeof candidate.name === 'string' ? candidate.name.trim() : '',
      image: typeof candidate.image === 'string' && candidate.image.trim() ? candidate.image.trim() : null,
      assetId: typeof candidate.assetId === 'string' && candidate.assetId.trim() ? candidate.assetId.trim() : null,
      addedAt: typeof candidate.addedAt === 'string' && candidate.addedAt.trim()
        ? candidate.addedAt.trim()
        : new Date(0).toISOString(),
    });
  }

  return [...deduped.values()].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

function writeStorageValue(storageKey: string | null, value: unknown): void {
  if (typeof window === 'undefined' || !storageKey) return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Ignore persistence errors and keep runtime state usable.
  }
}

export function getWalletCryptoFilterState(walletAddress: string): WalletCryptoFilterState {
  if (typeof window === 'undefined') return DEFAULT_FILTER_STATE;
  const storageKey = buildWalletStorageKey(walletAddress, 'crypto-filters');
  if (!storageKey) return DEFAULT_FILTER_STATE;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return DEFAULT_FILTER_STATE;
    return normalizeFilterState(JSON.parse(raw));
  } catch {
    return DEFAULT_FILTER_STATE;
  }
}

export function setWalletCryptoFilterState(
  walletAddress: string,
  state: WalletCryptoFilterState,
): WalletCryptoFilterState {
  const nextState = normalizeFilterState(state);
  writeStorageValue(buildWalletStorageKey(walletAddress, 'crypto-filters'), nextState);
  return nextState;
}

export function getWalletAddedAssets(walletAddress: string): WalletAddedAsset[] {
  if (typeof window === 'undefined') return [];
  const storageKey = buildWalletStorageKey(walletAddress, 'tracked-assets');
  if (!storageKey) return [];

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    return normalizeAddedAssets(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function upsertWalletAddedAsset(
  walletAddress: string,
  input: WalletAddedAssetInput,
): WalletAddedAsset[] {
  const currentAssets = getWalletAddedAssets(walletAddress);
  const chain = input.chain.trim().toLowerCase();
  const contract = normalizeContractForChain(chain, input.contract);
  if (!chain) return currentAssets;

  const chainAssetId = buildChainAssetId(chain, contract).trim();
  const byKey = new Map(
    currentAssets.map((item) => [buildChainAssetId(item.chain, item.contract).trim(), item] as const),
  );
  const existing = byKey.get(chainAssetId);
  byKey.set(chainAssetId, {
    chain,
    contract,
    networkKey: input.networkKey?.trim() || existing?.networkKey || null,
    symbol: input.symbol?.trim() || existing?.symbol || '',
    name: input.name?.trim() || existing?.name || '',
    image: input.image?.trim() || existing?.image || null,
    assetId: input.assetId?.trim() || existing?.assetId || null,
    addedAt: existing?.addedAt || new Date().toISOString(),
  });

  const nextAssets = [...byKey.values()].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  writeStorageValue(buildWalletStorageKey(walletAddress, 'tracked-assets'), nextAssets);
  return nextAssets;
}

export function removeWalletAddedAsset(
  walletAddress: string,
  chain: string,
  contract: string,
): WalletAddedAsset[] {
  const currentAssets = getWalletAddedAssets(walletAddress);
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedContract = normalizeContractForChain(normalizedChain, contract);
  if (!normalizedChain) return currentAssets;

  const targetChainAssetId = buildChainAssetId(normalizedChain, normalizedContract).trim();
  const nextAssets = currentAssets.filter(
    (item) => buildChainAssetId(item.chain, item.contract).trim() !== targetChainAssetId,
  );

  writeStorageValue(buildWalletStorageKey(walletAddress, 'tracked-assets'), nextAssets);
  return nextAssets;
}
