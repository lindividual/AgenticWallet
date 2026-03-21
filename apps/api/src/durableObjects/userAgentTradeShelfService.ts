import { getSupportedMarketChains } from '../config/appConfig';
import { fetchTradeBrowse, type TradeBrowseMarketItem, type TradeBrowsePredictionItem } from '../services/tradeBrowse';
import type { ContentDeps } from './userAgentContentTypes';
import { getPortfolioHoldings } from './userAgentContentHelpers';
import type {
  EventRow,
  TradeShelfItem,
  TradeShelfItemKind,
  TradeShelfReasonTag,
  TradeShelfSection,
  TradeShelfSectionId,
  WatchlistAssetRow,
} from './userAgentTypes';

const SECTION_TITLES: Record<TradeShelfSectionId, string> = {
  holdings: 'From Your Holdings',
  behavior: 'Because You Viewed or Traded',
  fresh: 'Fresh Opportunities',
};

const SECTION_KIND_PRIORITY: Record<TradeShelfSectionId, TradeShelfItemKind[]> = {
  holdings: ['spot', 'perp', 'prediction'],
  behavior: ['perp', 'prediction', 'spot'],
  fresh: ['prediction', 'spot', 'perp'],
};

const DISPLAY_LIMIT_PER_SECTION = 4;

const SYMBOL_ALIAS_LOOKUP: Record<string, string> = {
  BITCOIN: 'BTC',
  BTC: 'BTC',
  ETHEREUM: 'ETH',
  ETH: 'ETH',
  SOLANA: 'SOL',
  SOL: 'SOL',
  TRON: 'TRX',
  TRX: 'TRX',
  BINANCE: 'BNB',
  BNB: 'BNB',
  RIPPLE: 'XRP',
  XRP: 'XRP',
  DOGECOIN: 'DOGE',
  DOGE: 'DOGE',
};

type Candidate = {
  id: string;
  kind: TradeShelfItemKind;
  itemId: string;
  symbol: string;
  displaySymbol: string;
  title: string;
  image: string | null;
  chain: string | null;
  contract: string | null;
  currentPrice: number | null;
  change24h: number | null;
  probability: number | null;
  volume24h: number | null;
  reasonTag: TradeShelfReasonTag;
  score: number;
  marketScore: number;
  freshnessScore: number;
  matchedSymbols: string[];
  holdingMatch: boolean;
  watchlistMatch: boolean;
  viewedMatch: boolean;
  viewedRecent24h: boolean;
  tradedMatch: boolean;
  tradedOften: boolean;
  diversityCandidate: boolean;
};

type EventSignalSummary = {
  viewedSymbols: Set<string>;
  viewedRecent24hSymbols: Set<string>;
  tradedSymbols: Set<string>;
  tradedOftenSymbols: Set<string>;
};

export async function buildTradeShelfContent(deps: ContentDeps): Promise<{
  generatedAt: string;
  sections: TradeShelfSection[];
}> {
  const browse = await fetchTradeBrowse(deps.env);
  const supportedChains = getSupportedMarketChains();
  const holdings = getPortfolioHoldings(deps.sql, supportedChains)
    .map((holding) => holding.symbol.trim().toUpperCase())
    .filter(Boolean);
  const watchlist = normalizeWatchlistSymbols(deps.getWatchlistAssets?.(30) ?? []);
  const eventSignals = summarizeEventSignals(deps.getLatestEvents(200));
  const knownSymbols = new Set<string>([
    ...holdings,
    ...watchlist,
    ...eventSignals.viewedSymbols,
    ...eventSignals.tradedSymbols,
  ]);

  const candidates = [
    ...browse.topMovers.map((item, index) => buildSpotCandidate(item, index, eventSignals, holdings, watchlist, knownSymbols)),
    ...browse.trendings.map((item, index) => buildSpotCandidate(item, index + 8, eventSignals, holdings, watchlist, knownSymbols)),
    ...browse.perps.map((item, index) => buildPerpCandidate(item, index, eventSignals, holdings, watchlist)),
    ...browse.predictions.map((item, index) => buildPredictionCandidate(item, index, eventSignals, holdings, watchlist, knownSymbols)),
  ]
    .filter((candidate): candidate is Candidate => candidate != null)
    .sort((a, b) => b.score - a.score);

  const sections = composeTradeShelfSections(candidates);

  return {
    generatedAt: new Date().toISOString(),
    sections,
  };
}

function normalizeWatchlistSymbols(watchlist: WatchlistAssetRow[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const asset of watchlist) {
    const symbol = normalizeAssetSymbol(asset.symbol);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    output.push(symbol);
  }
  return output;
}

function summarizeEventSignals(events: EventRow[]): EventSignalSummary {
  const viewedSymbols = new Set<string>();
  const viewedRecent24hSymbols = new Set<string>();
  const tradedSymbols = new Set<string>();
  const tradedCounts = new Map<string, number>();

  for (const event of events) {
    const symbol = normalizeAssetSymbolFromPayload(event.payload_json);
    if (!symbol) continue;
    const occurredAtMs = Date.parse(event.occurred_at);
    const isRecent24h = Number.isFinite(occurredAtMs) && Date.now() - occurredAtMs <= 24 * 60 * 60 * 1000;

    if (event.event_type === 'asset_viewed') {
      viewedSymbols.add(symbol);
      if (isRecent24h) viewedRecent24hSymbols.add(symbol);
      continue;
    }

    if (event.event_type === 'trade_buy' || event.event_type === 'trade_sell') {
      tradedSymbols.add(symbol);
      tradedCounts.set(symbol, (tradedCounts.get(symbol) ?? 0) + 1);
    }
  }

  const tradedOftenSymbols = new Set<string>();
  for (const [symbol, count] of tradedCounts) {
    if (count >= 2) tradedOftenSymbols.add(symbol);
  }

  return {
    viewedSymbols,
    viewedRecent24hSymbols,
    tradedSymbols,
    tradedOftenSymbols,
  };
}

function normalizeAssetSymbolFromPayload(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return normalizeAssetSymbol(payload.asset ?? payload.symbol ?? payload.token);
  } catch {
    return null;
  }
}

function normalizeAssetSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!value || value.length > 16) return null;
  return SYMBOL_ALIAS_LOOKUP[value] ?? value;
}

function normalizePerpBaseSymbol(raw: string): string | null {
  let value = raw.trim().toUpperCase().replace(/[_\s]+/g, '');
  if (!value) return null;
  value = value.replace(/-PERP$/i, '').replace(/PERP$/i, '');

  const slashIndex = value.indexOf('/');
  if (slashIndex > 0) value = value.slice(0, slashIndex);
  const dashIndex = value.indexOf('-');
  if (dashIndex > 0) value = value.slice(0, dashIndex);

  for (const suffix of ['USDT', 'USDC', 'USD', 'FDUSD', 'BUSD']) {
    if (value.endsWith(suffix) && value.length > suffix.length) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  return normalizeAssetSymbol(value);
}

function extractPredictionSymbols(title: string, knownSymbols: Set<string>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const uppercaseMatches = title.toUpperCase().match(/[A-Z]{2,6}/g) ?? [];

  for (const match of uppercaseMatches) {
    const symbol = normalizeAssetSymbol(match);
    if (!symbol || seen.has(symbol)) continue;
    if (knownSymbols.size > 0 && !knownSymbols.has(symbol)) continue;
    seen.add(symbol);
    output.push(symbol);
  }

  const tokens = title.toUpperCase().split(/[^A-Z0-9]+/g);
  for (const token of tokens) {
    const symbol = SYMBOL_ALIAS_LOOKUP[token];
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    output.push(symbol);
  }

  return output;
}

function buildSpotCandidate(
  item: TradeBrowseMarketItem,
  freshnessIndex: number,
  eventSignals: EventSignalSummary,
  holdings: string[],
  watchlist: string[],
  knownSymbols: Set<string>,
): Candidate | null {
  const symbol = normalizeAssetSymbol(item.symbol);
  if (!symbol) return null;
  return buildCandidateBase({
    id: `spot:${item.id}`,
    kind: 'spot',
    itemId: item.id,
    symbol,
    displaySymbol: symbol,
    title: item.name,
    image: item.image,
    chain: item.chain,
    contract: item.contract,
    currentPrice: item.currentPrice,
    change24h: item.change24h,
    probability: null,
    volume24h: item.volume24h,
    matchedSymbols: [symbol],
    freshnessIndex,
    eventSignals,
    holdings,
    watchlist,
    knownSymbols,
  });
}

function buildPerpCandidate(
  item: TradeBrowseMarketItem,
  freshnessIndex: number,
  eventSignals: EventSignalSummary,
  holdings: string[],
  watchlist: string[],
): Candidate | null {
  const symbol = normalizePerpBaseSymbol(item.symbol) ?? normalizeAssetSymbol(item.symbol);
  if (!symbol) return null;
  return buildCandidateBase({
    id: `perp:${item.id}`,
    kind: 'perp',
    itemId: item.id,
    symbol,
    displaySymbol: item.symbol.trim().toUpperCase() || symbol,
    title: item.name || item.symbol,
    image: item.image,
    chain: null,
    contract: null,
    currentPrice: item.currentPrice,
    change24h: item.change24h,
    probability: null,
    volume24h: item.volume24h,
    matchedSymbols: [symbol],
    freshnessIndex,
    eventSignals,
    holdings,
    watchlist,
    knownSymbols: new Set<string>(),
  });
}

function buildPredictionCandidate(
  item: TradeBrowsePredictionItem,
  freshnessIndex: number,
  eventSignals: EventSignalSummary,
  holdings: string[],
  watchlist: string[],
  knownSymbols: Set<string>,
): Candidate | null {
  const matchedSymbols = extractPredictionSymbols(item.title, knownSymbols);
  const displaySymbol = matchedSymbols[0] ?? 'EVENT';
  return buildCandidateBase({
    id: `prediction:${item.id}`,
    kind: 'prediction',
    itemId: item.id,
    symbol: displaySymbol,
    displaySymbol,
    title: item.title,
    image: item.image,
    chain: null,
    contract: null,
    currentPrice: null,
    change24h: null,
    probability: item.probability,
    volume24h: item.volume24h,
    matchedSymbols,
    freshnessIndex,
    eventSignals,
    holdings,
    watchlist,
    knownSymbols,
  });
}

function buildCandidateBase(input: {
  id: string;
  kind: TradeShelfItemKind;
  itemId: string;
  symbol: string;
  displaySymbol: string;
  title: string;
  image: string | null;
  chain: string | null;
  contract: string | null;
  currentPrice: number | null;
  change24h: number | null;
  probability: number | null;
  volume24h: number | null;
  matchedSymbols: string[];
  freshnessIndex: number;
  eventSignals: EventSignalSummary;
  holdings: string[];
  watchlist: string[];
  knownSymbols: Set<string>;
}): Candidate {
  const matchedSymbols = input.matchedSymbols.length > 0 ? input.matchedSymbols : [input.symbol];
  const holdingsSet = new Set(input.holdings);
  const watchlistSet = new Set(input.watchlist);
  const holdingMatch = matchedSymbols.some((symbol) => holdingsSet.has(symbol));
  const watchlistMatch = matchedSymbols.some((symbol) => watchlistSet.has(symbol));
  const viewedMatch = matchedSymbols.some((symbol) => input.eventSignals.viewedSymbols.has(symbol));
  const viewedRecent24h = matchedSymbols.some((symbol) => input.eventSignals.viewedRecent24hSymbols.has(symbol));
  const tradedMatch = matchedSymbols.some((symbol) => input.eventSignals.tradedSymbols.has(symbol));
  const tradedOften = matchedSymbols.some((symbol) => input.eventSignals.tradedOftenSymbols.has(symbol));
  const diversityCandidate = matchedSymbols.every((symbol) => !holdingsSet.has(symbol) && !watchlistSet.has(symbol));

  const holdingScore = holdingMatch ? 30 : 0;
  const watchlistScore = watchlistMatch ? 22 : 0;
  const viewScore = viewedMatch ? 16 + (viewedRecent24h ? 6 : 0) : 0;
  const tradeScore = tradedMatch ? 20 + (tradedOften ? 8 : 0) : 0;
  const marketScore = computeMarketScore(input.kind, input.change24h, input.volume24h, input.probability);
  const freshnessScore = Math.max(0, 8 - input.freshnessIndex * 1.5);

  let reasonTag: TradeShelfReasonTag = 'Trending now';
  if (holdingMatch) {
    reasonTag = 'Based on holdings';
  } else if (tradedMatch) {
    reasonTag = 'Recently traded';
  } else if (viewedMatch) {
    reasonTag = 'Recently viewed';
  } else if (watchlistMatch) {
    reasonTag = 'In your watchlist';
  } else if (diversityCandidate && input.knownSymbols.size > 0) {
    reasonTag = 'Diversification';
  }

  return {
    id: input.id,
    kind: input.kind,
    itemId: input.itemId,
    symbol: input.symbol,
    displaySymbol: input.displaySymbol,
    title: input.title,
    image: input.image,
    chain: input.chain,
    contract: input.contract,
    currentPrice: input.currentPrice,
    change24h: input.change24h,
    probability: input.probability,
    volume24h: input.volume24h,
    reasonTag,
    score: holdingScore + watchlistScore + viewScore + tradeScore + marketScore + freshnessScore,
    marketScore,
    freshnessScore,
    matchedSymbols,
    holdingMatch,
    watchlistMatch,
    viewedMatch,
    viewedRecent24h,
    tradedMatch,
    tradedOften,
    diversityCandidate,
  };
}

function computeMarketScore(
  kind: TradeShelfItemKind,
  change24h: number | null,
  volume24h: number | null,
  probability: number | null,
): number {
  const changeComponent = Math.min(12, Math.max(0, Math.abs(change24h ?? 0) / 4));
  const volumeComponent = Math.min(8, Math.max(0, Math.log10(Math.max(1, volume24h ?? 0)) * 1.5));
  if (kind === 'prediction') {
    const probabilityComponent =
      probability == null ? 0 : Math.min(6, Math.max(0, (50 - Math.abs(50 - probability)) / 8));
    return changeComponent * 0.2 + volumeComponent + probabilityComponent;
  }
  return changeComponent + volumeComponent;
}

function composeTradeShelfSections(candidates: Candidate[]): TradeShelfSection[] {
  const globalUsedIds = new Set<string>();
  const globalUsedSymbols = new Map<string, TradeShelfItemKind>();

  const holdingsPool = candidates.filter((candidate) => {
    if (candidate.kind === 'prediction' && !candidate.holdingMatch && !candidate.watchlistMatch) {
      return false;
    }
    return candidate.holdingMatch || candidate.watchlistMatch;
  });
  const behaviorPool = candidates.filter((candidate) => {
    if (candidate.kind === 'prediction' && !candidate.viewedMatch && !candidate.tradedMatch) {
      return false;
    }
    return candidate.viewedMatch || candidate.tradedMatch;
  });
  const freshPool = candidates.filter((candidate) => {
    if (candidate.kind !== 'prediction') return true;
    return candidate.matchedSymbols.length > 0
      ? !(candidate.holdingMatch || candidate.watchlistMatch || candidate.viewedMatch || candidate.tradedMatch)
      : true;
  });

  const sectionsById = new Map<TradeShelfSectionId, TradeShelfSection>();
  for (const sectionId of ['behavior', 'holdings', 'fresh'] as const) {
    const pool = sectionId === 'holdings'
      ? holdingsPool
      : sectionId === 'behavior'
        ? behaviorPool
        : freshPool;

    const items = selectSectionItems(sectionId, pool, candidates, globalUsedIds, globalUsedSymbols);
    sectionsById.set(sectionId, {
      id: sectionId,
      title: SECTION_TITLES[sectionId],
      items,
    });
  }

  const sections = (['holdings', 'behavior', 'fresh'] as const)
    .map((sectionId) => sectionsById.get(sectionId))
    .filter((section): section is TradeShelfSection => Boolean(section));

  if (sections.some((section) => section.items.length > 0)) {
    return sections;
  }

  const fallbackItems = selectSectionItems('fresh', candidates, candidates, globalUsedIds, globalUsedSymbols);
  return [{
    id: 'fresh',
    title: SECTION_TITLES.fresh,
    items: fallbackItems,
  }];
}

function selectSectionItems(
  sectionId: TradeShelfSectionId,
  primaryPool: Candidate[],
  allCandidates: Candidate[],
  globalUsedIds: Set<string>,
  globalUsedSymbols: Map<string, TradeShelfItemKind>,
): TradeShelfItem[] {
  const selected: TradeShelfItem[] = [];
  const sectionUsedSymbols = new Set<string>();
  const preferredKinds = SECTION_KIND_PRIORITY[sectionId];
  const orderedPools = [primaryPool, allCandidates];

  for (const preferredKind of preferredKinds) {
    const picked = pickNextCandidate(orderedPools, preferredKind, sectionId, globalUsedIds, globalUsedSymbols, sectionUsedSymbols);
    if (!picked) continue;
    selected.push(toTradeShelfItem(picked));
    registerSelection(picked, globalUsedIds, globalUsedSymbols, sectionUsedSymbols);
    break;
  }

  while (selected.length < DISPLAY_LIMIT_PER_SECTION) {
    const next = pickNextCandidate(orderedPools, null, sectionId, globalUsedIds, globalUsedSymbols, sectionUsedSymbols);
    if (!next) break;
    selected.push(toTradeShelfItem(next));
    registerSelection(next, globalUsedIds, globalUsedSymbols, sectionUsedSymbols);
  }

  return selected;
}

function pickNextCandidate(
  pools: Candidate[][],
  preferredKind: TradeShelfItemKind | null,
  sectionId: TradeShelfSectionId,
  globalUsedIds: Set<string>,
  globalUsedSymbols: Map<string, TradeShelfItemKind>,
  sectionUsedSymbols: Set<string>,
): Candidate | null {
  for (const pool of pools) {
    const sorted = preferredKind
      ? pool.filter((candidate) => candidate.kind === preferredKind)
      : pool;
    for (const candidate of sorted) {
      if (!isCandidateAllowed(candidate, sectionId, globalUsedIds, globalUsedSymbols, sectionUsedSymbols)) continue;
      return candidate;
    }
  }
  return null;
}

function isCandidateAllowed(
  candidate: Candidate,
  sectionId: TradeShelfSectionId,
  globalUsedIds: Set<string>,
  globalUsedSymbols: Map<string, TradeShelfItemKind>,
  sectionUsedSymbols: Set<string>,
): boolean {
  if (globalUsedIds.has(candidate.id)) return false;
  if (sectionUsedSymbols.has(candidate.symbol)) return false;

  const existingKind = globalUsedSymbols.get(candidate.symbol);
  if (!existingKind) return true;

  if (
    candidate.kind === 'prediction'
    && existingKind === 'spot'
    && candidate.reasonTag !== 'Trending now'
    && sectionId === 'fresh'
  ) {
    return true;
  }

  return false;
}

function registerSelection(
  candidate: Candidate,
  globalUsedIds: Set<string>,
  globalUsedSymbols: Map<string, TradeShelfItemKind>,
  sectionUsedSymbols: Set<string>,
): void {
  globalUsedIds.add(candidate.id);
  sectionUsedSymbols.add(candidate.symbol);
  if (!globalUsedSymbols.has(candidate.symbol)) {
    globalUsedSymbols.set(candidate.symbol, candidate.kind);
  }
}

function toTradeShelfItem(candidate: Candidate): TradeShelfItem {
  return {
    id: candidate.id,
    kind: candidate.kind,
    itemId: candidate.itemId,
    symbol: candidate.displaySymbol,
    title: candidate.title,
    image: candidate.image,
    chain: candidate.chain,
    contract: candidate.contract,
    currentPrice: candidate.currentPrice,
    change24h: candidate.change24h,
    probability: candidate.probability,
    volume24h: candidate.volume24h,
    reasonTag: candidate.reasonTag,
  };
}
