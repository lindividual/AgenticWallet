export type ChainConfig = {
  networkKey: string;
  chainId: number | null;
  name: string;
  symbol: string;
  marketChain: 'eth' | 'base' | 'bnb' | 'arbitrum' | 'optimism' | 'matic' | 'tron' | 'sol' | 'btc';
  protocol: 'evm' | 'svm' | 'tvm' | 'btc';
};

export type AppConfig = {
  supportedChains: ChainConfig[];
  defaultReceiveTokens: string[];
};

export const APP_CONFIG: AppConfig = {
  supportedChains: [
    {
      networkKey: 'ethereum-mainnet',
      chainId: 1,
      name: 'Ethereum',
      symbol: 'ETH',
      marketChain: 'eth',
      protocol: 'evm',
    },
    {
      networkKey: 'base-mainnet',
      chainId: 8453,
      name: 'Base',
      symbol: 'ETH',
      marketChain: 'base',
      protocol: 'evm',
    },
    {
      networkKey: 'bnb-mainnet',
      chainId: 56,
      name: 'BNB Chain',
      symbol: 'BNB',
      marketChain: 'bnb',
      protocol: 'evm',
    },
    {
      networkKey: 'arbitrum-mainnet',
      chainId: 42161,
      name: 'Arbitrum',
      symbol: 'ETH',
      marketChain: 'arbitrum',
      protocol: 'evm',
    },
    {
      networkKey: 'optimism-mainnet',
      chainId: 10,
      name: 'Optimism',
      symbol: 'ETH',
      marketChain: 'optimism',
      protocol: 'evm',
    },
    {
      networkKey: 'polygon-mainnet',
      chainId: 137,
      name: 'Polygon',
      symbol: 'POL',
      marketChain: 'matic',
      protocol: 'evm',
    },
    {
      networkKey: 'tron-mainnet',
      chainId: null,
      name: 'Tron',
      symbol: 'TRX',
      marketChain: 'tron',
      protocol: 'tvm',
    },
    {
      networkKey: 'solana-mainnet',
      chainId: null,
      name: 'Solana',
      symbol: 'SOL',
      marketChain: 'sol',
      protocol: 'svm',
    },
    {
      networkKey: 'bitcoin-mainnet',
      chainId: null,
      name: 'Bitcoin',
      symbol: 'BTC',
      marketChain: 'btc',
      protocol: 'btc',
    },
  ],
  defaultReceiveTokens: ['ETH', 'USDC', 'USDT', 'BNB', 'TRX', 'SOL', 'BTC'],
};

export function getSupportedChainIds(): number[] {
  return APP_CONFIG.supportedChains.flatMap((item) => (typeof item.chainId === 'number' ? [item.chainId] : []));
}

export function getChainConfigByNetworkKey(networkKey: string): ChainConfig | null {
  const normalized = (networkKey ?? '').trim().toLowerCase();
  return APP_CONFIG.supportedChains.find((item) => item.networkKey === normalized) ?? null;
}

export function getChainConfigByChainId(chainId: number): ChainConfig | null {
  return APP_CONFIG.supportedChains.find((item) => item.chainId === chainId) ?? null;
}

export function getSupportedMarketChains(): Array<ChainConfig['marketChain']> {
  return [...new Set(APP_CONFIG.supportedChains.map((item) => item.marketChain))];
}

export function getMarketChainByChainId(chainId: number): ChainConfig['marketChain'] | null {
  return getChainConfigByChainId(chainId)?.marketChain ?? null;
}

export function getMarketChainByNetworkKey(networkKey: string): ChainConfig['marketChain'] | null {
  return getChainConfigByNetworkKey(networkKey)?.marketChain ?? null;
}

export function getChainIdByMarketChain(marketChain: string): number | null {
  const normalized = (marketChain ?? '').trim().toLowerCase();
  const matched = APP_CONFIG.supportedChains.find((item) => item.marketChain === normalized);
  return matched?.chainId ?? null;
}

export function getNetworkKeyByMarketChain(marketChain: string): string | null {
  const normalized = (marketChain ?? '').trim().toLowerCase();
  const matched = APP_CONFIG.supportedChains.find((item) => item.marketChain === normalized);
  return matched?.networkKey ?? null;
}
