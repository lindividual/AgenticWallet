export type ChainConfig = {
  chainId: number;
  name: string;
  symbol: string;
};

export type AppConfig = {
  supportedChains: ChainConfig[];
  defaultReceiveTokens: string[];
};

export const APP_CONFIG: AppConfig = {
  supportedChains: [
    { chainId: 1, name: 'Ethereum', symbol: 'ETH' },
    { chainId: 8453, name: 'Base', symbol: 'ETH' },
    { chainId: 56, name: 'BNB Chain', symbol: 'BNB' },
  ],
  defaultReceiveTokens: ['ETH', 'USDC', 'USDT', 'BNB'],
};
