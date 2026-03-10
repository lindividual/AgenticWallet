export type ChainConfig = {
  chainId: number;
  name: string;
  symbol: string;
  marketChain: 'eth' | 'base' | 'bnb' | 'sol';
  protocol: 'evm' | 'svm';
};

export type AppConfig = {
  supportedChains: ChainConfig[];
  defaultReceiveTokens: string[];
};

export const APP_CONFIG: AppConfig = {
  supportedChains: [
    { chainId: 1, name: 'Ethereum', symbol: 'ETH', marketChain: 'eth', protocol: 'evm' },
    { chainId: 8453, name: 'Base', symbol: 'ETH', marketChain: 'base', protocol: 'evm' },
    { chainId: 56, name: 'BNB Chain', symbol: 'BNB', marketChain: 'bnb', protocol: 'evm' },
    { chainId: 101, name: 'Solana', symbol: 'SOL', marketChain: 'sol', protocol: 'svm' },
  ],
  defaultReceiveTokens: ['ETH', 'USDC', 'USDT', 'BNB', 'SOL'],
};

export function getSupportedChainIds(): number[] {
  return APP_CONFIG.supportedChains.map((item) => item.chainId);
}

export function getSupportedMarketChains(): Array<'eth' | 'base' | 'bnb' | 'sol'> {
  return [...new Set(APP_CONFIG.supportedChains.map((item) => item.marketChain))];
}

export function getMarketChainByChainId(chainId: number): ChainConfig['marketChain'] | null {
  const matched = APP_CONFIG.supportedChains.find((item) => item.chainId === chainId);
  return matched?.marketChain ?? null;
}

export function getChainIdByMarketChain(marketChain: string): number | null {
  const normalized = (marketChain ?? '').trim().toLowerCase();
  const matched = APP_CONFIG.supportedChains.find((item) => item.marketChain === normalized);
  return matched?.chainId ?? null;
}
