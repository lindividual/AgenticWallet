import { SUPPORTED_CHAINS } from '../constants';

const CHAIN_ID_TO_MARKET_CHAIN: Record<number, 'eth' | 'base' | 'bnb'> = {
  1: 'eth',
  8453: 'base',
  56: 'bnb',
};

export function getSupportedMarketChains(): Array<'eth' | 'base' | 'bnb'> {
  const resolved = new Set<'eth' | 'base' | 'bnb'>();
  for (const chain of SUPPORTED_CHAINS) {
    const marketChain = CHAIN_ID_TO_MARKET_CHAIN[chain.chainId];
    if (marketChain) resolved.add(marketChain);
  }
  return [...resolved];
}
