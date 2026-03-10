export const NATIVE_CONTRACT_KEY = 'native';

const NATIVE_ASSET_ID_BY_CHAIN: Record<string, string> = {
  eth: 'coingecko:ethereum',
  base: 'coingecko:ethereum',
  bnb: 'coingecko:binancecoin',
  sol: 'coingecko:solana',
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

export function normalizeMarketChain(raw: unknown): string {
  const value = normalizeText(raw)?.toLowerCase() ?? 'unknown';
  if (value === 'ethereum' || value === 'mainnet') return 'eth';
  if (value === 'bsc' || value === 'binance-smart-chain' || value === 'bnb-smart-chain') return 'bnb';
  if (value === 'solana') return 'sol';
  return value;
}

export function inferProtocolFromChain(raw: unknown): 'evm' | 'svm' {
  return normalizeMarketChain(raw) === 'sol' ? 'svm' : 'evm';
}

export function toContractKey(raw: unknown, chain?: unknown): string {
  const protocol = inferProtocolFromChain(chain);
  const value = normalizeText(raw);
  if (!value || value === NATIVE_CONTRACT_KEY) return NATIVE_CONTRACT_KEY;
  return protocol === 'svm' ? value : value.toLowerCase();
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
