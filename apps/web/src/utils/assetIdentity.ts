import { inferProtocolFromChain, normalizeContractForChain, normalizeMarketChain } from './chainIdentity';

export function buildChainAssetId(chain: string | null | undefined, contract: string | null | undefined): string {
  const normalizedChain = normalizeMarketChain(chain);
  const normalizedContract = normalizeContractForChain(normalizedChain, contract);
  return `${inferProtocolFromChain(normalizedChain)}:${normalizedChain}:${normalizedContract}`;
}
