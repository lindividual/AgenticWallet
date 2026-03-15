import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  getAgentRecommendations,
  getCoinDetailsBatch,
  getTradeBrowse,
  runAgentRecommendations,
  type CoinDetail,
  type MarketSearchResult,
  type TopMarketAsset,
  type TradeBrowseMarketItem,
  type TradeBrowsePredictionItem,
  type TradeBrowseResponse,
} from '../../api';
import { CachedIconImage } from '../CachedIconImage';
import { SkeletonBlock } from '../Skeleton';
import { formatUsdAdaptive } from '../../utils/currency';
import { cacheStores, readCache, writeCache } from '../../utils/indexedDbCache';
import { SettingsDropdown } from '../SettingsDropdown';
import { TokenSearchModal } from '../TokenSearchModal';
import { type TradeMarketDetailType } from '../../utils/tradeMarketDetail';
import { buildChainAssetId } from '../../utils/assetIdentity';
import { normalizeContractForChain, normalizeMarketChain } from '../../utils/chainIdentity';

type TradeScreenProps = {
  onOpenToken: (token: TopMarketAsset, shelfId: string) => void;
  onOpenMarketDetail: (marketType: TradeMarketDetailType, itemId: string) => void;
  onLogout: () => void;
};

const PULL_REFRESH_THRESHOLD_PX = 72;
const PULL_REFRESH_MAX_PX = 120;
const MANUAL_REFRESH_COOLDOWN_MS = 5_000;
const TRADE_BROWSE_CACHE_KEY = 'trade-browse:v2';
const TRADE_BROWSE_CACHE_TTL_MS = 10 * 60 * 1000;

type RecommendationDisplayAsset = {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  priceChangePct: number | null;
  currentPrice: number | null;
  tokenPreview: TopMarketAsset | null;
};

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function formatCompactUsd(value: number | null | undefined, locale: string): string {
  if (!Number.isFinite(Number(value))) return '--';
  const amount = Number(value);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    notation: Math.abs(amount) >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: 2,
  }).format(amount);
}

function getLabelInitial(symbol: string, name: string): string {
  const label = (symbol || name || '').trim();
  return label ? label[0].toUpperCase() : '?';
}

function normalizeLookupChain(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value.startsWith('watch:')) return null;
  return value;
}

function pickPreferredSymbolDetail(
  assets: CoinDetail[],
  preferredChain: string | null,
): CoinDetail | undefined {
  if (assets.length === 0) return undefined;
  const normalizedPreferred = (preferredChain ?? '').trim().toLowerCase();
  const chainPriority = new Map<string, number>([
    ['eth', 0],
    ['base', 1],
    ['bnb', 2],
    ['tron', 3],
  ]);
  const sorted = [...assets].sort((a, b) => {
    const aRank = chainPriority.get((a.chain ?? '').trim().toLowerCase()) ?? 9;
    const bRank = chainPriority.get((b.chain ?? '').trim().toLowerCase()) ?? 9;
    return aRank - bRank;
  });
  if (!normalizedPreferred) return sorted[0];
  return sorted.find((asset) => (asset.chain ?? '').trim().toLowerCase() === normalizedPreferred) ?? sorted[0];
}

function resolveRoutableToken(item: TradeBrowseMarketItem): { chain: string; contract: string } | null {
  const chain = normalizeMarketChain(item.chain);
  const contract = normalizeContractForChain(chain, item.contract);
  if (chain && chain !== 'unknown') {
    if (contract === 'native') {
      return { chain, contract: '' };
    }
    if (chain === 'sol' || chain === 'tron') {
      return { chain, contract };
    }
    if (/^0x[a-f0-9]{40}$/.test(contract)) {
      return { chain, contract };
    }
  }

  // Fallback for native majors when upstream payload is incomplete.
  const symbol = item.symbol.trim().toUpperCase();
  const id = item.id.trim().toLowerCase();
  const name = item.name.trim().toLowerCase();
  if (symbol === 'ETH' || id.includes('ethereum') || name === 'ethereum') return { chain: 'eth', contract: '' };
  if (symbol === 'BNB' || id.includes('binancecoin') || name === 'bnb') return { chain: 'bnb', contract: '' };
  if (symbol === 'TRX' || id.includes('tron') || name === 'tron') return { chain: 'tron', contract: '' };
  if (symbol === 'SOL' || id.includes('solana') || name === 'solana') return { chain: 'sol', contract: '' };
  return null;
}

function canOpenToken(item: TradeBrowseMarketItem): boolean {
  return resolveRoutableToken(item) != null;
}

function toTopMarketAsset(
  item: TradeBrowseMarketItem,
  route: { chain: string; contract: string },
): TopMarketAsset {
  const chain = route.chain;
  const contract = route.contract;
  const chainAssetId = buildChainAssetId(chain, contract);
  return {
    id: item.id,
    asset_id: item.asset_id ?? item.id,
    chain_asset_id: chainAssetId,
    chain,
    contract,
    symbol: item.symbol,
    name: item.name,
    image: item.image,
    current_price: item.currentPrice,
    market_cap_rank: null,
    market_cap: null,
    price_change_percentage_24h: item.change24h,
    turnover_24h: item.volume24h,
    risk_level: null,
  };
}

function pctClassname(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return 'text-base-content/55';
  const numberValue = Number(value);
  if (numberValue > 0) return 'text-success';
  if (numberValue < 0) return 'text-error';
  return 'text-base-content/70';
}

function SectionTitle({ title }: { title: string }) {
  return (
    <h2 className="m-0 flex items-center gap-2 text-lg font-bold tracking-tight">
      <span>{title}</span>
      <span className="text-base-content/40">›</span>
    </h2>
  );
}

function IconAvatar({
  symbol,
  name,
  image,
  className,
  fallbackClassName,
}: {
  symbol: string;
  name: string;
  image: string | null;
  className?: string;
  fallbackClassName?: string;
}) {
  const imageClassName = className ?? 'h-9 w-9 rounded-full bg-white/10 object-cover';
  const computedFallbackClassName = fallbackClassName
    ?? (className
      ? `flex items-center justify-center rounded-full bg-base-300 font-semibold text-base-content/75 ${className}`
      : 'flex h-9 w-9 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/75');

  const fallback = (
    <div className={computedFallbackClassName}>
      {getLabelInitial(symbol, name)}
    </div>
  );

  if (image) {
    return (
      <CachedIconImage
        src={image}
        alt={symbol}
        className={imageClassName}
        loading="lazy"
        fallback={fallback}
      />
    );
  }
  return fallback;
}

export function TradeScreen({ onOpenToken, onOpenMarketDetail, onLogout }: TradeScreenProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const pullStartYRef = useRef<number | null>(null);
  const lastManualRefreshAtRef = useRef(0);
  const hasTriggeredRecommendationGenerationRef = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [cachedPayload, setCachedPayload] = useState<TradeBrowseResponse | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const { data: recommendationsData, isLoading: isRecommendationsLoading } = useQuery({
    queryKey: ['home-agent-recommendations'],
    queryFn: getAgentRecommendations,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const generateRecommendationsMutation = useMutation({
    mutationFn: runAgentRecommendations,
    onSuccess: (data) => {
      queryClient.setQueryData(['home-agent-recommendations'], {
        recommendations: data.recommendations ?? [],
      });
    },
  });

  const recommendationLookups = useMemo(() => {
    const output: Array<{ chain: string; contract: string }> = [];
    const seen = new Set<string>();

    for (const item of (recommendationsData?.recommendations ?? []).slice(0, 5)) {
      const chain = normalizeLookupChain(item.asset?.chain ?? null);
      if (!chain) continue;
      const contract = normalizeContractForChain(chain, item.asset?.contract ?? null);
      const key = buildChainAssetId(chain, contract);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ chain, contract });
    }

    return output;
  }, [recommendationsData?.recommendations]);

  const { data: recommendationTokenDetails } = useQuery({
    queryKey: ['trade-recommendation-token-details', recommendationLookups.map((item) => buildChainAssetId(item.chain, item.contract)).join(',')],
    queryFn: () => getCoinDetailsBatch(recommendationLookups),
    enabled: recommendationLookups.length > 0,
    staleTime: 60_000,
    refetchInterval: 90_000,
    refetchOnWindowFocus: true,
  });

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['trade-browse'],
    queryFn: () => getTradeBrowse(),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const payload = data ?? cachedPayload;
  const recommendationDetailLookup = useMemo(() => {
    const byChainAssetId = new Map<string, CoinDetail>();
    const bySymbol = new Map<string, CoinDetail[]>();
    for (const item of recommendationTokenDetails ?? []) {
      const detail = item.detail;
      if (!detail) continue;
      const chainAssetId = (detail.chain_asset_id || buildChainAssetId(detail.chain, detail.contract)).trim().toLowerCase();
      if (chainAssetId && !byChainAssetId.has(chainAssetId)) byChainAssetId.set(chainAssetId, detail);
      const symbol = (detail.symbol ?? '').trim().toUpperCase();
      if (!symbol) continue;
      const bucket = bySymbol.get(symbol);
      if (bucket) {
        bucket.push(detail);
      } else {
        bySymbol.set(symbol, [detail]);
      }
    }
    return { byChainAssetId, bySymbol };
  }, [recommendationTokenDetails]);

  const recommendations = useMemo<RecommendationDisplayAsset[]>(() => {
    const { byChainAssetId, bySymbol } = recommendationDetailLookup;
    return (recommendationsData?.recommendations ?? [])
      .slice(0, 5)
      .map((item) => {
        const assetMeta = item.asset;
        const symbol = (assetMeta?.symbol ?? item.title ?? '').trim().toUpperCase();
        const chain = normalizeLookupChain(assetMeta?.chain ?? null);
        const contract = normalizeContractForChain(chain ?? '', assetMeta?.contract ?? null);
        const exactKey = chain ? buildChainAssetId(chain, contract) : '';
        const matched =
          (exactKey ? byChainAssetId.get(exactKey) : undefined)
          ?? (symbol ? pickPreferredSymbolDetail(bySymbol.get(symbol) ?? [], chain) : undefined);

        const routeChain = matched?.chain ?? chain ?? null;
        const routeContract = matched?.contract ?? (chain ? contract : null);
        const displaySymbol = (matched?.symbol ?? symbol ?? '').toUpperCase();
        const displayName = matched?.name ?? assetMeta?.name ?? item.title ?? displaySymbol;
        const image = matched?.image ?? assetMeta?.image ?? null;
        const currentPrice = matched?.currentPriceUsd ?? null;
        const priceChangePct = matched?.priceChange24h ?? assetMeta?.price_change_percentage_24h ?? null;
        const tokenPreview = routeChain && routeContract != null
          ? {
              id: buildChainAssetId(routeChain, routeContract),
              asset_id: matched?.asset_id ?? buildChainAssetId(routeChain, routeContract),
              chain_asset_id: buildChainAssetId(routeChain, routeContract),
              chain: routeChain,
              contract: routeContract,
              symbol: displaySymbol,
              name: displayName,
              image,
              current_price: currentPrice,
              market_cap_rank: null,
              market_cap: null,
              price_change_percentage_24h: priceChangePct,
              turnover_24h: null,
              risk_level: null,
            }
          : null;

        return {
          id: item.id,
          symbol: displaySymbol,
          name: displayName,
          image,
          currentPrice,
          priceChangePct,
          tokenPreview,
        };
      })
      .filter((item) => Boolean(item.symbol || item.name));
  }, [recommendationDetailLookup, recommendationsData?.recommendations]);
  const shouldShowRecommendationSection = recommendations.length > 0;

  const hasAnySectionData = useMemo(() => {
    if (!payload) return false;
    return payload.topMovers.length > 0
      || payload.trendings.length > 0
      || payload.perps.length > 0
      || payload.predictions.length > 0;
  }, [payload]);

  const shouldShowLoading = isLoading && !payload;
  const shouldShowError = isError && !payload;

  useEffect(() => {
    if (!data) return;
    void writeCache<TradeBrowseResponse>(
      cacheStores.query,
      TRADE_BROWSE_CACHE_KEY,
      data,
      TRADE_BROWSE_CACHE_TTL_MS,
    );
  }, [data]);

  useEffect(() => {
    if (data) return;
    void readCache<TradeBrowseResponse>(cacheStores.query, TRADE_BROWSE_CACHE_KEY).then((cached) => {
      if (!cached) return;
      setCachedPayload(cached);
    });
  }, [data]);

  useEffect(() => {
    if (isRecommendationsLoading) return;
    if ((recommendationsData?.recommendations?.length ?? 0) > 0) return;
    if (generateRecommendationsMutation.isPending) return;
    if (hasTriggeredRecommendationGenerationRef.current) return;

    hasTriggeredRecommendationGenerationRef.current = true;
    generateRecommendationsMutation.mutate();
  }, [
    generateRecommendationsMutation,
    isRecommendationsLoading,
    recommendationsData?.recommendations?.length,
  ]);

  async function triggerPullRefresh(): Promise<void> {
    if (isFetching || isPullRefreshing) return;
    const now = Date.now();
    if (now - lastManualRefreshAtRef.current < MANUAL_REFRESH_COOLDOWN_MS) return;
    lastManualRefreshAtRef.current = now;
    setIsPullRefreshing(true);
    try {
      await refetch();
    } finally {
      setIsPullRefreshing(false);
      setPullDistance(0);
    }
  }

  function handleListTouchStart(event: TouchEvent<HTMLElement>): void {
    if (window.scrollY > 0 || event.touches.length !== 1) return;
    pullStartYRef.current = event.touches[0].clientY;
  }

  function handleListTouchMove(event: TouchEvent<HTMLElement>): void {
    const startY = pullStartYRef.current;
    if (startY == null) return;
    if (window.scrollY > 0) {
      pullStartYRef.current = null;
      setPullDistance(0);
      return;
    }
    const deltaY = event.touches[0].clientY - startY;
    if (deltaY <= 0) {
      setPullDistance(0);
      return;
    }
    setPullDistance(Math.min(deltaY * 0.5, PULL_REFRESH_MAX_PX));
  }

  function handleListTouchEnd(): void {
    pullStartYRef.current = null;
    if (pullDistance >= PULL_REFRESH_THRESHOLD_PX) {
      void triggerPullRefresh();
      return;
    }
    setPullDistance(0);
  }

  function handleOpenToken(item: TradeBrowseMarketItem, section: string): void {
    const route = resolveRoutableToken(item);
    if (!route) return;
    onOpenToken(toTopMarketAsset(item, route), section);
  }

  function handleSearchSelect(item: MarketSearchResult): void {
    if (item.marketType === 'spot') {
      const chain = item.chain?.trim();
      const contract = item.contract?.trim();
      if (!chain || contract == null) return;
      onOpenToken(
        {
          id: item.id,
          asset_id: item.asset_id ?? item.id,
          chain_asset_id: buildChainAssetId(chain, contract),
          chain,
          contract,
          symbol: item.symbol,
          name: item.name,
          image: item.image,
          current_price: item.currentPrice,
          market_cap_rank: null,
          market_cap: null,
          price_change_percentage_24h: item.change24h,
          turnover_24h: item.volume24h,
          risk_level: null,
        },
        'search',
      );
      return;
    }

    const itemId = item.itemId?.trim() || item.id;
    if (!itemId) return;
    onOpenMarketDetail(item.marketType, itemId);
  }

  function toDetailItemId(item: { id: string }): string {
    return item.id;
  }

  return (
    <section
      className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-28"
      onTouchStart={handleListTouchStart}
      onTouchMove={handleListTouchMove}
      onTouchEnd={handleListTouchEnd}
      onTouchCancel={handleListTouchEnd}
    >
      <header className="mt-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="m-0 text-2xl font-bold tracking-tight">{t('trade.browse')}</h1>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-circle"
            onClick={() => setIsSearchOpen(true)}
            aria-label={t('trade.search')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-5"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          </button>
          <SettingsDropdown onLogout={onLogout} />
        </div>
      </header>

      {(pullDistance > 0 || isPullRefreshing) && (
        <div className="rounded-xl bg-base-200 p-2 text-center text-xs text-base-content/70">
          {isPullRefreshing
            ? t('trade.refreshing')
            : pullDistance >= PULL_REFRESH_THRESHOLD_PX
              ? t('trade.refresh')
              : t('trade.pullToRefresh')}
        </div>
      )}

      {shouldShowRecommendationSection && (
        <section className="flex flex-col gap-3">
          <SectionTitle title={t('trade.forYou')} />
          <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
            {recommendations.map((item) => {
              const tokenPreview = item.tokenPreview;
              const changeClass = pctClassname(item.priceChangePct);
              const cardContent = (
                <>
                  <div className="flex items-center justify-between">
                    <IconAvatar symbol={item.symbol} name={item.name} image={item.image} />
                    <span className="rounded-full bg-base-300 px-2 py-0.5 text-[11px] text-base-content/60">
                      {item.symbol}
                    </span>
                  </div>
                  <p className="m-0 mt-4 line-clamp-2 text-lg font-semibold leading-snug">{item.name}</p>
                  <p className="m-0 mt-2 text-sm text-base-content/70">
                    {item.currentPrice != null ? formatUsdAdaptive(item.currentPrice, i18n.language) : '--'}
                  </p>
                  <p className={`m-0 mt-1 text-lg font-semibold ${changeClass}`}>{formatPct(item.priceChangePct)}</p>
                </>
              );

              if (!tokenPreview) {
                return (
                  <article
                    key={item.id}
                    className="min-h-[11.5rem] min-w-[11rem] snap-start rounded-xl bg-base-200/35 p-3"
                  >
                    {cardContent}
                  </article>
                );
              }

              return (
                <button
                  key={item.id}
                  type="button"
                  className="min-h-[11.5rem] min-w-[11rem] snap-start rounded-xl bg-base-200/35 p-3 text-left transition-colors hover:bg-base-200/70"
                  onClick={() => onOpenToken(tokenPreview, 'forYou')}
                >
                  {cardContent}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {shouldShowLoading && (
        <section className="flex flex-col gap-6" aria-label={t('trade.loadingAssets')}>
          <div className="flex flex-col gap-3 rounded-xl bg-base-200/35 p-4">
            <SkeletonBlock className="h-6 w-36 rounded-lg" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, idx) => (
                <SkeletonBlock key={`movers-card-${idx}`} className="h-28 rounded-xl" />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-3 rounded-xl bg-base-200/35 p-4">
            <SkeletonBlock className="h-6 w-32 rounded-lg" />
            {Array.from({ length: 4 }).map((_, idx) => (
              <SkeletonBlock key={`list-row-${idx}`} className="h-12 rounded-xl" />
            ))}
          </div>
        </section>
      )}

      {shouldShowError && (
        <div className="rounded-xl bg-error/10 p-4 text-sm text-error">
          {t('trade.loadFailed', { message: (error as Error).message })}
        </div>
      )}

      {!shouldShowLoading && !shouldShowError && !hasAnySectionData && (
        <div className="rounded-xl bg-base-200 p-4 text-sm text-base-content/75">
          {t('trade.noSectionData')}
        </div>
      )}

      {!!payload && (
        <>
          <section className="flex flex-col gap-3">
            <SectionTitle title={t('trade.topMovers')} />
            <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
              {payload.topMovers.length === 0 && (
                <div className="min-h-[8rem] min-w-full rounded-xl bg-base-200/35 p-4 text-sm text-base-content/65">
                  {t('trade.noSectionData')}
                </div>
              )}
              {payload.topMovers.map((item) => {
                const clickable = canOpenToken(item);
                const changeClass = pctClassname(item.change24h);
                const cardContent = (
                  <>
                    <div className="flex items-center justify-between">
                      <IconAvatar symbol={item.symbol} name={item.name} image={item.image} />
                      <span className="rounded-full bg-base-300 px-2 py-0.5 text-[11px] text-base-content/60">
                        {item.symbol}
                      </span>
                    </div>
                    <p className="m-0 mt-4 line-clamp-2 text-lg font-semibold leading-snug">{item.name}</p>
                    <p className="m-0 mt-2 text-sm text-base-content/70">
                      {item.currentPrice != null ? formatUsdAdaptive(item.currentPrice, i18n.language) : '--'}
                    </p>
                    <p className={`m-0 mt-1 text-lg font-semibold ${changeClass}`}>{formatPct(item.change24h)}</p>
                  </>
                );

                if (!clickable) {
                  return (
                    <article
                      key={item.id}
                      className="min-h-[11.5rem] min-w-[11rem] snap-start rounded-xl bg-base-200/35 p-3"
                    >
                      {cardContent}
                    </article>
                  );
                }

                return (
                  <button
                    key={item.id}
                    type="button"
                    className="min-h-[11.5rem] min-w-[11rem] snap-start rounded-xl bg-base-200/35 p-3 text-left transition-colors hover:bg-base-200/70"
                    onClick={() => handleOpenToken(item, 'topMovers')}
                  >
                    {cardContent}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle title={t('trade.trending')} />
            {payload.trendings.length === 0 ? (
              <div className="rounded-full bg-base-200 px-3 py-2 text-xs text-base-content/65">
                {t('trade.noSectionData')}
              </div>
            ) : (
              <div className="-mx-1 overflow-x-auto px-1 pb-1">
                <div className="inline-flex flex-col gap-2">
                  {[0, 1].map((rowIndex) => (
                    <div key={rowIndex} className="flex w-max gap-2">
                      {payload.trendings
                        .filter((_, index) => index % 2 === rowIndex)
                        .map((item) => {
                          const clickable = canOpenToken(item);
                          const content = (
                            <>
                              <IconAvatar
                                symbol={item.symbol}
                                name={item.name}
                                image={item.image}
                                className="h-6 w-6 rounded-full bg-base-300 object-cover"
                                fallbackClassName="flex h-6 w-6 items-center justify-center rounded-full bg-base-300 text-[10px] font-semibold text-base-content/75"
                              />
                              <span className="line-clamp-1 max-w-[11rem] text-sm font-semibold">{item.name}</span>
                            </>
                          );

                          if (!clickable) {
                            return (
                              <div
                                key={item.id}
                                className="inline-flex w-fit shrink-0 items-center gap-2 rounded-full bg-base-200 px-3 py-2"
                              >
                                {content}
                              </div>
                            );
                          }

                          return (
                            <button
                              key={item.id}
                              type="button"
                              className="inline-flex w-fit shrink-0 items-center gap-2 rounded-full bg-base-200 px-3 py-2 text-left transition-colors hover:bg-base-300"
                              onClick={() => handleOpenToken(item, 'trendings')}
                            >
                              {content}
                            </button>
                          );
                        })}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle title={t('trade.perps')} />
            <div className="overflow-hidden rounded-xl bg-base-200/35">
              {payload.perps.length === 0 && (
                <div className="px-4 py-4 text-sm text-base-content/65">{t('trade.noSectionData')}</div>
              )}
              {payload.perps.slice(0, 5).map((item) => {
                return (
                  <div
                    key={item.id}
                    className="flex items-start justify-between gap-3 border-b border-base-content/10 px-4 py-3 last:border-b-0"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start justify-between gap-3 text-inherit no-underline text-left transition-colors hover:bg-base-200/70"
                      onClick={() => onOpenMarketDetail('perp', toDetailItemId(item))}
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <IconAvatar symbol={item.symbol} name={item.name} image={item.image} />
                        <div className="min-w-0 flex-1 text-left">
                          <p className="m-0 text-sm font-semibold">{item.symbol}</p>
                          <p className="m-0 mt-0.5 text-xs text-base-content/60">
                            {t('trade.volumeShort')}: {formatCompactUsd(item.volume24h, i18n.language)}
                            {item.metaValue != null ? `  ${t('trade.openInterestShort')}: ${formatCompactUsd(item.metaValue, i18n.language)}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="m-0 text-sm text-base-content/70">
                          {item.currentPrice != null ? formatUsdAdaptive(item.currentPrice, i18n.language) : '--'}
                        </p>
                        <p className={`m-0 mt-0.5 text-base font-semibold ${pctClassname(item.change24h)}`}>
                          {formatPct(item.change24h)}
                        </p>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle title={t('trade.prediction')} />
            <div className="overflow-hidden rounded-xl bg-base-200/35">
              {payload.predictions.length === 0 && (
                <div className="px-4 py-4 text-sm text-base-content/65">{t('trade.noSectionData')}</div>
              )}
              {payload.predictions.slice(0, 5).map((market: TradeBrowsePredictionItem) => {
                return (
                  <div
                    key={market.id}
                    className="flex items-start justify-between gap-3 border-b border-base-content/10 px-4 py-3 last:border-b-0"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start justify-between gap-3 text-inherit no-underline text-left transition-colors hover:bg-base-200/70"
                      onClick={() => onOpenMarketDetail('prediction', toDetailItemId(market))}
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <IconAvatar symbol={market.title} name={market.title} image={market.image} />
                        <div className="min-w-0 flex-1 text-left">
                          <p className="m-0 line-clamp-2 text-sm font-semibold">{market.title}</p>
                          <p className="m-0 mt-1 text-xs text-base-content/60">
                            {t('trade.volumeShort')}: {formatCompactUsd(market.volume24h, i18n.language)}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="m-0 rounded-full bg-success/15 px-2 py-0.5 text-sm font-semibold text-success">
                          {market.probability != null ? `${market.probability.toFixed(1)}%` : '--'}
                        </p>
                        <p className="m-0 mt-1 text-xs text-base-content/60">{t('trade.probability')}</p>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      <TokenSearchModal
        visible={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectItem={handleSearchSelect}
      />
    </section>
  );
}
