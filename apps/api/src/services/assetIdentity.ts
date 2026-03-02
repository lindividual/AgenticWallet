export const NATIVE_CONTRACT_KEY = 'native';

const NATIVE_ASSET_ID_BY_CHAIN: Record<string, string> = {
  eth: 'coingecko:ethereum',
  base: 'coingecko:ethereum',
  bnb: 'coingecko:binancecoin',
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

export function normalizeMarketChain(raw: unknown): string {
  return normalizeText(raw)?.toLowerCase() ?? 'unknown';
}

export function toContractKey(raw: unknown): string {
  const value = normalizeText(raw)?.toLowerCase();
  if (!value || value === NATIVE_CONTRACT_KEY) return NATIVE_CONTRACT_KEY;
  return value;
}

export function contractKeyToUpstreamContract(raw: unknown): string {
  const key = toContractKey(raw);
  return key === NATIVE_CONTRACT_KEY ? '' : key;
}

export function buildChainAssetId(chain: unknown, contract: unknown): string {
  return `evm:${normalizeMarketChain(chain)}:${toContractKey(contract)}`;
}

export function buildAssetId(
  chain: unknown,
  contract: unknown,
  preferredAssetId?: string | null,
): string {
  const preferred = normalizeText(preferredAssetId);
  if (preferred) return preferred;

  const normalizedChain = normalizeMarketChain(chain);
  const contractKey = toContractKey(contract);
  if (contractKey === NATIVE_CONTRACT_KEY) {
    return NATIVE_ASSET_ID_BY_CHAIN[normalizedChain] ?? `native:${normalizedChain}`;
  }
  return `evm:${normalizedChain}:${contractKey}`;
}
