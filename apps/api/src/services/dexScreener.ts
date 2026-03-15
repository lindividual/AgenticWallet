const DEX_SCREENER_BASE_URL = 'https://api.dexscreener.com';
const DEX_SCREENER_TIMEOUT_MS = 10_000;
const DEX_SCREENER_MEME_HEAT_TTL_MS = 45_000;
const MEME_SEARCH_TERMS = ['pepe', 'doge', 'shib', 'bonk', 'wif', 'fartcoin', 'memecoin'];
const MEME_KEYWORDS = [
  'meme',
  'memecoin',
  'pepe',
  'doge',
  'dogecoin',
  'shib',
  'shiba',
  'bonk',
  'wif',
  'fartcoin',
  'wojak',
  'pump.fun',
  'pumpfun',
];
const BLUE_CHIP_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'USDT', 'USDC', 'DOGE']);

type DexScreenerProfileRow = {
  chainId?: string;
  tokenAddress?: string;
  description?: string;
  icon?: string;
  url?: string;
  links?: Array<{ type?: string; label?: string; url?: string }>;
};

type DexScreenerBoostRow = DexScreenerProfileRow & {
  totalAmount?: number | string;
};

type DexScreenerPairRow = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  url?: string;
  priceUsd?: number | string;
  fdv?: number | string;
  marketCap?: number | string;
  pairCreatedAt?: number | string;
  liquidity?: { usd?: number | string };
  volume?: { h24?: number | string };
  priceChange?: { h24?: number | string };
  baseToken?: {
    address?: string;
    name?: string;
    symbol?: string;
  };
  info?: {
    imageUrl?: string;
    socials?: Array<{ type?: string; url?: string }>;
    websites?: Array<{ url?: string; label?: string }>;
  };
};

export type DexScreenerMemeHeatItem = {
  chainId: string;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  description: string | null;
  url: string | null;
  icon: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  boostAmount: number | null;
  priceUsd: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  priceChange24h: number | null;
  fdv: number | null;
  marketCap: number | null;
  pairAddress: string | null;
  dexId: string | null;
  heatScore: number;
  matchedKeywords: string[];
  sources: string[];
};

let memeHeatValueCache: { expiresAt: number; value: DexScreenerMemeHeatItem[] } | null = null;
let memeHeatInFlight: Promise<DexScreenerMemeHeatItem[]> | null = null;

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function normalizeFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeUrl(raw: unknown): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  return value;
}

function normalizeChainId(raw: unknown): string | null {
  return normalizeText(raw)?.toLowerCase() ?? null;
}

function compactNumber(value: number | null): string {
  if (!Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(Number(value));
  if (abs >= 1_000_000_000) return `${(Number(value) / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(Number(value) / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(Number(value) / 1_000).toFixed(1)}K`;
  return `${Math.round(Number(value))}`;
}

async function fetchDexScreenerJson<T>(path: string): Promise<T> {
  const response = await fetch(`${DEX_SCREENER_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(DEX_SCREENER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`dex_screener_http_${response.status}`);
  }
  return (await response.json()) as T;
}

function extractMatchedKeywords(text: string): string[] {
  const haystack = text.toLowerCase();
  return MEME_KEYWORDS.filter((keyword) => haystack.includes(keyword));
}

function scoreMemeHeatCandidate(input: {
  symbol: string | null;
  name: string | null;
  description: string | null;
  chainId: string | null;
  boostAmount: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  priceChange24h: number | null;
  url: string | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
  matchedKeywords: string[];
  tokenLooksLikePump: boolean;
}): number {
  let score = 0;
  score += input.matchedKeywords.length * 12;
  if (input.boostAmount != null) score += Math.min(28, input.boostAmount / 30);
  if (input.url?.includes('/pump')) score += 8;
  if (input.tokenLooksLikePump) score += 10;
  if (input.twitterUrl) score += 4;
  if (input.websiteUrl) score += 2;
  if (input.chainId === 'solana' || input.chainId === 'base') score += 4;
  if (input.volume24h != null) score += Math.min(18, Math.log10(Math.max(1, input.volume24h + 1)) * 3);
  if (input.liquidityUsd != null) score += Math.min(12, Math.log10(Math.max(1, input.liquidityUsd + 1)) * 2);
  if (input.priceChange24h != null) score += Math.min(8, Math.abs(input.priceChange24h) / 6);
  if (input.symbol && BLUE_CHIP_SYMBOLS.has(input.symbol.toUpperCase()) && input.matchedKeywords.length === 0) score -= 18;
  if (!input.description && !input.symbol && !input.name) score -= 20;
  return Math.round(score * 100) / 100;
}

function looksLikePumpToken(tokenAddress: string | null, url: string | null): boolean {
  if (tokenAddress?.toLowerCase().endsWith('pump')) return true;
  return Boolean(url?.includes('/pump'));
}

function pickTwitterUrl(links: Array<{ type?: string; url?: string }> | null | undefined): string | null {
  const twitter = (links ?? []).find((item) => item.type?.trim().toLowerCase() === 'twitter');
  return normalizeUrl(twitter?.url);
}

function pickWebsiteUrl(
  links: Array<{ type?: string; label?: string; url?: string }> | null | undefined,
): string | null {
  const website = (links ?? []).find((item) => item.type?.trim().toLowerCase() !== 'twitter' && normalizeUrl(item.url));
  return normalizeUrl(website?.url);
}

function mergeSources(current: string[], value: string): string[] {
  return current.includes(value) ? current : [...current, value];
}

export async function fetchDexScreenerMemeHeat(): Promise<DexScreenerMemeHeatItem[]> {
  const now = Date.now();
  if (memeHeatValueCache && memeHeatValueCache.expiresAt > now) {
    return memeHeatValueCache.value;
  }
  if (memeHeatInFlight) {
    return memeHeatInFlight;
  }

  memeHeatInFlight = (async () => {
    console.log('dex_screener_meme_heat_fetch_started', {
      searchTerms: MEME_SEARCH_TERMS,
    });

    const [profilesResult, boostsResult, ...searchResults] = await Promise.allSettled([
      fetchDexScreenerJson<DexScreenerProfileRow[]>('/token-profiles/latest/v1'),
      fetchDexScreenerJson<DexScreenerBoostRow[]>('/token-boosts/top/v1'),
      ...MEME_SEARCH_TERMS.map((term) =>
        fetchDexScreenerJson<{ pairs?: DexScreenerPairRow[] }>(`/latest/dex/search?q=${encodeURIComponent(term)}`),
      ),
    ]);

    const profiles = profilesResult.status === 'fulfilled' ? profilesResult.value : [];
    const boosts = boostsResult.status === 'fulfilled' ? boostsResult.value : [];
    const searches = searchResults.flatMap((result) => (result.status === 'fulfilled' ? result.value.pairs ?? [] : []));

    if (profilesResult.status === 'rejected') {
      console.error('dex_screener_meme_heat_profiles_failed', {
        message: profilesResult.reason instanceof Error ? profilesResult.reason.message : String(profilesResult.reason),
      });
    }
    if (boostsResult.status === 'rejected') {
      console.error('dex_screener_meme_heat_boosts_failed', {
        message: boostsResult.reason instanceof Error ? boostsResult.reason.message : String(boostsResult.reason),
      });
    }
    searchResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error('dex_screener_meme_heat_search_failed', {
          term: MEME_SEARCH_TERMS[index],
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });

    const byKey = new Map<string, DexScreenerMemeHeatItem>();
    const ensureItem = (chainId: string | null, tokenAddress: string | null): DexScreenerMemeHeatItem | null => {
      if (!chainId || !tokenAddress) return null;
      const key = `${chainId}:${tokenAddress.toLowerCase()}`;
      const existing = byKey.get(key);
      if (existing) return existing;
      const created: DexScreenerMemeHeatItem = {
        chainId,
        tokenAddress,
        symbol: null,
        name: null,
        description: null,
        url: null,
        icon: null,
        websiteUrl: null,
        twitterUrl: null,
        boostAmount: null,
        priceUsd: null,
        volume24h: null,
        liquidityUsd: null,
        priceChange24h: null,
        fdv: null,
        marketCap: null,
        pairAddress: null,
        dexId: null,
        heatScore: 0,
        matchedKeywords: [],
        sources: [],
      };
      byKey.set(key, created);
      return created;
    };

    for (const row of profiles) {
      const item = ensureItem(normalizeChainId(row.chainId), normalizeText(row.tokenAddress));
      if (!item) continue;
      item.description = item.description ?? normalizeText(row.description);
      item.icon = item.icon ?? normalizeUrl(row.icon);
      item.url = item.url ?? normalizeUrl(row.url);
      item.twitterUrl = item.twitterUrl ?? pickTwitterUrl(row.links);
      item.websiteUrl = item.websiteUrl ?? pickWebsiteUrl(row.links);
      item.sources = mergeSources(item.sources, 'profile');
    }

    for (const row of boosts) {
      const item = ensureItem(normalizeChainId(row.chainId), normalizeText(row.tokenAddress));
      if (!item) continue;
      item.description = item.description ?? normalizeText(row.description);
      item.icon = item.icon ?? normalizeUrl(row.icon);
      item.url = item.url ?? normalizeUrl(row.url);
      item.twitterUrl = item.twitterUrl ?? pickTwitterUrl(row.links);
      item.websiteUrl = item.websiteUrl ?? pickWebsiteUrl(row.links);
      item.boostAmount = Math.max(item.boostAmount ?? 0, normalizeFiniteNumber(row.totalAmount) ?? 0) || item.boostAmount;
      item.sources = mergeSources(item.sources, 'boost');
    }

    for (const row of searches) {
      const item = ensureItem(normalizeChainId(row.chainId), normalizeText(row.baseToken?.address));
      if (!item) continue;
      item.symbol = item.symbol ?? normalizeText(row.baseToken?.symbol);
      item.name = item.name ?? normalizeText(row.baseToken?.name);
      item.url = item.url ?? normalizeUrl(row.url);
      item.icon = item.icon ?? normalizeUrl(row.info?.imageUrl);
      item.twitterUrl = item.twitterUrl ?? pickTwitterUrl(row.info?.socials);
      item.websiteUrl = item.websiteUrl ?? pickWebsiteUrl(row.info?.websites);
      item.priceUsd = item.priceUsd ?? normalizeFiniteNumber(row.priceUsd);
      item.volume24h = item.volume24h ?? normalizeFiniteNumber(row.volume?.h24);
      item.liquidityUsd = item.liquidityUsd ?? normalizeFiniteNumber(row.liquidity?.usd);
      item.priceChange24h = item.priceChange24h ?? normalizeFiniteNumber(row.priceChange?.h24);
      item.fdv = item.fdv ?? normalizeFiniteNumber(row.fdv);
      item.marketCap = item.marketCap ?? normalizeFiniteNumber(row.marketCap);
      item.pairAddress = item.pairAddress ?? normalizeText(row.pairAddress);
      item.dexId = item.dexId ?? normalizeText(row.dexId);
      item.sources = mergeSources(item.sources, 'search');
    }

    const items = [...byKey.values()]
      .map((item) => {
        const matchedKeywords = extractMatchedKeywords(
          [item.symbol, item.name, item.description, item.url, item.twitterUrl, item.websiteUrl].filter(Boolean).join(' '),
        );
        const heatScore = scoreMemeHeatCandidate({
          symbol: item.symbol,
          name: item.name,
          description: item.description,
          chainId: item.chainId,
          boostAmount: item.boostAmount,
          volume24h: item.volume24h,
          liquidityUsd: item.liquidityUsd,
          priceChange24h: item.priceChange24h,
          url: item.url,
          twitterUrl: item.twitterUrl,
          websiteUrl: item.websiteUrl,
          matchedKeywords,
          tokenLooksLikePump: looksLikePumpToken(item.tokenAddress, item.url),
        });
        return {
          ...item,
          matchedKeywords,
          heatScore,
        };
      })
      .filter((item) => item.heatScore >= 12 || item.boostAmount != null)
      .sort((a, b) => b.heatScore - a.heatScore)
      .slice(0, 20);

    console.log('dex_screener_meme_heat_fetch_succeeded', {
      profileCount: profiles.length,
      boostCount: boosts.length,
      searchPairCount: searches.length,
      selectedCount: items.length,
      topItems: items.slice(0, 6).map((item) => ({
        symbol: item.symbol,
        name: item.name,
        chainId: item.chainId,
        heatScore: item.heatScore,
        boostAmount: item.boostAmount,
        volume24h: compactNumber(item.volume24h),
      })),
    });

    memeHeatValueCache = {
      expiresAt: Date.now() + DEX_SCREENER_MEME_HEAT_TTL_MS,
      value: items,
    };
    return items;
  })().finally(() => {
    memeHeatInFlight = null;
  });

  return memeHeatInFlight;
}
