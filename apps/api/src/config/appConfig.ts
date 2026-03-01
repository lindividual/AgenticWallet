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
    { chainId: 11155111, name: 'Sepolia', symbol: 'ETH' },
    { chainId: 84532, name: 'Base Sepolia', symbol: 'ETH' },
  ],
  defaultReceiveTokens: ['ETH', 'USDC', 'USDT'],
};
