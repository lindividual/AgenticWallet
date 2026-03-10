import { buildChainAssetId } from './assetIdentity';
import { normalizeWalletAddress } from './chainIdentity';

function buildWalletHiddenAssetsStorageKey(walletAddress: string): string | null {
  const protocol = walletAddress.startsWith('0x') ? 'evm' : 'svm';
  const normalizedWalletAddress = normalizeWalletAddress(protocol, walletAddress);
  if (!normalizedWalletAddress) return null;
  return `wallet-hidden-assets:v1:${normalizedWalletAddress}`;
}

function normalizeHiddenAssetKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getHiddenWalletAssetKeys(walletAddress: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  const storageKey = buildWalletHiddenAssetsStorageKey(walletAddress);
  if (!storageKey) return new Set();

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    return new Set(normalizeHiddenAssetKeys(JSON.parse(raw)));
  } catch {
    return new Set();
  }
}

export function hideWalletAsset(walletAddress: string, chain: string, contract: string): Set<string> {
  const storageKey = buildWalletHiddenAssetsStorageKey(walletAddress);
  const nextKeys = getHiddenWalletAssetKeys(walletAddress);
  nextKeys.add(buildChainAssetId(chain, contract).trim());

  if (typeof window !== 'undefined' && storageKey) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...nextKeys]));
    } catch {
      // Ignore persistence errors and keep the in-memory result.
    }
  }

  return nextKeys;
}
