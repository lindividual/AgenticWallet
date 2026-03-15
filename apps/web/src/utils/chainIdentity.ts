export type WalletProtocol = 'evm' | 'svm' | 'tvm' | 'btc';

const TRON_ADDRESS_REGEX = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function normalizeMarketChain(raw: string | null | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value === 'ethereum' || value === 'mainnet') return 'eth';
  if (value === 'bsc' || value === 'binance-smart-chain' || value === 'bnb-smart-chain') return 'bnb';
  if (value === 'trx' || value === 'trc20') return 'tron';
  if (value === 'solana') return 'sol';
  if (value === 'bitcoin' || value === 'btc') return 'btc';
  return value;
}

export function inferProtocolFromChain(chain: string | null | undefined): WalletProtocol {
  const normalizedChain = normalizeMarketChain(chain);
  if (normalizedChain === 'sol') return 'svm';
  if (normalizedChain === 'tron') return 'tvm';
  if (normalizedChain === 'btc') return 'btc';
  return 'evm';
}

export function inferWalletProtocolFromAddress(address: string | null | undefined): WalletProtocol | null {
  const value = (address ?? '').trim();
  if (!value) return null;
  if (value.startsWith('0x')) return 'evm';
  if (TRON_ADDRESS_REGEX.test(value)) return 'tvm';
  if (value.toLowerCase().startsWith('bc1')) return 'btc';
  return 'svm';
}

export function normalizeContractForChain(
  chain: string | null | undefined,
  contract: string | null | undefined,
): string {
  const normalized = (contract ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'native' || normalized === '0x0000000000000000000000000000000000000000') {
    return 'native';
  }
  return inferProtocolFromChain(chain) === 'evm' ? normalized.toLowerCase() : normalized;
}

export function normalizeAssetId(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  return value || null;
}

export function normalizeWalletAddress(protocol: WalletProtocol, address: string | null | undefined): string {
  const value = (address ?? '').trim();
  if (!value) return '';
  return protocol === 'evm' || protocol === 'btc' ? value.toLowerCase() : value;
}

export function buildWalletAccountsFingerprint(
  chainAccounts: Array<{ networkKey: string; chainId: number | null; protocol?: WalletProtocol; address: string }> | null | undefined,
  fallbackAddress?: string | null,
): string {
  const accounts = (chainAccounts ?? [])
    .map((item) => ({
      networkKey: item.networkKey,
      chainId: item.chainId,
      protocol: item.protocol ?? inferWalletProtocolFromAddress(item.address) ?? inferProtocolFromChain(String(item.chainId)),
      address: normalizeWalletAddress(
        item.protocol ?? inferWalletProtocolFromAddress(item.address) ?? inferProtocolFromChain(String(item.chainId)),
        item.address,
      ),
    }))
    .filter((item) => item.address)
    .sort((a, b) => a.networkKey.localeCompare(b.networkKey) || a.protocol.localeCompare(b.protocol));
  if (accounts.length > 0) {
    return accounts.map((item) => `${item.protocol}:${item.networkKey}:${item.address}`).join('|');
  }
  return normalizeWalletAddress(inferWalletProtocolFromAddress(fallbackAddress) ?? 'evm', fallbackAddress);
}

export function getChainAccountAddress(
  chainAccounts: Array<{ networkKey: string; chainId: number | null; protocol?: WalletProtocol; address: string }> | null | undefined,
  networkKey: string | null | undefined,
  fallbackAddress?: string | null,
): string {
  if (networkKey) {
    const matched = (chainAccounts ?? []).find((item) => item.networkKey === networkKey);
    if (matched?.address?.trim()) return matched.address.trim();
  }
  return (fallbackAddress ?? '').trim();
}
