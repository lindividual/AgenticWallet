import type { Bindings } from '../types';
import { nowIso } from '../utils/time';
import { getMarketChainByChainId, getSupportedChainIds } from '../config/appConfig';
import { buildAssetId, buildChainAssetId, NATIVE_CONTRACT_KEY } from './assetIdentity';
import { resolveCoinGeckoAssetIdForContract } from './coingecko';

type SimBalanceRow = {
  chain: string;
  chain_id: number;
  address: string;
  asset_id?: string;
  chain_asset_id?: string;
  amount: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  price_usd?: number;
  value_usd?: number;
  logo?: string;
  logo_uri?: string;
  url?: string;
  token_metadata?: {
    logo?: string;
    logoURI?: string;
    url?: string;
  };
};

export type MergedHoldingVariant = SimBalanceRow & {
  market_chain: string;
  contract_key: string;
  chain_asset_id: string;
  asset_id: string;
};

export type MergedPortfolioHolding = {
  asset_id: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  total_value_usd: number;
  variants: MergedHoldingVariant[];
};

type SimBalancesResponse = {
  wallet_address: string;
  balances: SimBalanceRow[];
  error?: string;
  message?: string;
};

type TokenList = {
  tokens?: Array<{
    chainId?: number;
    address?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    logoURI?: string;
  }>;
};

const DEFAULT_TOKEN_LIST_URLS = [
  'https://tokens.uniswap.org',
  'https://raw.githubusercontent.com/pancakeswap/token-list/main/lists/pancakeswap-extended.json',
];

const FALLBACK_ASSET_NAME_BY_ID: Record<string, string> = {
  'coingecko:ethereum': 'Ethereum',
  'coingecko:binancecoin': 'BNB',
  'coingecko:bitcoin': 'Bitcoin',
  'coingecko:tether': 'Tether',
  'coingecko:usd-coin': 'USD Coin',
};

const FALLBACK_ASSET_NAME_BY_SYMBOL: Record<string, string> = {
  ETH: 'Ethereum',
  BNB: 'BNB',
  BTC: 'Bitcoin',
  USDT: 'Tether',
  USDC: 'USD Coin',
};

let tokenCatalogSchemaReady = false;
let aggregatedAssetCatalogSchemaReady = false;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clampInt(parsed, min, max);
}

function normalizeAddress(raw: string | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  return normalized;
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeAssetId(raw: unknown): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  return value.toLowerCase();
}

function parseCoingeckoCoinIdFromAssetId(assetId: string | null | undefined): string | null {
  const value = normalizeText(assetId)?.toLowerCase();
  if (!value || !value.startsWith('coingecko:')) return null;
  const coinId = value.slice('coingecko:'.length).trim();
  return coinId || null;
}

function resolveHoldingLogo(row: SimBalanceRow): string | null {
  return (
    normalizeText(row.logo) ??
    normalizeText(row.logo_uri) ??
    normalizeText(row.url) ??
    normalizeText(row.token_metadata?.logo) ??
    normalizeText(row.token_metadata?.logoURI) ??
    normalizeText(row.token_metadata?.url)
  );
}

function normalizeMarketChain(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value === 'ethereum') return 'eth';
  if (value === 'bsc' || value === 'binance-smart-chain') return 'bnb';
  return value;
}

function resolveHoldingMarketChain(row: SimBalanceRow): string {
  const fromConfig = getMarketChainByChainId(Number(row.chain_id));
  if (fromConfig) return fromConfig;
  return normalizeMarketChain(row.chain);
}

function resolveHoldingContractKey(row: SimBalanceRow): string {
  const address = normalizeAddress(row.address);
  if (!address || /^0x0{40}$/.test(address)) return NATIVE_CONTRACT_KEY;
  return address;
}

function resolveManualAssetIdOverride(marketChain: string, contractKey: string): string | null {
  // Manual normalization: treat BNB bridged USDC as canonical USDC for wallet aggregation.
  if (marketChain === 'bnb' && contractKey === '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d') {
    return 'coingecko:usd-coin';
  }
  return null;
}

function hasPositiveAmount(rawAmount: string | undefined): boolean {
  if (!rawAmount) return false;
  const normalized = rawAmount.trim();
  if (!normalized || normalized === '0') return false;
  if (/^\d+$/.test(normalized)) {
    return BigInt(normalized) > 0n;
  }
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) && asNumber > 0;
}

function resolveFallbackAssetName(assetId: string | null | undefined, symbol: string | null | undefined): string | null {
  const normalizedAssetId = normalizeAssetId(assetId);
  if (normalizedAssetId && FALLBACK_ASSET_NAME_BY_ID[normalizedAssetId]) {
    return FALLBACK_ASSET_NAME_BY_ID[normalizedAssetId];
  }
  const normalizedSymbol = normalizeText(symbol)?.toUpperCase();
  if (!normalizedSymbol) return null;
  return FALLBACK_ASSET_NAME_BY_SYMBOL[normalizedSymbol] ?? null;
}

export async function fetchWalletPortfolio(
  env: Bindings,
  walletAddress: string,
): Promise<{ totalUsd: number; holdings: SimBalanceRow[]; asOf: string }> {
  const simApiKey = env.SIM_API_KEY?.trim();
  if (!simApiKey) {
    throw new Error('sim_api_key_not_configured');
  }

  const chainIds = getSupportedChainIds().join(',');
  const simResponse = await fetch(
    `https://api.sim.dune.com/v1/evm/balances/${walletAddress}?metadata=logo,url&chain_ids=${encodeURIComponent(chainIds)}`,
    {
      method: 'GET',
      headers: {
        'X-Sim-Api-Key': simApiKey,
      },
    },
  );

  const simData = (await simResponse.json()) as SimBalancesResponse;
  if (!simResponse.ok) {
    throw new Error(simData.message ?? simData.error ?? 'failed_to_fetch_portfolio');
  }

  const holdings = (simData.balances ?? [])
    .filter((row) => Number(row.value_usd ?? 0) > 0 || hasPositiveAmount(row.amount))
    .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
  const totalUsd = holdings.reduce((acc, row) => acc + Number(row.value_usd ?? 0), 0);

  return {
    totalUsd,
    holdings,
    asOf: nowIso(),
  };
}

export async function buildMergedPortfolioHoldings(
  env: Bindings,
  holdings: SimBalanceRow[],
): Promise<MergedPortfolioHolding[]> {
  const byAssetId = new Map<string, MergedPortfolioHolding>();
  const preferredAssetIdByChainAssetId = new Map<string, string | null>();

  for (const row of holdings) {
    const marketChain = resolveHoldingMarketChain(row);
    const contractKey = resolveHoldingContractKey(row);
    const chainAssetId = normalizeText(row.chain_asset_id) ?? buildChainAssetId(marketChain, contractKey);
    const upstreamAssetId = normalizeAssetId(row.asset_id);
    const manualOverrideAssetId = resolveManualAssetIdOverride(marketChain, contractKey);

    let assetId = manualOverrideAssetId ?? upstreamAssetId;
    if (!assetId) {
      if (!preferredAssetIdByChainAssetId.has(chainAssetId)) {
        if (contractKey === NATIVE_CONTRACT_KEY) {
          preferredAssetIdByChainAssetId.set(chainAssetId, null);
        } else {
          try {
            preferredAssetIdByChainAssetId.set(
              chainAssetId,
              await resolveCoinGeckoAssetIdForContract(env, marketChain, contractKey),
            );
          } catch {
            preferredAssetIdByChainAssetId.set(chainAssetId, null);
          }
        }
      }
      assetId = buildAssetId(
        marketChain,
        contractKey,
        preferredAssetIdByChainAssetId.get(chainAssetId) ?? undefined,
      );
    }

    const valueUsd = Number(row.value_usd ?? 0);
    const variant: MergedHoldingVariant = {
      ...row,
      market_chain: marketChain,
      contract_key: contractKey,
      chain_asset_id: chainAssetId,
      asset_id: assetId,
    };

    const current = byAssetId.get(assetId);
    if (current) {
      current.total_value_usd += valueUsd;
      current.variants.push(variant);
      continue;
    }
    byAssetId.set(assetId, {
      asset_id: assetId,
      symbol: normalizeText(row.symbol)?.toUpperCase() ?? null,
      name: normalizeText(row.name),
      logo: resolveHoldingLogo(row),
      total_value_usd: valueUsd,
      variants: [variant],
    });
  }

  const merged = [...byAssetId.values()];
  for (const item of merged) {
    item.variants.sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
    if (!item.symbol) {
      item.symbol = item.variants
        .map((variant) => normalizeText(variant.symbol)?.toUpperCase() ?? null)
        .find((symbol): symbol is string => Boolean(symbol))
        ?? null;
    }
    if (!item.name) {
      item.name = item.variants
        .map((variant) => normalizeText(variant.name))
        .find((name): name is string => Boolean(name))
        ?? null;
    }
    if (!item.name) {
      item.name = resolveFallbackAssetName(item.asset_id, item.symbol);
    }
    if (!item.logo) {
      item.logo = item.variants
        .map((variant) => resolveHoldingLogo(variant))
        .find((logo): logo is string => Boolean(logo))
        ?? null;
    }
  }

  return merged.sort((a, b) => b.total_value_usd - a.total_value_usd);
}

function parsePlatformsJson(raw: string | null | undefined): Record<string, string | null | undefined> {
  const value = normalizeText(raw);
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, string | null | undefined>;
  } catch {
    return {};
  }
}

function mapPlatformToChainId(platform: string): number | null {
  if (platform === 'ethereum') return 1;
  if (platform === 'base') return 8453;
  if (platform === 'binance-smart-chain' || platform === 'bnb-smart-chain') return 56;
  return null;
}

async function ensureAggregatedAssetCatalogSchema(db: D1Database): Promise<void> {
  if (aggregatedAssetCatalogSchemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS aggregated_asset_catalog (
        asset_id TEXT PRIMARY KEY,
        coingecko_coin_id TEXT,
        symbol TEXT,
        name TEXT,
        logo_uri TEXT,
        platforms_json TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_aggregated_asset_catalog_coin_id ON aggregated_asset_catalog(coingecko_coin_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_aggregated_asset_catalog_updated_at ON aggregated_asset_catalog(updated_at DESC)').run();
  aggregatedAssetCatalogSchemaReady = true;
}

async function getAggregatedAssetLogos(db: D1Database, assetIds: string[]): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const ids = [...new Set(assetIds.map((id) => normalizeText(id)?.toLowerCase() ?? '').filter(Boolean))];
  if (ids.length === 0) return output;
  await ensureAggregatedAssetCatalogSchema(db);

  const placeholders = ids.map(() => '?').join(',');
  const sql = `SELECT asset_id, logo_uri FROM aggregated_asset_catalog WHERE asset_id IN (${placeholders})`;
  const result = await db.prepare(sql).bind(...ids).all<{ asset_id: string; logo_uri: string | null }>();
  for (const row of result.results ?? []) {
    const assetId = normalizeText(row.asset_id)?.toLowerCase();
    const logoUri = normalizeText(row.logo_uri);
    if (!assetId || !logoUri) continue;
    output.set(assetId, logoUri);
  }
  return output;
}

export async function resolveBestTokenCatalogLogo(
  db: D1Database,
  chainId: number,
  address: string,
): Promise<string | null> {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) return null;
  const result = await db
    .prepare(
      `SELECT logo_uri
       FROM token_catalog
       WHERE chain_id = ?
         AND address = ?
         AND logo_uri IS NOT NULL
       ORDER BY confidence DESC, updated_at DESC
       LIMIT 1`,
    )
    .bind(chainId, normalizedAddress)
    .first<{ logo_uri: string | null }>();
  return normalizeText(result?.logo_uri);
}

async function hydrateAggregatedAssetCatalogByAssetIds(
  env: Bindings,
  assetIds: string[],
): Promise<void> {
  const normalizedAssetIds = [...new Set(assetIds.map((id) => normalizeText(id)?.toLowerCase() ?? '').filter(Boolean))];
  if (!normalizedAssetIds.length) return;
  const coinIds = [
    ...new Set(
      normalizedAssetIds
        .map((assetId) => parseCoingeckoCoinIdFromAssetId(assetId))
        .filter((coinId): coinId is string => Boolean(coinId)),
    ),
  ];
  if (!coinIds.length) return;
  await ensureAggregatedAssetCatalogSchema(env.DB);

  const placeholders = coinIds.map(() => '?').join(',');
  const rows = await env.DB
    .prepare(
      `SELECT coin_id, symbol, name, platforms_json
       FROM coingecko_coin_platforms
       WHERE coin_id IN (${placeholders})`,
    )
    .bind(...coinIds)
    .all<{ coin_id: string; symbol: string | null; name: string | null; platforms_json: string | null }>();

  const now = nowIso();
  for (const row of rows.results ?? []) {
    const coinId = normalizeText(row.coin_id)?.toLowerCase();
    if (!coinId) continue;
    const assetId = `coingecko:${coinId}`;
    const platforms = parsePlatformsJson(row.platforms_json);
    let logoUri: string | null = null;

    const platformEntries = Object.entries(platforms ?? {})
      .map(([platformRaw, addressRaw]) => ({
        chainId: mapPlatformToChainId(platformRaw.trim().toLowerCase()),
        address: normalizeText(addressRaw) ?? '',
      }))
      .filter((entry): entry is { chainId: number; address: string } => Boolean(entry.chainId) && Boolean(entry.address));

    for (const entry of platformEntries) {
      const candidate = await resolveBestTokenCatalogLogo(env.DB, entry.chainId, entry.address);
      if (candidate) {
        logoUri = candidate;
        break;
      }
    }

    await env.DB
      .prepare(
        `INSERT INTO aggregated_asset_catalog (
          asset_id, coingecko_coin_id, symbol, name, logo_uri, platforms_json, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
          coingecko_coin_id = excluded.coingecko_coin_id,
          symbol = COALESCE(excluded.symbol, aggregated_asset_catalog.symbol),
          name = COALESCE(excluded.name, aggregated_asset_catalog.name),
          logo_uri = COALESCE(excluded.logo_uri, aggregated_asset_catalog.logo_uri),
          platforms_json = COALESCE(excluded.platforms_json, aggregated_asset_catalog.platforms_json),
          source = excluded.source,
          updated_at = excluded.updated_at`,
      )
      .bind(
        assetId,
        coinId,
        normalizeText(row.symbol)?.toUpperCase() ?? null,
        normalizeText(row.name),
        logoUri,
        JSON.stringify(platforms ?? {}),
        'coingecko_coin_list+token_catalog',
        now,
      )
      .run();
  }
}

export async function enrichMergedHoldingLogosByAssetId(
  env: Bindings,
  holdings: MergedPortfolioHolding[],
): Promise<MergedPortfolioHolding[]> {
  if (!holdings.length) return holdings;
  const missingAssetIds = holdings
    .filter((item) => !normalizeText(item.logo))
    .map((item) => normalizeText(item.asset_id)?.toLowerCase() ?? '')
    .filter(Boolean);
  if (!missingAssetIds.length) return holdings;

  // 1) Resolve from aggregated catalog table.
  const cachedByAssetId = await getAggregatedAssetLogos(env.DB, missingAssetIds);
  for (const item of holdings) {
    if (normalizeText(item.logo)) continue;
    const assetId = normalizeText(item.asset_id)?.toLowerCase();
    if (!assetId) continue;
    const cached = cachedByAssetId.get(assetId);
    if (cached) item.logo = cached;
  }

  // 2) Rebuild missing rows from coingecko coin list + token catalog, then read again.
  const stillMissingAssetIds = holdings
    .filter((item) => !normalizeText(item.logo))
    .map((item) => normalizeText(item.asset_id)?.toLowerCase() ?? '')
    .filter(Boolean);
  if (!stillMissingAssetIds.length) return holdings;

  await hydrateAggregatedAssetCatalogByAssetIds(env, stillMissingAssetIds);
  const refreshedByAssetId = await getAggregatedAssetLogos(env.DB, stillMissingAssetIds);
  for (const item of holdings) {
    if (normalizeText(item.logo)) continue;
    const assetId = normalizeText(item.asset_id)?.toLowerCase();
    if (!assetId) continue;
    const refreshed = refreshedByAssetId.get(assetId);
    if (refreshed) item.logo = refreshed;
  }

  return holdings;
}

async function upsertToken(
  db: D1Database,
  token: {
    chainId: number;
    address: string;
    symbol: string;
    name: string | null;
    decimals: number | null;
    logoUri: string | null;
    source: string;
    confidence: number;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO token_catalog (
        chain_id, address, symbol, name, decimals, logo_uri, source, confidence, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, address) DO UPDATE SET
        symbol = excluded.symbol,
        name = COALESCE(excluded.name, token_catalog.name),
        decimals = COALESCE(excluded.decimals, token_catalog.decimals),
        logo_uri = COALESCE(excluded.logo_uri, token_catalog.logo_uri),
        source = excluded.source,
        confidence = CASE
          WHEN excluded.confidence > token_catalog.confidence THEN excluded.confidence
          ELSE token_catalog.confidence
        END,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at`,
    )
    .bind(
      token.chainId,
      token.address,
      token.symbol,
      token.name,
      token.decimals,
      token.logoUri,
      token.source,
      token.confidence,
      token.now,
      token.now,
      token.now,
    )
    .run();
}

async function ensureTokenCatalogSchema(db: D1Database): Promise<void> {
  if (tokenCatalogSchemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS token_catalog (
        chain_id INTEGER NOT NULL,
        address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT,
        decimals INTEGER,
        logo_uri TEXT,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain_id, address)
      )`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_token_catalog_symbol ON token_catalog(symbol)').run();
  await db
    .prepare('CREATE INDEX IF NOT EXISTS idx_token_catalog_updated_at ON token_catalog(updated_at DESC)')
    .run();
  tokenCatalogSchemaReady = true;
}

export async function ingestTokenLists(env: Bindings): Promise<{ imported: number; sourceCount: number }> {
  await ensureTokenCatalogSchema(env.DB);
  const rawUrls = (env.TOKEN_LIST_URLS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const urls = rawUrls.length ? rawUrls : DEFAULT_TOKEN_LIST_URLS;
  const maxPerRun = envInt(env.TOKEN_LIST_MAX_TOKENS, 4000, 100, 20000);
  let imported = 0;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
        },
      });
      if (!response.ok) continue;
      const body = (await response.json()) as TokenList;
      const tokens = body.tokens ?? [];
      for (const token of tokens) {
        if (imported >= maxPerRun) break;
        const chainId = token.chainId;
        const address = normalizeAddress(token.address);
        const symbol = token.symbol?.trim();
        if (!chainId || !address || !symbol) continue;
        const now = nowIso();
        await upsertToken(env.DB, {
          chainId,
          address,
          symbol: symbol.slice(0, 24),
          name: token.name?.trim().slice(0, 120) ?? null,
          decimals: Number.isFinite(token.decimals) ? clampInt(Number(token.decimals), 0, 36) : null,
          logoUri: token.logoURI?.trim().slice(0, 300) ?? null,
          source: `token_list:${url}`.slice(0, 120),
          confidence: 0.85,
          now,
        });
        imported += 1;
      }
    } catch {
      // Ignore source failures; continue with remaining token lists.
    }
    if (imported >= maxPerRun) break;
  }

  return { imported, sourceCount: urls.length };
}

export async function upsertTokenMetadataFromPortfolio(
  env: Bindings,
  holdings: Array<SimBalanceRow>,
  asOf: string,
): Promise<void> {
  await ensureTokenCatalogSchema(env.DB);
  for (const row of holdings) {
    const chainId = row.chain_id;
    const address = normalizeAddress(row.address);
    const symbol = row.symbol?.trim();
    if (!Number.isFinite(chainId) || !address || !symbol) continue;

    await upsertToken(env.DB, {
      chainId,
      address,
      symbol: symbol.slice(0, 24),
      name: row.name?.trim().slice(0, 120) ?? null,
      decimals: Number.isFinite(row.decimals) ? clampInt(Number(row.decimals), 0, 36) : null,
      logoUri: resolveHoldingLogo(row)?.slice(0, 300) ?? null,
      source: 'portfolio_api',
      confidence: 0.65,
      now: asOf,
    });
  }
}

export async function listTokenCatalog(
  db: D1Database,
  options: {
    chainId?: number;
    q?: string;
    limit?: number;
  },
): Promise<
  Array<{
    chain_id: number;
    address: string;
    symbol: string;
    name: string | null;
    decimals: number | null;
    logo_uri: string | null;
    source: string;
    confidence: number;
    updated_at: string;
  }>
> {
  await ensureTokenCatalogSchema(db);
  const limit = clampInt(options.limit ?? 50, 1, 200);
  const q = options.q?.trim().toUpperCase() ?? '';
  const hasChain = Number.isFinite(options.chainId);
  if (q) {
    if (hasChain) {
      const rows = await db
        .prepare(
          `SELECT chain_id, address, symbol, name, decimals, logo_uri, source, confidence, updated_at
           FROM token_catalog
           WHERE chain_id = ?
             AND (UPPER(symbol) LIKE ? OR UPPER(COALESCE(name, '')) LIKE ?)
           ORDER BY confidence DESC, updated_at DESC
           LIMIT ?`,
        )
        .bind(options.chainId as number, `%${q}%`, `%${q}%`, limit)
        .all<{
          chain_id: number;
          address: string;
          symbol: string;
          name: string | null;
          decimals: number | null;
          logo_uri: string | null;
          source: string;
          confidence: number;
          updated_at: string;
        }>();
      return rows.results;
    }
    const rows = await db
      .prepare(
        `SELECT chain_id, address, symbol, name, decimals, logo_uri, source, confidence, updated_at
         FROM token_catalog
         WHERE UPPER(symbol) LIKE ? OR UPPER(COALESCE(name, '')) LIKE ?
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`,
      )
      .bind(`%${q}%`, `%${q}%`, limit)
      .all<{
        chain_id: number;
        address: string;
        symbol: string;
        name: string | null;
        decimals: number | null;
        logo_uri: string | null;
        source: string;
        confidence: number;
        updated_at: string;
      }>();
    return rows.results;
  }

  if (hasChain) {
    const rows = await db
      .prepare(
        `SELECT chain_id, address, symbol, name, decimals, logo_uri, source, confidence, updated_at
         FROM token_catalog
         WHERE chain_id = ?
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`,
      )
      .bind(options.chainId as number, limit)
      .all<{
        chain_id: number;
        address: string;
        symbol: string;
        name: string | null;
        decimals: number | null;
        logo_uri: string | null;
        source: string;
        confidence: number;
        updated_at: string;
      }>();
    return rows.results;
  }

  const rows = await db
    .prepare(
      `SELECT chain_id, address, symbol, name, decimals, logo_uri, source, confidence, updated_at
       FROM token_catalog
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      chain_id: number;
      address: string;
      symbol: string;
      name: string | null;
      decimals: number | null;
      logo_uri: string | null;
      source: string;
      confidence: number;
      updated_at: string;
    }>();
  return rows.results;
}
