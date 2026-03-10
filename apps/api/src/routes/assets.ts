import type { Hono } from 'hono';
import { fetchBinanceSpotKlines } from '../services/binance';
import {
  buildLegacyItemIdForInstrument,
  getAssetById,
  getInstrumentById,
  getInstrumentRefs,
  listInstrumentsByAssetId,
  parseInstrumentMetadata,
  resolveAssetIdentity,
  resolveAssetIdentityBatch,
  toSpotLookupFromInstrument,
} from '../services/assetData';
import { fetchBitgetTokenDetail, fetchBitgetTokenKline } from '../services/bitgetWallet';
import { isKlineStale, shouldPreferFallbackCandles } from '../services/klineFreshness';
import { fetchTradeMarketDetail, fetchTradeMarketKline } from '../services/tradeBrowse';
import type { AppEnv } from '../types';

function toValidSize(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(10, Math.min(Math.trunc(value), 240));
}

function toUpperSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return value || null;
}

function augmentTokenDetailAliases<T extends {
  currentPriceUsd?: number | null;
  priceChange24h?: number | null;
}>(detail: T): T & {
  currentPrice: number | null;
  change24h: number | null;
} {
  return {
    ...detail,
    currentPrice: detail.currentPriceUsd ?? null,
    change24h: detail.priceChange24h ?? null,
  };
}

export function registerAssetRoutes(app: Hono<AppEnv>): void {
  app.post('/v1/assets/resolve', async (c) => {
    const body = await c.req
      .json<{
        chain?: string;
        contract?: string;
        itemId?: string;
        marketType?: string;
        venue?: string;
        symbol?: string;
        marketId?: string;
        outcomeId?: string;
        assetClassHint?: 'crypto' | 'equity_exposure' | 'event_outcome' | 'fiat' | 'index';
        nameHint?: string;
      }>()
      .catch(() => null);

    if (!body) {
      return c.json({ error: 'invalid_resolve_payload' }, 400);
    }

    try {
      const resolved = await resolveAssetIdentity(c.env, body);
      return c.json(resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'asset_resolve_failed';
      const status = message.startsWith('invalid_') || message.startsWith('unsupported_') ? 400 : 502;
      return c.json({ error: message }, status);
    }
  });

  app.post('/v1/assets/resolve/batch', async (c) => {
    const body = await c.req
      .json<{
        items?: Array<{
          chain?: string;
          contract?: string;
          itemId?: string;
          marketType?: string;
          venue?: string;
          symbol?: string;
          marketId?: string;
          outcomeId?: string;
          assetClassHint?: 'crypto' | 'equity_exposure' | 'event_outcome' | 'fiat' | 'index';
          nameHint?: string;
        }>;
      }>()
      .catch(() => null);

    const items = body?.items ?? null;
    if (!items || !Array.isArray(items)) {
      return c.json({ error: 'invalid_resolve_batch_payload' }, 400);
    }
    if (items.length > 500) {
      return c.json({ error: 'resolve_batch_too_large' }, 400);
    }

    const results = await resolveAssetIdentityBatch(c.env, items);
    return c.json({ results });
  });

  app.get('/v1/assets/:assetId', async (c) => {
    const assetId = c.req.param('assetId');
    if (!assetId?.trim()) {
      return c.json({ error: 'invalid_asset_id' }, 400);
    }

    const asset = await getAssetById(c.env.DB, assetId.trim());
    if (!asset) {
      return c.json({ error: 'asset_not_found' }, 404);
    }

    const instruments = await listInstrumentsByAssetId(c.env.DB, asset.asset_id);
    return c.json({
      asset,
      marketCount: instruments.length,
      defaultInstrumentId: instruments[0]?.instrument_id ?? null,
      instruments: instruments.slice(0, 5).map((item) => ({
        instrument_id: item.instrument_id,
        market_type: item.market_type,
        venue: item.venue,
        symbol: item.symbol,
        chain: item.chain,
        contract_key: item.contract_key,
      })),
    });
  });

  app.get('/v1/assets/:assetId/instruments', async (c) => {
    const assetId = c.req.param('assetId');
    if (!assetId?.trim()) {
      return c.json({ error: 'invalid_asset_id' }, 400);
    }

    const asset = await getAssetById(c.env.DB, assetId.trim());
    if (!asset) {
      return c.json({ error: 'asset_not_found' }, 404);
    }

    const instruments = await listInstrumentsByAssetId(c.env.DB, asset.asset_id);
    return c.json({
      asset_id: asset.asset_id,
      instruments: instruments.map((item) => ({
        ...item,
        metadata: parseInstrumentMetadata(item),
      })),
    });
  });

  app.get('/v1/markets/:instrumentId', async (c) => {
    const instrumentId = c.req.param('instrumentId');
    if (!instrumentId?.trim()) {
      return c.json({ error: 'invalid_instrument_id' }, 400);
    }

    const instrument = await getInstrumentById(c.env.DB, instrumentId.trim());
    if (!instrument) {
      return c.json({ error: 'instrument_not_found' }, 404);
    }

    const asset = await getAssetById(c.env.DB, instrument.asset_id);
    const refs = await getInstrumentRefs(c.env.DB, instrument.instrument_id);
    let providerDetail: unknown = null;

    try {
      if (instrument.market_type === 'spot') {
        const sourceItemId = (instrument.source_item_id ?? '').trim().toLowerCase();
        if (sourceItemId.startsWith('binance-stock:')) {
          providerDetail = await fetchTradeMarketDetail(c.env, {
            type: 'stock',
            id: instrument.source_item_id ?? '',
          });
        } else {
          const spotLookup = toSpotLookupFromInstrument(instrument);
          if (spotLookup) {
            const detail = await fetchBitgetTokenDetail(c.env, spotLookup.chain, spotLookup.contract);
            providerDetail = detail ? augmentTokenDetailAliases(detail) : null;
          }
        }
      } else if (instrument.market_type === 'perp') {
        const itemId = buildLegacyItemIdForInstrument(instrument);
        if (itemId) {
          providerDetail = await fetchTradeMarketDetail(c.env, {
            type: 'perp',
            id: itemId,
          });
        }
      } else if (instrument.market_type === 'prediction') {
        const itemId = buildLegacyItemIdForInstrument(instrument);
        if (itemId) {
          providerDetail = await fetchTradeMarketDetail(c.env, {
            type: 'prediction',
            id: itemId,
          });
        }
      }
    } catch {
      providerDetail = null;
    }

    return c.json({
      instrument: {
        ...instrument,
        metadata: parseInstrumentMetadata(instrument),
      },
      asset,
      refs,
      providerDetail,
    });
  });

  app.get('/v1/markets/:instrumentId/candles', async (c) => {
    const instrumentId = c.req.param('instrumentId');
    if (!instrumentId?.trim()) {
      return c.json({ error: 'invalid_instrument_id' }, 400);
    }

    const period = (c.req.query('period') ?? '1h').trim();
    const size = toValidSize(c.req.query('size'), 60);
    const optionTokenId = (c.req.query('optionTokenId') ?? '').trim() || null;

    const instrument = await getInstrumentById(c.env.DB, instrumentId.trim());
    if (!instrument) {
      return c.json({ error: 'instrument_not_found' }, 404);
    }

    try {
      if (instrument.market_type === 'spot') {
        const sourceItemId = (instrument.source_item_id ?? '').trim().toLowerCase();
        if (sourceItemId.startsWith('binance-stock:')) {
          const candles = await fetchTradeMarketKline(c.env, {
            type: 'stock',
            id: instrument.source_item_id ?? '',
            period,
            size,
          });
          return c.json({ instrumentId: instrument.instrument_id, period, candles });
        }

        const spotLookup = toSpotLookupFromInstrument(instrument);
        if (!spotLookup) {
          return c.json({ error: 'spot_instrument_lookup_failed' }, 400);
        }

        const resolveBinanceFallbackCandles = async (): Promise<null | Awaited<ReturnType<typeof fetchBinanceSpotKlines>>> => {
          let symbol = toUpperSymbol(instrument.symbol);
          if (!symbol) {
            try {
              const detail = await fetchBitgetTokenDetail(c.env, spotLookup.chain, spotLookup.contract);
              symbol = toUpperSymbol(detail?.symbol);
            } catch {
              symbol = null;
            }
          }
          if (!symbol) return null;
          const fallback = await fetchBinanceSpotKlines(symbol, period, size);
          return fallback.length > 0 ? fallback : null;
        };

        let candles: Awaited<ReturnType<typeof fetchBitgetTokenKline>>;
        try {
          candles = await fetchBitgetTokenKline(c.env, {
            chain: spotLookup.chain,
            contract: spotLookup.contract,
            period,
            size,
          });
        } catch (error) {
          const fallback = await resolveBinanceFallbackCandles();
          if (fallback) {
            return c.json({ instrumentId: instrument.instrument_id, period, candles: fallback, source: 'binance_spot_fallback' });
          }
          throw error;
        }

        if (!candles.length) {
          const fallback = await resolveBinanceFallbackCandles();
          if (fallback && shouldPreferFallbackCandles(candles, fallback, period)) {
            return c.json({ instrumentId: instrument.instrument_id, period, candles: fallback, source: 'binance_spot_fallback' });
          }
        }
        if (candles.length && isKlineStale(candles, period)) {
          const fallback = await resolveBinanceFallbackCandles();
          if (fallback && shouldPreferFallbackCandles(candles, fallback, period)) {
            return c.json({ instrumentId: instrument.instrument_id, period, candles: fallback, source: 'binance_spot_fallback' });
          }
        }
        return c.json({ instrumentId: instrument.instrument_id, period, candles });
      }

      if (instrument.market_type === 'perp') {
        const itemId = buildLegacyItemIdForInstrument(instrument);
        if (!itemId) {
          return c.json({ error: 'perp_item_id_not_found' }, 400);
        }
        const candles = await fetchTradeMarketKline(c.env, {
          type: 'perp',
          id: itemId,
          period,
          size,
        });
        return c.json({ instrumentId: instrument.instrument_id, period, candles });
      }

      if (instrument.market_type === 'prediction') {
        const itemId = buildLegacyItemIdForInstrument(instrument);
        if (!itemId) {
          return c.json({ error: 'prediction_item_id_not_found' }, 400);
        }
        const candles = await fetchTradeMarketKline(c.env, {
          type: 'prediction',
          id: itemId,
          period,
          size,
          optionTokenId,
        });
        return c.json({ instrumentId: instrument.instrument_id, period, candles });
      }

      return c.json({ error: 'unsupported_market_type' }, 400);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      if (message.includes('bgw_http_429')) {
        return c.json(
          {
            error: 'market_candles_rate_limited',
            message,
          },
          429,
        );
      }
      return c.json(
        {
          error: 'market_candles_failed',
          message,
        },
        502,
      );
    }
  });
}
