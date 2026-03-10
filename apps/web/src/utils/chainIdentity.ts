export type WalletProtocol = 'evm' | 'svm';

export function normalizeMarketChain(raw: string | null | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value === 'ethereum' || value === 'mainnet') return 'eth';
  if (value === 'bsc' || value === 'binance-smart-chain' || value === 'bnb-smart-chain') return 'bnb';
  if (value === 'solana') return 'sol';
  return value;
}

export function inferProtocolFromChain(chain: string | null | undefined): WalletProtocol {
  return normalizeMarketChain(chain) === 'sol' ? 'svm' : 'evm';
}

export function normalizeContractForChain(
  chain: string | null | undefined,
  contract: string | null | undefined,
): string {
  const normalized = (contract ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'native' || normalized === '0x0000000000000000000000000000000000000000') {
    return 'native';
  }
  return inferProtocolFromChain(chain) === 'svm' ? normalized : normalized.toLowerCase();
}

export function normalizeAssetId(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  return value || null;
}

export function normalizeWalletAddress(protocol: WalletProtocol, address: string | null | undefined): string {
  const value = (address ?? '').trim();
  if (!value) return '';
  return protocol === 'svm' ? value : value.toLowerCase();
}

export function buildWalletAccountsFingerprint(
  chainAccounts: Array<{ chainId: number; protocol?: WalletProtocol; address: string }> | null | undefined,
  fallbackAddress?: string | null,
): string {
  const accounts = (chainAccounts ?? [])
    .map((item) => ({
      chainId: item.chainId,
      protocol: item.protocol ?? inferProtocolFromChain(String(item.chainId)),
      address: normalizeWalletAddress(item.protocol ?? 'evm', item.address),
    }))
    .filter((item) => item.address)
    .sort((a, b) => a.chainId - b.chainId || a.protocol.localeCompare(b.protocol));
  if (accounts.length > 0) {
    return accounts.map((item) => `${item.protocol}:${item.chainId}:${item.address}`).join('|');
  }
  return normalizeWalletAddress('evm', fallbackAddress);
}

export function getChainAccountAddress(
  chainAccounts: Array<{ chainId: number; protocol?: WalletProtocol; address: string }> | null | undefined,
  chainId: number | null | undefined,
  fallbackAddress?: string | null,
): string {
  if (Number.isFinite(chainId)) {
    const matched = (chainAccounts ?? []).find((item) => item.chainId === chainId);
    if (matched?.address?.trim()) return matched.address.trim();
  }
  return (fallbackAddress ?? '').trim();
}
