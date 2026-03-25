import type { Address } from 'viem';
import {
  ARBITRUM_NETWORK_KEY,
  BASE_NETWORK_KEY,
  BNB_NETWORK_KEY,
  ETHEREUM_NETWORK_KEY,
  OPTIMISM_NETWORK_KEY,
  POLYGON_NETWORK_KEY,
} from './wallet';

export type SupportedStablecoinSymbol = 'USDT' | 'USDC';
export type StablecoinExecutionMode = 'direct' | 'single_source_bridge' | 'multi_source_bridge' | 'insufficient_balance';

export type StablecoinNetworkAsset = {
  networkKey: string;
  chainId: number;
  symbol: SupportedStablecoinSymbol;
  tokenAddress: Address;
  tokenDecimals: number;
};

export type StablecoinBalance = StablecoinNetworkAsset & {
  availableAmountRaw: bigint;
  fromAddress: Address;
};

export type StablecoinPlanSource = StablecoinBalance & {
  selectedAmountRaw: bigint;
};

export type StablecoinTransferPlan = {
  executionMode: StablecoinExecutionMode;
  requestedAmountRaw: bigint;
  estimatedReceivedAmountRaw: bigint;
  shortfallAmountRaw: bigint;
  destination: StablecoinNetworkAsset;
  recommendedSourceNetworkKey: string | null;
  selectedSourceNetworkKey: string | null;
  availableSources: StablecoinBalance[];
  selectedSources: StablecoinPlanSource[];
};

const SOURCE_PRIORITY = [
  ETHEREUM_NETWORK_KEY,
  ARBITRUM_NETWORK_KEY,
  BASE_NETWORK_KEY,
  OPTIMISM_NETWORK_KEY,
  BNB_NETWORK_KEY,
  POLYGON_NETWORK_KEY,
] as const;

export const STABLECOIN_NETWORK_ASSETS: StablecoinNetworkAsset[] = [
  {
    networkKey: ETHEREUM_NETWORK_KEY,
    chainId: 1,
    symbol: 'USDT',
    tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    tokenDecimals: 6,
  },
  {
    networkKey: ARBITRUM_NETWORK_KEY,
    chainId: 42161,
    symbol: 'USDT',
    tokenAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    tokenDecimals: 6,
  },
  {
    networkKey: BASE_NETWORK_KEY,
    chainId: 8453,
    symbol: 'USDT',
    tokenAddress: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    tokenDecimals: 6,
  },
  {
    networkKey: OPTIMISM_NETWORK_KEY,
    chainId: 10,
    symbol: 'USDT',
    tokenAddress: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    tokenDecimals: 6,
  },
  {
    networkKey: BNB_NETWORK_KEY,
    chainId: 56,
    symbol: 'USDT',
    tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    tokenDecimals: 18,
  },
  {
    networkKey: POLYGON_NETWORK_KEY,
    chainId: 137,
    symbol: 'USDT',
    tokenAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    tokenDecimals: 6,
  },
  {
    networkKey: ETHEREUM_NETWORK_KEY,
    chainId: 1,
    symbol: 'USDC',
    tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    tokenDecimals: 6,
  },
  {
    networkKey: ARBITRUM_NETWORK_KEY,
    chainId: 42161,
    symbol: 'USDC',
    tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    tokenDecimals: 6,
  },
  {
    networkKey: BASE_NETWORK_KEY,
    chainId: 8453,
    symbol: 'USDC',
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    tokenDecimals: 6,
  },
  {
    networkKey: OPTIMISM_NETWORK_KEY,
    chainId: 10,
    symbol: 'USDC',
    tokenAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    tokenDecimals: 6,
  },
  {
    networkKey: BNB_NETWORK_KEY,
    chainId: 56,
    symbol: 'USDC',
    tokenAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    tokenDecimals: 18,
  },
  {
    networkKey: POLYGON_NETWORK_KEY,
    chainId: 137,
    symbol: 'USDC',
    tokenAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    tokenDecimals: 6,
  },
] as const;

export function getStablecoinNetworkAsset(
  networkKey: string,
  symbol: SupportedStablecoinSymbol,
): StablecoinNetworkAsset | null {
  return STABLECOIN_NETWORK_ASSETS.find((item) => item.networkKey === networkKey && item.symbol === symbol) ?? null;
}

function getPriority(networkKey: string): number {
  const index = SOURCE_PRIORITY.indexOf(networkKey as typeof SOURCE_PRIORITY[number]);
  return index === -1 ? SOURCE_PRIORITY.length : index;
}

function sortSources(
  sources: StablecoinBalance[],
  destinationNetworkKey: string,
  sourceNetworkKey?: string,
): StablecoinBalance[] {
  return [...sources].sort((left, right) => {
    const leftMatchesUser = sourceNetworkKey ? left.networkKey === sourceNetworkKey : false;
    const rightMatchesUser = sourceNetworkKey ? right.networkKey === sourceNetworkKey : false;
    if (leftMatchesUser !== rightMatchesUser) {
      return leftMatchesUser ? -1 : 1;
    }

    const leftIsDestination = left.networkKey === destinationNetworkKey;
    const rightIsDestination = right.networkKey === destinationNetworkKey;
    if (leftIsDestination !== rightIsDestination) {
      return leftIsDestination ? -1 : 1;
    }

    if (left.availableAmountRaw !== right.availableAmountRaw) {
      return left.availableAmountRaw > right.availableAmountRaw ? -1 : 1;
    }

    return getPriority(left.networkKey) - getPriority(right.networkKey);
  });
}

function convertAmountDecimals(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value;
  if (fromDecimals < toDecimals) {
    return value * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return value / 10n ** BigInt(fromDecimals - toDecimals);
}

export function buildStablecoinTransferPlan(input: {
  destinationNetworkKey: string;
  destinationTokenSymbol: SupportedStablecoinSymbol;
  requestedAmountRaw: bigint;
  availableSources: StablecoinBalance[];
  sourceNetworkKey?: string;
}): StablecoinTransferPlan {
  if (input.requestedAmountRaw <= 0n) {
    throw new Error('invalid_amount');
  }

  const destination = getStablecoinNetworkAsset(input.destinationNetworkKey, input.destinationTokenSymbol);
  if (!destination) {
    throw new Error('unsupported_stablecoin_destination');
  }

  const filteredSources = input.availableSources
    .filter((item) => item.symbol === input.destinationTokenSymbol)
    .filter((item) => input.sourceNetworkKey ? item.networkKey === input.sourceNetworkKey : true)
    .filter((item) => item.availableAmountRaw > 0n);

  const sortedSources = sortSources(filteredSources, input.destinationNetworkKey, input.sourceNetworkKey);
  const totalAvailableRaw = sortedSources.reduce(
    (acc, item) => acc + convertAmountDecimals(item.availableAmountRaw, item.tokenDecimals, destination.tokenDecimals),
    0n,
  );
  const directSource = sortedSources.find((item) => item.networkKey === input.destinationNetworkKey) ?? null;
  const directSourceAvailableRaw = directSource
    ? convertAmountDecimals(directSource.availableAmountRaw, directSource.tokenDecimals, destination.tokenDecimals)
    : 0n;

  if (directSource && directSourceAvailableRaw >= input.requestedAmountRaw) {
    return {
      executionMode: 'direct',
      requestedAmountRaw: input.requestedAmountRaw,
      estimatedReceivedAmountRaw: input.requestedAmountRaw,
      shortfallAmountRaw: 0n,
      destination,
      recommendedSourceNetworkKey: directSource.networkKey,
      selectedSourceNetworkKey: directSource.networkKey,
      availableSources: sortedSources,
      selectedSources: [
        {
          ...directSource,
          selectedAmountRaw: convertAmountDecimals(
            input.requestedAmountRaw,
            destination.tokenDecimals,
            directSource.tokenDecimals,
          ),
        },
      ],
    };
  }

  const singleSource = sortedSources.find((item) =>
    convertAmountDecimals(item.availableAmountRaw, item.tokenDecimals, destination.tokenDecimals) >= input.requestedAmountRaw,
  ) ?? null;
  if (singleSource) {
    return {
      executionMode: singleSource.networkKey === input.destinationNetworkKey ? 'direct' : 'single_source_bridge',
      requestedAmountRaw: input.requestedAmountRaw,
      estimatedReceivedAmountRaw: input.requestedAmountRaw,
      shortfallAmountRaw: 0n,
      destination,
      recommendedSourceNetworkKey: singleSource.networkKey,
      selectedSourceNetworkKey: singleSource.networkKey,
      availableSources: sortedSources,
      selectedSources: [
        {
          ...singleSource,
          selectedAmountRaw: convertAmountDecimals(
            input.requestedAmountRaw,
            destination.tokenDecimals,
            singleSource.tokenDecimals,
          ),
        },
      ],
    };
  }

  if (totalAvailableRaw >= input.requestedAmountRaw) {
    let remainingRaw = input.requestedAmountRaw;
    const selectedSources: StablecoinPlanSource[] = [];

    for (const source of sortedSources) {
      if (remainingRaw <= 0n) break;
      const availableEquivalentRaw = convertAmountDecimals(
        source.availableAmountRaw,
        source.tokenDecimals,
        destination.tokenDecimals,
      );
      if (availableEquivalentRaw <= 0n) continue;
      const selectedEquivalentRaw = availableEquivalentRaw < remainingRaw ? availableEquivalentRaw : remainingRaw;
      const selectedAmountRaw = convertAmountDecimals(
        selectedEquivalentRaw,
        destination.tokenDecimals,
        source.tokenDecimals,
      );
      if (selectedAmountRaw <= 0n) continue;
      const actualSelectedEquivalentRaw = convertAmountDecimals(
        selectedAmountRaw,
        source.tokenDecimals,
        destination.tokenDecimals,
      );
      selectedSources.push({
        ...source,
        selectedAmountRaw,
      });
      remainingRaw -= actualSelectedEquivalentRaw;
    }

    return {
      executionMode: 'multi_source_bridge',
      requestedAmountRaw: input.requestedAmountRaw,
      estimatedReceivedAmountRaw: input.requestedAmountRaw,
      shortfallAmountRaw: 0n,
      destination,
      recommendedSourceNetworkKey: directSource?.networkKey ?? selectedSources[0]?.networkKey ?? null,
      selectedSourceNetworkKey: null,
      availableSources: sortedSources,
      selectedSources,
    };
  }

  return {
    executionMode: 'insufficient_balance',
    requestedAmountRaw: input.requestedAmountRaw,
    estimatedReceivedAmountRaw: totalAvailableRaw,
    shortfallAmountRaw: input.requestedAmountRaw - totalAvailableRaw,
    destination,
    recommendedSourceNetworkKey: null,
    selectedSourceNetworkKey: null,
    availableSources: sortedSources,
    selectedSources: [],
  };
}
