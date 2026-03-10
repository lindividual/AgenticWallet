import { fetchBinanceStockDetail } from './binance';
import {
  NATIVE_CONTRACT_KEY,
  buildAssetId,
  contractKeyToUpstreamContract,
  normalizeMarketChain,
  toContractKey,
} from './assetIdentity';
import { resolveCoinGeckoAssetIdForContract } from './coingecko';
import type { Bindings } from '../types';
import { nowIso } from '../utils/time';

export type AssetClass = 'crypto' | 'equity_exposure' | 'event_outcome' | 'fiat' | 'index';
export type MarketType = 'spot' | 'perp' | 'prediction';

export type ResolveAssetInput = {
  chain?: string | null;
  contract?: string | null;
  itemId?: string | null;
  marketType?: string | null;
  venue?: string | null;
  symbol?: string | null;
  marketId?: string | null;
  outcomeId?: string | null;
  assetClassHint?: AssetClass | null;
  nameHint?: string | null;
};

export type ResolvedAsset = {
  asset_id: string;
  instrument_id: string;
  market_type: MarketType;
  confidence: number;
};

export type ResolveAssetBatchResult =
  | {
      ok: true;
      result: ResolvedAsset;
    }
  | {
      ok: false;
      error: string;
    };

export type AssetRecord = {
  asset_id: string;
  asset_class: AssetClass;
  symbol: string | null;
  name: string | null;
  logo_uri: string | null;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
};

export type InstrumentRecord = {
  instrument_id: string;
  asset_id: string;
  market_type: MarketType;
  venue: string | null;
  symbol: string | null;
  chain: string | null;
  contract_key: string | null;
  source: string;
  source_item_id: string | null;
  metadata_json: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

const NATIVE_SYMBOL_BY_CHAIN: Record<string, string> = {
  eth: 'ETH',
  base: 'ETH',
  bnb: 'BNB',
};

let assetSchemaReady = false;

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeLower(raw: unknown): string | null {
  const value = normalizeText(raw);
  return value ? value.toLowerCase() : null;
}

function toSlug(raw: unknown): string {
  const value = normalizeText(raw)?.toLowerCase() ?? 'unknown';
  return value
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown';
}

function normalizeAssetClass(raw: unknown): AssetClass {
  const value = normalizeLower(raw);
  if (value === 'equity_exposure') return 'equity_exposure';
  if (value === 'event_outcome') return 'event_outcome';
  if (value === 'fiat') return 'fiat';
  if (value === 'index') return 'index';
  return 'crypto';
}

function normalizeMarketType(raw: unknown): MarketType | null {
  const value = normalizeLower(raw);
  if (value === 'spot' || value === 'perp' || value === 'prediction') {
    return value;
  }
  return null;
}

function buildSpotInstrumentId(chain: string, contractKey: string): string {
  return `ins:spot:${normalizeMarketChain(chain)}:${toContractKey(contractKey)}`;
}

function buildPerpInstrumentId(venue: string, symbol: string): string {
  return `ins:perp:${toSlug(venue)}:${toSlug(symbol)}`;
}

function buildPredictionInstrumentId(venue: string, marketId: string, outcomeId: string): string {
  return `ins:pred:${toSlug(venue)}:${toSlug(marketId)}:${toSlug(outcomeId)}`;
}

function buildPredictionAssetId(venue: string, marketId: string, outcomeId: string): string {
  return `ast:event_outcome:${toSlug(venue)}:${toSlug(marketId)}:${toSlug(outcomeId)}`;
}

function buildEquityAssetId(ticker: string): string {
  return `ast:equity:${toSlug(ticker)}`;
}

function normalizePerpUnderlyingSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (!upper) return 'UNKNOWN';

  const slashIndex = upper.indexOf('/');
  if (slashIndex > 0) return upper.slice(0, slashIndex);

  const dashIndex = upper.indexOf('-');
  if (dashIndex > 0) return upper.slice(0, dashIndex);

  if (upper.endsWith('USDT')) return upper.slice(0, -4) || upper;
  if (upper.endsWith('USDC')) return upper.slice(0, -4) || upper;
  if (upper.endsWith('USD')) return upper.slice(0, -3) || upper;
  return upper;
}

function toResolveBatchCacheKey(input: ResolveAssetInput): string {
  const chain = normalizeText(input.chain);
  if (chain) {
    const normalizedChain = normalizeMarketChain(chain);
    const contractKey = toContractKey(input.contract ?? NATIVE_CONTRACT_KEY);
    const marketType = normalizeMarketType(input.marketType) ?? 'spot';
    const assetClass = normalizeAssetClass(input.assetClassHint ?? 'crypto');
    const symbol = normalizeText(input.symbol)?.toUpperCase() ?? '';
    return `spot|${marketType}|${normalizedChain}|${contractKey}|${assetClass}|${symbol}`;
  }

  const itemId = normalizeText(input.itemId);
  if (itemId) {
    return `item|${itemId.toLowerCase()}`;
  }

  const marketType = normalizeMarketType(input.marketType) ?? 'unknown';
  const venue = normalizeLower(input.venue) ?? 'unknown';
  const symbol = normalizeText(input.symbol)?.toUpperCase() ?? '';
  const marketId = normalizeText(input.marketId)?.toLowerCase() ?? '';
  const outcomeId = normalizeText(input.outcomeId)?.toLowerCase() ?? '';
  const assetClass = normalizeAssetClass(input.assetClassHint ?? 'crypto');
  return `generic|${marketType}|${venue}|${symbol}|${marketId}|${outcomeId}|${assetClass}`;
}

async function ensureAssetSchema(db: D1Database): Promise<void> {
  if (assetSchemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS assets (
        asset_id TEXT PRIMARY KEY,
        asset_class TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        logo_uri TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'resolver',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_assets_class ON assets(asset_class)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_assets_symbol ON assets(symbol)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_assets_updated_at ON assets(updated_at DESC)').run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS instruments (
        instrument_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        market_type TEXT NOT NULL,
        venue TEXT,
        symbol TEXT,
        chain TEXT,
        contract_key TEXT,
        source TEXT NOT NULL DEFAULT 'resolver',
        source_item_id TEXT,
        metadata_json TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
      )`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_instruments_asset_id ON instruments(asset_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_instruments_market_type ON instruments(market_type)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_instruments_source_item_id ON instruments(source_item_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_instruments_chain_contract ON instruments(chain, contract_key)').run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS instrument_refs (
        provider TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        instrument_id TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider, provider_key),
        FOREIGN KEY(instrument_id) REFERENCES instruments(instrument_id)
      )`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_instrument_refs_instrument_id ON instrument_refs(instrument_id)').run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS asset_links (
        source_asset_id TEXT NOT NULL,
        target_asset_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_asset_id, target_asset_id, link_type),
        FOREIGN KEY(source_asset_id) REFERENCES assets(asset_id),
        FOREIGN KEY(target_asset_id) REFERENCES assets(asset_id)
      )`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_asset_links_target ON asset_links(target_asset_id, link_type)').run();

  assetSchemaReady = true;
}

async function upsertAsset(
  db: D1Database,
  input: {
    assetId: string;
    assetClass: AssetClass;
    symbol?: string | null;
    name?: string | null;
    source?: string;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO assets (asset_id, asset_class, symbol, name, logo_uri, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         asset_class = excluded.asset_class,
         symbol = COALESCE(excluded.symbol, assets.symbol),
         name = COALESCE(excluded.name, assets.name),
         source = excluded.source,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.assetId,
      input.assetClass,
      normalizeText(input.symbol)?.toUpperCase() ?? null,
      normalizeText(input.name) ?? null,
      normalizeText(input.source) ?? 'resolver',
      now,
      now,
    )
    .run();
}

async function upsertInstrument(
  db: D1Database,
  input: {
    instrumentId: string;
    assetId: string;
    marketType: MarketType;
    venue?: string | null;
    symbol?: string | null;
    chain?: string | null;
    contractKey?: string | null;
    source?: string;
    sourceItemId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  const now = nowIso();
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
  await db
    .prepare(
      `INSERT INTO instruments (
         instrument_id, asset_id, market_type, venue, symbol, chain, contract_key, source, source_item_id,
         metadata_json, status, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(instrument_id) DO UPDATE SET
         asset_id = excluded.asset_id,
         market_type = excluded.market_type,
         venue = COALESCE(excluded.venue, instruments.venue),
         symbol = COALESCE(excluded.symbol, instruments.symbol),
         chain = COALESCE(excluded.chain, instruments.chain),
         contract_key = COALESCE(excluded.contract_key, instruments.contract_key),
         source = excluded.source,
         source_item_id = COALESCE(excluded.source_item_id, instruments.source_item_id),
         metadata_json = COALESCE(excluded.metadata_json, instruments.metadata_json),
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.instrumentId,
      input.assetId,
      input.marketType,
      normalizeLower(input.venue),
      normalizeText(input.symbol)?.toUpperCase() ?? null,
      normalizeLower(input.chain),
      normalizeLower(input.contractKey),
      normalizeText(input.source) ?? 'resolver',
      normalizeText(input.sourceItemId),
      metadataJson,
      now,
      now,
    )
    .run();
}

async function upsertInstrumentRef(
  db: D1Database,
  input: {
    provider: string;
    providerKey: string;
    instrumentId: string;
    confidence?: number;
  },
): Promise<void> {
  const provider = normalizeLower(input.provider);
  const providerKey = normalizeLower(input.providerKey);
  if (!provider || !providerKey) return;

  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO instrument_refs (provider, provider_key, instrument_id, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, provider_key) DO UPDATE SET
         instrument_id = excluded.instrument_id,
         confidence = excluded.confidence,
         updated_at = excluded.updated_at`,
    )
    .bind(provider, providerKey, input.instrumentId, Number(input.confidence ?? 1), now, now)
    .run();
}

async function resolveSpotIdentity(
  env: Bindings,
  input: {
    chain: string;
    contract: string;
    assetClass?: AssetClass;
    symbol?: string | null;
    name?: string | null;
    sourceItemId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<ResolvedAsset> {
  const chain = normalizeMarketChain(input.chain);
  const contractKey = toContractKey(input.contract);
  const instrumentId = buildSpotInstrumentId(chain, contractKey);

  let preferredAssetId: string | null = null;
  if (contractKey !== NATIVE_CONTRACT_KEY) {
    try {
      preferredAssetId = await resolveCoinGeckoAssetIdForContract(env, chain, contractKey);
    } catch {
      preferredAssetId = null;
    }
  }

  let assetId = buildAssetId(chain, contractKey, preferredAssetId);
  const assetClass = normalizeAssetClass(input.assetClass ?? 'crypto');
  if (assetClass === 'equity_exposure' && input.symbol) {
    assetId = buildEquityAssetId(input.symbol);
  }

  const symbol = normalizeText(input.symbol)?.toUpperCase()
    ?? (contractKey === NATIVE_CONTRACT_KEY ? NATIVE_SYMBOL_BY_CHAIN[chain] ?? null : null);
  const name = normalizeText(input.name);

  await upsertAsset(env.DB, {
    assetId,
    assetClass,
    symbol,
    name,
    source: preferredAssetId?.startsWith('coingecko:') ? 'coingecko' : 'resolver',
  });

  await upsertInstrument(env.DB, {
    instrumentId,
    assetId,
    marketType: 'spot',
    chain,
    contractKey,
    source: 'resolver',
    sourceItemId: input.sourceItemId ?? null,
    symbol,
    metadata: input.metadata ?? null,
  });

  await upsertInstrumentRef(env.DB, {
    provider: 'evm',
    providerKey: `${chain}:${contractKey}`,
    instrumentId,
    confidence: 1,
  });

  if (preferredAssetId?.startsWith('coingecko:')) {
    await upsertInstrumentRef(env.DB, {
      provider: 'coingecko',
      providerKey: `${chain}:${contractKey}`,
      instrumentId,
      confidence: 0.95,
    });
  }

  if (input.sourceItemId) {
    await upsertInstrumentRef(env.DB, {
      provider: 'source_item',
      providerKey: input.sourceItemId,
      instrumentId,
      confidence: 1,
    });
  }

  return {
    asset_id: assetId,
    instrument_id: instrumentId,
    market_type: 'spot',
    confidence: preferredAssetId ? 0.95 : 0.85,
  };
}

async function resolvePerpIdentity(
  env: Bindings,
  input: {
    venue: string;
    symbol: string;
    sourceItemId?: string | null;
  },
): Promise<ResolvedAsset> {
  const venue = normalizeLower(input.venue);
  const symbol = normalizeText(input.symbol)?.toUpperCase();
  if (!venue || !symbol) {
    throw new Error('invalid_perp_identity');
  }

  const underlyingSymbol = normalizePerpUnderlyingSymbol(symbol);
  const assetId = `ast:crypto:${toSlug(underlyingSymbol)}`;
  const instrumentId = buildPerpInstrumentId(venue, symbol);
  const sourceItemId = normalizeText(input.sourceItemId) ?? `${venue}:${symbol}`;

  await upsertAsset(env.DB, {
    assetId,
    assetClass: 'crypto',
    symbol: underlyingSymbol,
    name: underlyingSymbol,
    source: 'resolver',
  });

  await upsertInstrument(env.DB, {
    instrumentId,
    assetId,
    marketType: 'perp',
    venue,
    symbol,
    source: 'resolver',
    sourceItemId,
    metadata: {
      underlying_symbol: underlyingSymbol,
    },
  });

  await upsertInstrumentRef(env.DB, {
    provider: venue,
    providerKey: symbol,
    instrumentId,
    confidence: 1,
  });
  await upsertInstrumentRef(env.DB, {
    provider: 'source_item',
    providerKey: sourceItemId,
    instrumentId,
    confidence: 1,
  });

  return {
    asset_id: assetId,
    instrument_id: instrumentId,
    market_type: 'perp',
    confidence: 0.9,
  };
}

async function resolvePredictionIdentity(
  env: Bindings,
  input: {
    venue: string;
    marketId: string;
    outcomeId: string;
    sourceItemId?: string | null;
  },
): Promise<ResolvedAsset> {
  const venue = normalizeLower(input.venue);
  const marketId = normalizeText(input.marketId);
  const outcomeId = normalizeText(input.outcomeId);
  if (!venue || !marketId || !outcomeId) {
    throw new Error('invalid_prediction_identity');
  }

  const assetId = buildPredictionAssetId(venue, marketId, outcomeId);
  const instrumentId = buildPredictionInstrumentId(venue, marketId, outcomeId);
  const sourceItemId = normalizeText(input.sourceItemId) ?? `${venue}:${marketId}`;

  await upsertAsset(env.DB, {
    assetId,
    assetClass: 'event_outcome',
    symbol: outcomeId,
    name: `${marketId}:${outcomeId}`,
    source: 'resolver',
  });

  await upsertInstrument(env.DB, {
    instrumentId,
    assetId,
    marketType: 'prediction',
    venue,
    symbol: outcomeId,
    source: 'resolver',
    sourceItemId,
    metadata: {
      market_id: marketId,
      outcome_id: outcomeId,
    },
  });

  await upsertInstrumentRef(env.DB, {
    provider: venue,
    providerKey: `${marketId}:${outcomeId}`,
    instrumentId,
    confidence: 1,
  });
  await upsertInstrumentRef(env.DB, {
    provider: 'source_item',
    providerKey: sourceItemId,
    instrumentId,
    confidence: 1,
  });

  return {
    asset_id: assetId,
    instrument_id: instrumentId,
    market_type: 'prediction',
    confidence: 0.9,
  };
}

async function resolveByItemId(env: Bindings, itemId: string): Promise<ResolvedAsset> {
  const normalized = normalizeText(itemId);
  if (!normalized) {
    throw new Error('invalid_item_id');
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith('ins:')) {
    const existing = await getInstrumentById(env.DB, normalized);
    if (!existing) {
      throw new Error('instrument_not_found');
    }
    return {
      asset_id: existing.asset_id,
      instrument_id: existing.instrument_id,
      market_type: existing.market_type,
      confidence: 1,
    };
  }

  if (lower.startsWith('hyperliquid:')) {
    const symbol = normalized.slice('hyperliquid:'.length);
    return resolvePerpIdentity(env, {
      venue: 'hyperliquid',
      symbol,
      sourceItemId: normalized,
    });
  }

  if (lower.startsWith('polymarket:')) {
    const marketId = normalized.slice('polymarket:'.length);
    return resolvePredictionIdentity(env, {
      venue: 'polymarket',
      marketId,
      outcomeId: 'default',
      sourceItemId: normalized,
    });
  }

  if (lower.startsWith('binance-stock:')) {
    const alphaId = normalizeText(normalized.slice('binance-stock:'.length));
    if (!alphaId) {
      throw new Error('invalid_binance_stock_id');
    }

    const detail = await fetchBinanceStockDetail(alphaId);
    if (!detail) {
      throw new Error('stock_item_not_found');
    }

    return resolveSpotIdentity(env, {
      chain: detail.chain,
      contract: detail.contract,
      assetClass: 'equity_exposure',
      symbol: detail.stockTicker || detail.symbol,
      name: detail.name,
      sourceItemId: normalized,
      metadata: {
        underlying_ticker: detail.stockTicker,
        alpha_id: detail.alphaId,
      },
    });
  }

  const chainAssetPrefixes = ['evm:', 'svm:'];
  const matchedPrefix = chainAssetPrefixes.find((prefix) => lower.startsWith(prefix)) ?? null;
  if (matchedPrefix) {
    const rest = normalized.slice(matchedPrefix.length);
    const [chain, contract = NATIVE_CONTRACT_KEY] = rest.split(':');
    if (!chain) {
      throw new Error('invalid_chain_asset_id');
    }
    return resolveSpotIdentity(env, {
      chain,
      contract,
      assetClass: 'crypto',
      sourceItemId: normalized,
    });
  }

  throw new Error('unsupported_item_id');
}

export async function resolveAssetIdentity(env: Bindings, input: ResolveAssetInput): Promise<ResolvedAsset> {
  await ensureAssetSchema(env.DB);

  const explicitMarketType = normalizeMarketType(input.marketType);
  const chain = normalizeText(input.chain);
  if (chain) {
    return resolveSpotIdentity(env, {
      chain,
      contract: input.contract ?? NATIVE_CONTRACT_KEY,
      assetClass: input.assetClassHint ?? 'crypto',
      symbol: input.symbol,
      name: input.nameHint,
    });
  }

  const itemId = normalizeText(input.itemId);
  if (itemId) {
    return resolveByItemId(env, itemId);
  }

  if (explicitMarketType === 'perp') {
    return resolvePerpIdentity(env, {
      venue: input.venue ?? 'unknown',
      symbol: input.symbol ?? '',
    });
  }

  if (explicitMarketType === 'prediction') {
    return resolvePredictionIdentity(env, {
      venue: input.venue ?? 'unknown',
      marketId: input.marketId ?? '',
      outcomeId: input.outcomeId ?? 'default',
    });
  }

  throw new Error('invalid_asset_resolve_input');
}

export async function resolveAssetIdentityBatch(
  env: Bindings,
  inputs: ResolveAssetInput[],
): Promise<ResolveAssetBatchResult[]> {
  if (!inputs.length) return [];
  await ensureAssetSchema(env.DB);

  const cache = new Map<string, Promise<ResolvedAsset>>();
  return Promise.all(
    inputs.map(async (input) => {
      const cacheKey = toResolveBatchCacheKey(input);
      let task = cache.get(cacheKey);
      if (!task) {
        task = resolveAssetIdentity(env, input);
        cache.set(cacheKey, task);
      }

      try {
        const result = await task;
        return { ok: true, result } satisfies ResolveAssetBatchResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'asset_resolve_failed';
        return { ok: false, error: message } satisfies ResolveAssetBatchResult;
      }
    }),
  );
}

export async function getAssetById(db: D1Database, assetId: string): Promise<AssetRecord | null> {
  await ensureAssetSchema(db);
  const row = await db
    .prepare(
      `SELECT asset_id, asset_class, symbol, name, logo_uri, status, source, created_at, updated_at
       FROM assets WHERE asset_id = ? LIMIT 1`,
    )
    .bind(assetId)
    .first<AssetRecord>();

  return row ?? null;
}

export async function listInstrumentsByAssetId(db: D1Database, assetId: string): Promise<InstrumentRecord[]> {
  await ensureAssetSchema(db);
  const result = await db
    .prepare(
      `SELECT instrument_id, asset_id, market_type, venue, symbol, chain, contract_key, source, source_item_id,
              metadata_json, status, created_at, updated_at
       FROM instruments
       WHERE asset_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(assetId)
    .all<InstrumentRecord>();
  return result.results ?? [];
}

export async function getInstrumentById(db: D1Database, instrumentId: string): Promise<InstrumentRecord | null> {
  await ensureAssetSchema(db);
  const row = await db
    .prepare(
      `SELECT instrument_id, asset_id, market_type, venue, symbol, chain, contract_key, source, source_item_id,
              metadata_json, status, created_at, updated_at
       FROM instruments
       WHERE instrument_id = ?
       LIMIT 1`,
    )
    .bind(instrumentId)
    .first<InstrumentRecord>();
  return row ?? null;
}

export async function getInstrumentRefs(
  db: D1Database,
  instrumentId: string,
): Promise<Array<{ provider: string; provider_key: string; confidence: number }>> {
  await ensureAssetSchema(db);
  const result = await db
    .prepare(
      `SELECT provider, provider_key, confidence
       FROM instrument_refs
       WHERE instrument_id = ?
       ORDER BY confidence DESC, provider ASC`,
    )
    .bind(instrumentId)
    .all<{ provider: string; provider_key: string; confidence: number }>();
  return result.results ?? [];
}

export function parseInstrumentMetadata(instrument: InstrumentRecord): Record<string, unknown> {
  const raw = normalizeText(instrument.metadata_json);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function buildLegacyItemIdForInstrument(instrument: InstrumentRecord): string | null {
  const sourceItemId = normalizeText(instrument.source_item_id);
  if (sourceItemId) return sourceItemId;

  if (instrument.market_type === 'perp') {
    const venue = normalizeLower(instrument.venue);
    const symbol = normalizeText(instrument.symbol)?.toUpperCase();
    if (!venue || !symbol) return null;
    return `${venue}:${symbol}`;
  }

  if (instrument.market_type === 'prediction') {
    const venue = normalizeLower(instrument.venue);
    if (!venue) return null;
    const metadata = parseInstrumentMetadata(instrument);
    const marketId = normalizeText(metadata.market_id);
    if (!marketId) return null;
    return `${venue}:${marketId}`;
  }

  return null;
}

export function toSpotLookupFromInstrument(
  instrument: InstrumentRecord,
): { chain: string; contract: string } | null {
  const chain = normalizeLower(instrument.chain);
  const contractKey = normalizeLower(instrument.contract_key);
  if (!chain || !contractKey) return null;
  return {
    chain,
    contract: contractKeyToUpstreamContract(contractKey),
  };
}
