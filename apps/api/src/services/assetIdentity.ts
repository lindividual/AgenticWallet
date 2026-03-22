export const NATIVE_CONTRACT_KEY = 'native';

const NATIVE_ASSET_ID_BY_CHAIN: Record<string, string> = {
  eth: 'coingecko:ethereum',
  base: 'coingecko:ethereum',
  arbitrum: 'coingecko:ethereum',
  optimism: 'coingecko:ethereum',
  bnb: 'coingecko:binancecoin',
  matic: 'coingecko:matic-network',
  tron: 'coingecko:tron',
  sol: 'coingecko:solana',
  btc: 'coingecko:bitcoin',
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

export function normalizeMarketChain(raw: unknown): string {
  const value = normalizeText(raw)?.toLowerCase() ?? 'unknown';
  if (value === 'ethereum' || value === 'mainnet') return 'eth';
  if (value === 'arbitrum-one') return 'arbitrum';
  if (value === 'optimistic-ethereum' || value === 'op') return 'optimism';
  if (value === 'bsc' || value === 'binance-smart-chain' || value === 'bnb-smart-chain') return 'bnb';
  if (value === 'polygon' || value === 'polygon-pos' || value === 'pol') return 'matic';
  if (value === 'trx' || value === 'trc20') return 'tron';
  if (value === 'solana') return 'sol';
  if (value === 'bitcoin' || value === 'btc') return 'btc';
  return value;
}

export function inferProtocolFromChain(raw: unknown): 'evm' | 'svm' | 'tvm' | 'btc' {
  const chain = normalizeMarketChain(raw);
  if (chain === 'sol') return 'svm';
  if (chain === 'tron') return 'tvm';
  if (chain === 'btc') return 'btc';
  return 'evm';
}

export function toContractKey(raw: unknown, chain?: unknown): string {
  const protocol = inferProtocolFromChain(chain);
  const value = normalizeText(raw);
  if (!value || value === NATIVE_CONTRACT_KEY) return NATIVE_CONTRACT_KEY;
  return protocol === 'svm' || protocol === 'tvm' ? value : value.toLowerCase();
}

export function contractKeyToUpstreamContract(raw: unknown, chain?: unknown): string {
  const key = toContractKey(raw, chain);
  return key === NATIVE_CONTRACT_KEY ? '' : key;
}

export function buildChainAssetId(chain: unknown, contract: unknown): string {
  const normalizedChain = normalizeMarketChain(chain);
  return `${inferProtocolFromChain(normalizedChain)}:${normalizedChain}:${toContractKey(contract, normalizedChain)}`;
}

export function buildAssetId(
  chain: unknown,
  contract: unknown,
  preferredAssetId?: string | null,
): string {
  const preferred = normalizeText(preferredAssetId);
  if (preferred) return preferred;

  const normalizedChain = normalizeMarketChain(chain);
  const contractKey = toContractKey(contract, normalizedChain);
  if (contractKey === NATIVE_CONTRACT_KEY) {
    return NATIVE_ASSET_ID_BY_CHAIN[normalizedChain] ?? `native:${normalizedChain}`;
  }
  return `${inferProtocolFromChain(normalizedChain)}:${normalizedChain}:${contractKey}`;
}
