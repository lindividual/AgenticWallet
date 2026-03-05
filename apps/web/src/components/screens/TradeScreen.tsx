import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  getTradeBrowse,
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

function resolveRoutableToken(item: TradeBrowseMarketItem): { chain: string; contract: string } | null {
  const chain = item.chain?.trim().toLowerCase() ?? '';
  const contract = item.contract?.trim().toLowerCase() ?? '';
  if (chain) {
    if (!contract || contract === 'native') {
      return { chain, contract: '' };
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
    instrument_id: item.instrument_id,
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
  const pullStartYRef = useRef<number | null>(null);
  const lastManualRefreshAtRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [cachedPayload, setCachedPayload] = useState<TradeBrowseResponse | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

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

  const hasAnySectionData = useMemo(() => {
    if (!payload) return false;
    return payload.topMovers.length > 0
      || payload.trendings.length > 0
      || payload.stocks.length > 0
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
    onOpenMarketDetail('stock', item.id);
  }

  function toDetailItemId(item: { id: string; instrument_id?: string }): string {
    return item.instrument_id?.trim() || item.id;
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
          <p className="m-0 mt-1 text-sm text-base-content/65">{t('trade.title')}</p>
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
            <div className="flex flex-wrap gap-2">
              {payload.trendings.length === 0 && (
                <div className="rounded-full bg-base-200 px-3 py-2 text-xs text-base-content/65">
                  {t('trade.noSectionData')}
                </div>
              )}
              {payload.trendings.map((item) => {
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
                      className="inline-flex items-center gap-2 rounded-full bg-base-200 px-3 py-2"
                    >
                      {content}
                    </div>
                  );
                }

                return (
                  <button
                    key={item.id}
                    type="button"
                    className="inline-flex items-center gap-2 rounded-full bg-base-200 px-3 py-2 text-left transition-colors hover:bg-base-300"
                    onClick={() => handleOpenToken(item, 'trendings')}
                  >
                    {content}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <SectionTitle title={t('trade.stocks')} />
            </div>
            <div className="overflow-hidden rounded-xl bg-base-200/35">
              {payload.stocks.length === 0 && (
                <div className="px-4 py-4 text-sm text-base-content/65">{t('trade.noSectionData')}</div>
              )}
              {payload.stocks.map((item) => {
                const changeClass = pctClassname(item.change24h);
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3 last:border-b-0"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left transition-colors hover:bg-base-200/70"
                      onClick={() => onOpenMarketDetail('stock', toDetailItemId(item))}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <IconAvatar symbol={item.symbol} name={item.name} image={item.image} />
                        <div className="min-w-0">
                          <p className="m-0 truncate text-[15px] font-semibold">{item.symbol}</p>
                          <p className="m-0 mt-0.5 text-xs text-base-content/55">{item.name}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="m-0 text-sm text-base-content/65">
                          {item.currentPrice != null ? formatUsdAdaptive(item.currentPrice, i18n.language) : '--'}
                        </p>
                        <p className={`m-0 mt-0.5 text-base font-semibold ${changeClass}`}>{formatPct(item.change24h)}</p>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle title={t('trade.perps')} />
            <div className="overflow-hidden rounded-xl bg-base-200/35">
              {payload.perps.length === 0 && (
                <div className="px-4 py-4 text-sm text-base-content/65">{t('trade.noSectionData')}</div>
              )}
              {payload.perps.map((item) => {
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
              {payload.predictions.map((market: TradeBrowsePredictionItem) => {
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
