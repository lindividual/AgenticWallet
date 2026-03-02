import type { Bindings } from '../types';
import { nowIso } from '../utils/time';
import { getMarketChainByChainId, getSupportedChainIds } from '../config/appConfig';
import { buildAssetId, buildChainAssetId, NATIVE_CONTRACT_KEY } from './assetIdentity';
import { resolveCoinGeckoAssetIdForContract } from './coingecko';

type SimBalanceRow = {
  chain: string;
  chain_id: number;
  address: string;
  amount: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  price_usd?: number;
  value_usd?: number;
  logo?: string;
  url?: string;
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

let tokenCatalogSchemaReady = false;

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
    const chainAssetId = buildChainAssetId(marketChain, contractKey);
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
    const assetId = buildAssetId(
      marketChain,
      contractKey,
      preferredAssetIdByChainAssetId.get(chainAssetId) ?? undefined,
    );
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
      logo: normalizeText(row.logo) ?? normalizeText(row.url),
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
    if (!item.logo) {
      item.logo = item.variants
        .map((variant) => normalizeText(variant.logo) ?? normalizeText(variant.url))
        .find((logo): logo is string => Boolean(logo))
        ?? null;
    }
  }

  return merged.sort((a, b) => b.total_value_usd - a.total_value_usd);
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
      logoUri: row.logo?.trim().slice(0, 300) ?? row.url?.trim().slice(0, 300) ?? null,
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
