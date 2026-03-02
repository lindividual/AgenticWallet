export type ChainConfig = {
  chainId: number;
  name: string;
  symbol: string;
  marketChain: 'eth' | 'base' | 'bnb';
};

export type AppConfig = {
  supportedChains: ChainConfig[];
  defaultReceiveTokens: string[];
};

export const APP_CONFIG: AppConfig = {
  supportedChains: [
    { chainId: 1, name: 'Ethereum', symbol: 'ETH', marketChain: 'eth' },
    { chainId: 8453, name: 'Base', symbol: 'ETH', marketChain: 'base' },
    { chainId: 56, name: 'BNB Chain', symbol: 'BNB', marketChain: 'bnb' },
  ],
  defaultReceiveTokens: ['ETH', 'USDC', 'USDT', 'BNB'],
};

export function getSupportedChainIds(): number[] {
  return APP_CONFIG.supportedChains.map((item) => item.chainId);
}

export function getSupportedMarketChains(): Array<'eth' | 'base' | 'bnb'> {
  return [...new Set(APP_CONFIG.supportedChains.map((item) => item.marketChain))];
}

export function getMarketChainByChainId(chainId: number): ChainConfig['marketChain'] | null {
  const matched = APP_CONFIG.supportedChains.find((item) => item.chainId === chainId);
  return matched?.marketChain ?? null;
}
