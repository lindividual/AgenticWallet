import { NATIVE_CONTRACT_KEY, buildAssetId, normalizeMarketChain, toContractKey } from './assetIdentity';
import { fetchBitgetTokenDetails } from './bitgetWallet';
import { resolveCoinGeckoAssetIdForContract } from './coingecko';
import { fetchSolanaTokenDetails } from './solana';
import { fetchTradeMarketDetail } from './tradeBrowse';
import type { Bindings } from '../types';

export type ArticleRelatedAssetRef = {
  symbol: string;
  market_type?: 'spot' | 'perp' | 'prediction' | null;
  market_item_id?: string | null;
  asset_id?: string | null;
  instrument_id?: string | null;
  chain?: string | null;
  contract?: string | null;
  name?: string | null;
  image?: string | null;
  price_change_percentage_24h?: number | null;
};

export type ArticleRelatedAsset = {
  symbol: string;
  market_type: 'spot' | 'perp' | 'prediction' | null;
  market_item_id: string | null;
  asset_id: string | null;
  instrument_id: null;
  chain: string | null;
  contract: string | null;
  name: string;
  image: string | null;
  price_change_percentage_24h: number | null;
};

type NormalizedRelatedAssetRef = {
  symbol: string;
  market_type: 'spot' | 'perp' | 'prediction' | null;
  market_item_id: string | null;
  asset_id: string | null;
  instrument_id: string | null;
  chain: string | null;
  contract: string | null;
  name: string | null;
  image: string | null;
  price_change_percentage_24h: number | null;
};

const DEFAULT_TOKEN_ROUTE_BY_SYMBOL: Record<string, { chain: string; contract: string; name?: string }> = {
  ETH: {
    chain: 'eth',
    contract: 'native',
    name: 'Ethereum',
  },
  BTC: {
    chain: 'eth',
    contract: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    name: 'Bitcoin',
  },
  USDT: {
    chain: 'eth',
    contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    name: 'Tether',
  },
  USDC: {
    chain: 'eth',
    contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    name: 'USD Coin',
  },
  BNB: {
    chain: 'bnb',
    contract: 'native',
    name: 'BNB',
  },
  LEO: {
    chain: 'eth',
    contract: '0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3',
    name: 'LEO Token',
  },
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function normalizeSymbol(raw: unknown): string | null {
  const value = normalizeText(raw)?.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!value) return null;
  if (value.length < 2 || value.length > 16) return null;
  return value;
}

function normalizeChain(raw: unknown): string | null {
  return normalizeText(raw)?.toLowerCase() ?? null;
}

function normalizeMarketType(raw: unknown): 'spot' | 'perp' | 'prediction' | null {
  const value = normalizeText(raw)?.toLowerCase();
  if (value === 'spot' || value === 'perp' || value === 'prediction') return value;
  return null;
}

function normalizeContract(chain: string | null, raw: unknown): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  if (value.toLowerCase() === 'native') return 'native';
  if (chain === 'sol') return value;
  return value.toLowerCase();
}

function normalizeFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeRef(input: ArticleRelatedAssetRef): NormalizedRelatedAssetRef | null {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) return null;
  const chain = normalizeChain(input.chain);
  return {
    symbol,
    market_type: normalizeMarketType(input.market_type),
    market_item_id: normalizeText(input.market_item_id),
    asset_id: normalizeText(input.asset_id),
    instrument_id: null,
    chain,
    contract: normalizeContract(chain, input.contract),
    name: normalizeText(input.name),
    image: normalizeText(input.image),
    price_change_percentage_24h: normalizeFiniteNumber(input.price_change_percentage_24h),
  };
}

const NATIVE_COIN_ASSET_ID_BY_CHAIN: Record<string, string> = {
  eth: 'coingecko:ethereum',
  base: 'coingecko:ethereum',
  bnb: 'coingecko:binancecoin',
  sol: 'coingecko:solana',
  btc: 'coingecko:bitcoin',
};

function buildChainFallbackAssetId(chain: string, contract: string): string {
  return `chain:${normalizeMarketChain(chain)}:${toContractKey(contract, chain)}`;
}

async function resolveSpotAssetId(
  env: Bindings,
  chain: string,
  contract: string,
): Promise<string> {
  const normalizedChain = normalizeMarketChain(chain);
  const contractKey = toContractKey(contract, normalizedChain);
  if (contractKey === NATIVE_CONTRACT_KEY) {
    return NATIVE_COIN_ASSET_ID_BY_CHAIN[normalizedChain] ?? buildAssetId(normalizedChain, contractKey);
  }
  const coingeckoAssetId = await resolveCoinGeckoAssetIdForContract(env, normalizedChain, contractKey).catch(() => null);
  return coingeckoAssetId ?? buildChainFallbackAssetId(normalizedChain, contractKey);
}

async function resolveSpotAssetIdMap(
  env: Bindings,
  refs: Array<{ chain: string; contract: string }>,
): Promise<Map<string, string>> {
  const uniqueRefs = [...new Map(
    refs.map((item) => {
      const chain = normalizeMarketChain(item.chain);
      const contract = toContractKey(item.contract, chain);
      return [`${chain}:${contract}`, { chain, contract }] as const;
    }),
  ).values()];
  const resolved = await Promise.all(
    uniqueRefs.map(async (item) => [`${item.chain}:${item.contract}`, await resolveSpotAssetId(env, item.chain, item.contract)] as const),
  );
  return new Map(resolved);
}

export async function hydrateArticleRelatedAssets(
  env: Bindings,
  refs: ArticleRelatedAssetRef[],
): Promise<ArticleRelatedAsset[]> {
  const normalizedRefs = refs
    .map((item) => normalizeRef(item))
    .filter((value): value is NormalizedRelatedAssetRef => Boolean(value));
  if (!normalizedRefs.length) return [];

  const enriched = normalizedRefs.map((ref) => {
    const fallbackRoute = DEFAULT_TOKEN_ROUTE_BY_SYMBOL[ref.symbol] ?? null;
    const marketType = ref.market_type ?? (ref.chain || ref.contract ? 'spot' : null);
    const chain = marketType === 'spot'
      ? ref.chain ?? fallbackRoute?.chain ?? null
      : null;
    const contract = marketType === 'spot'
      ? ref.contract
        ?? fallbackRoute?.contract
        ?? null
      : null;

    return {
      symbol: ref.symbol,
      market_type: marketType,
      market_item_id: ref.market_item_id ?? null,
      asset_id: ref.asset_id ?? null,
      instrument_id: null,
      chain,
      contract,
      name: ref.name ?? fallbackRoute?.name ?? ref.symbol,
      image: ref.image ?? null,
      price_change_percentage_24h: ref.price_change_percentage_24h,
    };
  });

  const bitgetRequests = enriched
    .filter((item) => item.market_type === 'spot' && item.chain && item.contract && item.chain !== 'sol')
    .map((item) => ({
      chain: item.chain as string,
      contract: item.contract as string,
    }));
  const solContracts = enriched
    .filter((item) => item.market_type === 'spot' && item.chain === 'sol' && item.contract)
    .map((item) => item.contract as string);
  const marketRequests = enriched
    .filter((item) => item.market_type && item.market_type !== 'spot' && item.market_item_id)
    .map((item) => ({
      marketType: item.market_type as 'perp' | 'prediction',
      itemId: item.market_item_id as string,
    }));

  const [bitgetDetails, solanaDetails] = await Promise.all([
    fetchBitgetTokenDetails(env, bitgetRequests).catch(() => []),
    solContracts.length > 0 ? fetchSolanaTokenDetails(env, solContracts).catch(() => new Map()) : Promise.resolve(new Map()),
  ]);
  const spotAssetIdMap = await resolveSpotAssetIdMap(
    env,
    enriched
      .filter((item): item is ArticleRelatedAsset & { chain: string; contract: string } => Boolean(item.market_type === 'spot' && item.chain && item.contract))
      .map((item) => ({ chain: item.chain, contract: item.contract })),
  );

  const bitgetDetailByKey = new Map(bitgetDetails.map((item) => [`${item.chain}:${item.contract || 'native'}`, item.detail] as const));
  const marketDetailResults = await Promise.all(
    marketRequests.map(async (item) => {
      try {
        const detail = await fetchTradeMarketDetail(env, {
          type: item.marketType,
          id: item.itemId,
        });
        return [`${item.marketType}:${item.itemId}`, detail] as const;
      } catch {
        return [`${item.marketType}:${item.itemId}`, null] as const;
      }
    }),
  );
  const marketDetailByKey = new Map(marketDetailResults);

  return enriched.map((item) => {
    if (item.market_type === 'spot' && item.chain === 'sol' && item.contract) {
      const detail = solanaDetails.get(item.contract) ?? null;
      const assetId = spotAssetIdMap.get(`${item.chain}:${toContractKey(item.contract, item.chain)}`) ?? item.asset_id ?? null;
      return {
        ...item,
        asset_id: assetId,
        name: detail?.name ?? item.name,
        image: detail?.image ?? item.image,
        price_change_percentage_24h: detail?.priceChange24h ?? item.price_change_percentage_24h,
      };
    }

    if (item.market_type === 'spot' && item.chain && item.contract) {
      const detail = bitgetDetailByKey.get(`${item.chain}:${item.contract}`) ?? null;
      const assetId = spotAssetIdMap.get(`${item.chain}:${toContractKey(item.contract, item.chain)}`) ?? item.asset_id ?? null;
      return {
        ...item,
        asset_id: assetId,
        name: detail?.name ?? item.name,
        image: detail?.image ?? item.image,
        price_change_percentage_24h: detail?.priceChange24h ?? item.price_change_percentage_24h,
      };
    }

    if (item.market_type && item.market_type !== 'spot' && item.market_item_id) {
      const detail = marketDetailByKey.get(`${item.market_type}:${item.market_item_id}`) ?? null;
      if (!detail) return item;
      if (item.market_type === 'prediction') {
        const prediction = detail as { title?: string; image?: string | null };
        return {
          ...item,
          name: normalizeText(prediction.title) ?? item.name,
          image: normalizeText(prediction.image) ?? item.image,
        };
      }
      const market = detail as { name?: string; image?: string | null; change24h?: number | null };
      return {
        ...item,
        name: normalizeText(market.name) ?? item.name,
        image: normalizeText(market.image) ?? item.image,
        price_change_percentage_24h: normalizeFiniteNumber(market.change24h) ?? item.price_change_percentage_24h,
      };
    }

    return item;
  });
}
