const NATIVE_CONTRACT_KEY = 'native';

function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '').trim();
}

function normalizeChain(raw: string | null | undefined): string {
  const value = normalizeText(raw).toLowerCase();
  return value || 'unknown';
}

function toContractKey(raw: string | null | undefined): string {
  const value = normalizeText(raw).toLowerCase();
  if (!value || value === NATIVE_CONTRACT_KEY) return NATIVE_CONTRACT_KEY;
  return value;
}

export function buildChainAssetId(chain: string | null | undefined, contract: string | null | undefined): string {
  return `evm:${normalizeChain(chain)}:${toContractKey(contract)}`;
}
