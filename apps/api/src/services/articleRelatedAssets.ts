import { contractKeyToUpstreamContract } from './assetIdentity';
import {
  buildLegacyItemIdForInstrument,
  getAssetById,
  getInstrumentById,
  listAssetsByIds,
  listAssetsBySymbols,
  listInstrumentsByAssetIds,
  type AssetRecord,
  type InstrumentRecord,
} from './assetData';
import { fetchBitgetTokenDetails } from './bitgetWallet';
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
  instrument_id: string | null;
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

function instrumentContractToRouteContract(instrument: InstrumentRecord | null): string | null {
  if (!instrument?.contract_key) return null;
  if (instrument.contract_key === 'native') return 'native';
  return contractKeyToUpstreamContract(instrument.contract_key, instrument.chain);
}

function instrumentToMarketItemId(instrument: InstrumentRecord | null): string | null {
  if (!instrument) return null;
  return buildLegacyItemIdForInstrument(instrument);
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
    instrument_id: normalizeText(input.instrument_id),
    chain,
    contract: normalizeContract(chain, input.contract),
    name: normalizeText(input.name),
    image: normalizeText(input.image),
    price_change_percentage_24h: normalizeFiniteNumber(input.price_change_percentage_24h),
  };
}

function choosePreferredInstrument(instruments: InstrumentRecord[]): InstrumentRecord | null {
  if (!instruments.length) return null;
  const preferredSpot = instruments.find((item) => item.market_type === 'spot' && item.chain && item.contract_key);
  return preferredSpot ?? instruments[0] ?? null;
}

function choosePreferredInstrumentForType(
  instruments: InstrumentRecord[],
  marketType: 'spot' | 'perp' | 'prediction' | null,
): InstrumentRecord | null {
  if (!marketType) return choosePreferredInstrument(instruments);
  const exact = instruments.filter((item) => item.market_type === marketType);
  if (exact.length === 0) return choosePreferredInstrument(instruments);
  return choosePreferredInstrument(exact);
}

function scoreInstrument(instrument: InstrumentRecord | null): number {
  if (!instrument) return 0;
  let score = 0;
  if (instrument.market_type === 'spot') score += 10;
  if (instrument.chain && instrument.contract_key) score += 5;
  if (instrument.updated_at) score += Date.parse(instrument.updated_at) / 1e15;
  return score;
}

function buildResolvedInstrumentMaps(
  assets: AssetRecord[],
  instruments: InstrumentRecord[],
): {
  assetById: Map<string, AssetRecord>;
  preferredInstrumentByAssetId: Map<string, InstrumentRecord>;
  preferredInstrumentByAssetIdAndType: Map<string, InstrumentRecord>;
  bestAssetIdBySymbol: Map<string, string>;
} {
  const assetById = new Map<string, AssetRecord>();
  for (const asset of assets) {
    assetById.set(asset.asset_id, asset);
  }

  const byAssetId = new Map<string, InstrumentRecord[]>();
  for (const instrument of instruments) {
    const group = byAssetId.get(instrument.asset_id);
    if (group) {
      group.push(instrument);
    } else {
      byAssetId.set(instrument.asset_id, [instrument]);
    }
  }

  const preferredInstrumentByAssetId = new Map<string, InstrumentRecord>();
  const preferredInstrumentByAssetIdAndType = new Map<string, InstrumentRecord>();
  for (const [assetId, group] of byAssetId) {
    const preferred = choosePreferredInstrument(group);
    if (preferred) preferredInstrumentByAssetId.set(assetId, preferred);
    for (const marketType of ['spot', 'perp', 'prediction'] as const) {
      const typed = choosePreferredInstrumentForType(group, marketType);
      if (typed) preferredInstrumentByAssetIdAndType.set(`${assetId}:${marketType}`, typed);
    }
  }

  const bestAssetIdBySymbol = new Map<string, string>();
  for (const asset of assets) {
    const symbol = normalizeSymbol(asset.symbol);
    if (!symbol) continue;
    const nextInstrument = preferredInstrumentByAssetId.get(asset.asset_id) ?? null;
    const currentAssetId = bestAssetIdBySymbol.get(symbol);
    if (!currentAssetId) {
      bestAssetIdBySymbol.set(symbol, asset.asset_id);
      continue;
    }
    const currentInstrument = preferredInstrumentByAssetId.get(currentAssetId) ?? null;
    if (scoreInstrument(nextInstrument) > scoreInstrument(currentInstrument)) {
      bestAssetIdBySymbol.set(symbol, asset.asset_id);
    }
  }

  return {
    assetById,
    preferredInstrumentByAssetId,
    preferredInstrumentByAssetIdAndType,
    bestAssetIdBySymbol,
  };
}

export async function hydrateArticleRelatedAssets(
  env: Bindings,
  refs: ArticleRelatedAssetRef[],
): Promise<ArticleRelatedAsset[]> {
  const normalizedRefs = refs
    .map((item) => normalizeRef(item))
    .filter((value): value is NormalizedRelatedAssetRef => Boolean(value));
  if (!normalizedRefs.length) return [];

  const assetIds = normalizedRefs
    .map((item) => item.asset_id)
    .filter((value): value is string => Boolean(value));
  const unresolvedSymbols = normalizedRefs
    .filter((item) => !item.asset_id)
    .map((item) => item.symbol);

  const [assetsByIdRows, assetsBySymbolRows] = await Promise.all([
    listAssetsByIds(env.DB, assetIds),
    listAssetsBySymbols(env.DB, unresolvedSymbols),
  ]);
  const allAssetRows = [...new Map([...assetsByIdRows, ...assetsBySymbolRows].map((item) => [item.asset_id, item])).values()];
  const instrumentRows = await listInstrumentsByAssetIds(env.DB, allAssetRows.map((item) => item.asset_id));
  const { assetById, preferredInstrumentByAssetId, preferredInstrumentByAssetIdAndType, bestAssetIdBySymbol } =
    buildResolvedInstrumentMaps(allAssetRows, instrumentRows);

  const enriched = normalizedRefs.map((ref) => {
    const resolvedAssetId = ref.asset_id ?? bestAssetIdBySymbol.get(ref.symbol) ?? null;
    const assetRow = resolvedAssetId ? assetById.get(resolvedAssetId) ?? null : null;
    const preferredInstrument = resolvedAssetId
      ? preferredInstrumentByAssetIdAndType.get(`${resolvedAssetId}:${ref.market_type ?? 'spot'}`)
        ?? preferredInstrumentByAssetId.get(resolvedAssetId)
        ?? null
      : null;
    const fallbackRoute = DEFAULT_TOKEN_ROUTE_BY_SYMBOL[ref.symbol] ?? null;
    const marketType = ref.market_type ?? preferredInstrument?.market_type ?? (ref.chain || ref.contract ? 'spot' : null);
    const marketItemId = ref.market_item_id ?? instrumentToMarketItemId(preferredInstrument) ?? null;
    const chain = marketType === 'spot'
      ? ref.chain ?? preferredInstrument?.chain ?? fallbackRoute?.chain ?? null
      : null;
    const contract = marketType === 'spot'
      ? ref.contract
        ?? instrumentContractToRouteContract(preferredInstrument)
        ?? fallbackRoute?.contract
        ?? null
      : null;
    const name = ref.name ?? assetRow?.name ?? fallbackRoute?.name ?? ref.symbol;
    const image = ref.image ?? assetRow?.logo_uri ?? null;
    const instrumentId = ref.instrument_id ?? preferredInstrument?.instrument_id ?? null;

    return {
      symbol: ref.symbol,
      market_type: marketType,
      market_item_id: marketItemId,
      asset_id: resolvedAssetId,
      instrument_id: instrumentId,
      chain,
      contract,
      name,
      image,
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
      return {
        ...item,
        asset_id: item.asset_id ?? detail?.asset_id ?? null,
        name: detail?.name ?? item.name,
        image: detail?.image ?? item.image,
        price_change_percentage_24h: detail?.priceChange24h ?? item.price_change_percentage_24h,
      };
    }

    if (item.market_type === 'spot' && item.chain && item.contract) {
      const detail = bitgetDetailByKey.get(`${item.chain}:${item.contract}`) ?? null;
      return {
        ...item,
        asset_id: item.asset_id ?? detail?.asset_id ?? null,
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

export async function hydrateArticleRelatedAssetsFromInstrumentIds(
  env: Bindings,
  instrumentIds: string[],
): Promise<ArticleRelatedAsset[]> {
  const normalizedIds = [...new Set(instrumentIds.map((item) => normalizeText(item)).filter((value): value is string => Boolean(value)))];
  if (!normalizedIds.length) return [];
  const refs: ArticleRelatedAssetRef[] = [];
  for (const instrumentId of normalizedIds) {
    const instrument = await getInstrumentById(env.DB, instrumentId);
    if (!instrument) continue;
    const asset = await getAssetById(env.DB, instrument.asset_id);
    refs.push({
      symbol: asset?.symbol ?? instrument.symbol ?? '',
      market_type: instrument.market_type,
      market_item_id: buildLegacyItemIdForInstrument(instrument),
      asset_id: instrument.asset_id,
      instrument_id: instrument.instrument_id,
      chain: instrument.market_type === 'spot' ? instrument.chain : null,
      contract: instrument.market_type === 'spot' ? instrumentContractToRouteContract(instrument) : null,
      name: asset?.name ?? null,
      image: asset?.logo_uri ?? null,
    });
  }
  return hydrateArticleRelatedAssets(env, refs);
}
