export type TradeTokenPreset = {
  address: string;
  symbol: string;
  decimals?: number;
};

type TradeTokenConfig = {
  usdc: TradeTokenPreset;
  usdt: TradeTokenPreset;
  defaultBuy: TradeTokenPreset;
};

const TRADE_TOKENS_BY_CHAIN: Record<number, TradeTokenConfig> = {
  1: {
    usdc: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      decimals: 6,
    },
    usdt: {
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      symbol: 'USDT',
      decimals: 6,
    },
    defaultBuy: {
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      symbol: 'WETH',
      decimals: 18,
    },
  },
  8453: {
    usdc: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      decimals: 6,
    },
    usdt: {
      address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
      symbol: 'USDT',
      decimals: 6,
    },
    defaultBuy: {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      decimals: 18,
    },
  },
  56: {
    usdc: {
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      symbol: 'USDC',
      decimals: 18,
    },
    usdt: {
      address: '0x55d398326f99059fF775485246999027B3197955',
      symbol: 'USDT',
      decimals: 18,
    },
    defaultBuy: {
      address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      symbol: 'WBNB',
      decimals: 18,
    },
  },
  101: {
    usdc: {
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: 'USDC',
      decimals: 6,
    },
    usdt: {
      address: 'Es9vMFrzaCERmJfrF4H2o6GfV6B1iKsFcfoTmya4A1R',
      symbol: 'USDT',
      decimals: 6,
    },
    defaultBuy: {
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
      decimals: 9,
    },
  },
};

const MARKET_CHAIN_TO_CHAIN_ID: Record<string, number> = {
  eth: 1,
  ethereum: 1,
  mainnet: 1,
  base: 8453,
  bnb: 56,
  bsc: 56,
  'bnb chain': 56,
  bnbchain: 56,
  'binance smart chain': 56,
  sol: 101,
  solana: 101,
};

export function getTradeTokenConfig(chainId: number): TradeTokenConfig | null {
  return TRADE_TOKENS_BY_CHAIN[chainId] ?? null;
}

export function getChainIdByMarketChain(marketChain: string): number | null {
  const normalized = marketChain.trim().toLowerCase();
  return MARKET_CHAIN_TO_CHAIN_ID[normalized] ?? null;
}

export function cloneTradeToken(token: TradeTokenPreset): TradeTokenPreset {
  return {
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
  };
}
