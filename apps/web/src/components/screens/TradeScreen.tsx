import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  addMarketWatchlistAsset,
  getMarketWatchlist,
  removeMarketWatchlistAsset,
  getTradeBrowse,
  type TopMarketAsset,
  type TradeBrowseMarketItem,
  type TradeBrowsePredictionItem,
  type TradeBrowseResponse,
} from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { CachedIconImage } from '../CachedIconImage';
import { SkeletonBlock } from '../Skeleton';
import { formatUsdAdaptive } from '../../utils/currency';
import { cacheStores, readCache, writeCache } from '../../utils/indexedDbCache';
import { SettingsDropdown } from '../SettingsDropdown';
import {
  normalizeWatchlistItemId,
  type TradeMarketDetailType,
} from '../../utils/tradeMarketDetail';

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
const WATCHLIST_CACHE_KEY = ['market-watchlist', 200] as const;
type WatchCategory = 'stock' | 'perps' | 'prediction';

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

function canOpenToken(item: TradeBrowseMarketItem): item is TradeBrowseMarketItem & { chain: string; contract: string } {
  const chain = item.chain?.trim();
  const contract = item.contract?.trim();
  if (!chain || !contract) return false;
  if (contract.toLowerCase() === 'native') return false;
  return /^0x[a-fA-F0-9]{40}$/.test(contract);
}

function toTopMarketAsset(item: TradeBrowseMarketItem & { chain: string; contract: string }): TopMarketAsset {
  const chainAssetId = `${item.chain}:${item.contract.toLowerCase()}`;
  return {
    id: item.id,
    asset_id: item.id,
    chain_asset_id: chainAssetId,
    chain: item.chain,
    contract: item.contract,
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

function toGenericWatchKey(type: WatchCategory, itemId: string): string {
  return `${type}:${normalizeWatchlistItemId(itemId) ?? ''}`;
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
}: {
  symbol: string;
  name: string;
  image: string | null;
  className?: string;
}) {
  if (image) {
    return (
      <CachedIconImage
        src={image}
        alt={symbol}
        className={className ?? 'h-9 w-9 rounded-full bg-white/10 object-cover'}
        loading="lazy"
      />
    );
  }
  return (
    <div
      className={className ?? 'flex h-9 w-9 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/75'}
    >
      {getLabelInitial(symbol, name)}
    </div>
  );
}

export function TradeScreen({ onOpenToken, onOpenMarketDetail, onLogout }: TradeScreenProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { showError, showSuccess } = useToast();
  const pullStartYRef = useRef<number | null>(null);
  const lastManualRefreshAtRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [cachedPayload, setCachedPayload] = useState<TradeBrowseResponse | null>(null);
  const [watchlistBusyKey, setWatchlistBusyKey] = useState<string | null>(null);

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

  const { data: watchlistResponse } = useQuery({
    queryKey: WATCHLIST_CACHE_KEY,
    queryFn: () => getMarketWatchlist({ limit: 200 }),
    staleTime: 15_000,
  });
  const watchlistAssets = watchlistResponse?.assets ?? [];
  const genericWatchlistLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const asset of watchlistAssets) {
      const type = asset.watch_type;
      if (type !== 'stock' && type !== 'perps' && type !== 'prediction') continue;
      const itemId = asset.item_id?.trim();
      if (!itemId) continue;
      lookup.set(toGenericWatchKey(type, itemId), asset.id);
    }
    return lookup;
  }, [watchlistAssets]);

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
    if (!canOpenToken(item)) return;
    onOpenToken(toTopMarketAsset(item), section);
  }

  async function toggleGenericWatch(
    type: WatchCategory,
    item: TradeBrowseMarketItem | TradeBrowsePredictionItem,
  ): Promise<void> {
    const itemId = item.id.trim();
    if (!itemId) return;
    const normalizedItemId = normalizeWatchlistItemId(itemId);
    if (!normalizedItemId) return;
    const key = toGenericWatchKey(type, normalizedItemId);
    if (watchlistBusyKey) return;
    setWatchlistBusyKey(key);
    try {
      const watchlistId = genericWatchlistLookup.get(key);
      if (watchlistId) {
        await removeMarketWatchlistAsset({ id: watchlistId });
        showSuccess(t('trade.watchRemoved'));
      } else {
        const isPrediction = type === 'prediction';
        await addMarketWatchlistAsset({
          watchType: type,
          itemId,
          symbol: isPrediction ? (item as TradeBrowsePredictionItem).title.slice(0, 24) : (item as TradeBrowseMarketItem).symbol,
          name: isPrediction ? (item as TradeBrowsePredictionItem).title : (item as TradeBrowseMarketItem).name,
          image: item.image ?? null,
          source: `trade_${type}`,
          change24h: isPrediction ? null : (item as TradeBrowseMarketItem).change24h ?? null,
          externalUrl: isPrediction
            ? (item as TradeBrowsePredictionItem).url ?? null
            : (item as TradeBrowseMarketItem).externalUrl ?? null,
        });
        showSuccess(t('trade.watchAdded'));
      }
      await queryClient.invalidateQueries({ queryKey: ['market-watchlist'] });
    } catch (error) {
      showError(`${t('common.error')}: ${(error as Error).message}`);
    } finally {
      setWatchlistBusyKey(null);
    }
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
        <SettingsDropdown onLogout={onLogout} />
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
            <SectionTitle title={t('trade.stocks')} />
            <div className="overflow-hidden rounded-xl bg-base-200/35">
              {payload.stocks.length === 0 && (
                <div className="px-4 py-4 text-sm text-base-content/65">{t('trade.noSectionData')}</div>
              )}
              {payload.stocks.map((item) => {
                const changeClass = pctClassname(item.change24h);
                const watchKey = toGenericWatchKey('stock', item.id);
                const isWatched = genericWatchlistLookup.has(watchKey);
                const isWatchBusy = watchlistBusyKey === watchKey;
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3 last:border-b-0"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left transition-colors hover:bg-base-200/70"
                      onClick={() => onOpenMarketDetail('stock', item.id)}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <IconAvatar symbol={item.symbol} name={item.name} image={item.image} />
                        <div className="min-w-0">
                          <p className="m-0 truncate text-[15px] font-semibold">{item.name}</p>
                          <p className="m-0 mt-0.5 text-xs text-base-content/55">{item.symbol}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="m-0 text-sm text-base-content/65">{formatCompactUsd(item.currentPrice, i18n.language)}</p>
                        <p className={`m-0 mt-0.5 text-base font-semibold ${changeClass}`}>{formatPct(item.change24h)}</p>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={`btn btn-xs ml-2 border-0 ${isWatched ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => void toggleGenericWatch('stock', item)}
                      disabled={isWatchBusy}
                    >
                      {isWatchBusy ? <span className="loading loading-spinner loading-xs" /> : isWatched ? t('trade.watching') : t('trade.watch')}
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
                const watchKey = toGenericWatchKey('perps', item.id);
                const isWatched = genericWatchlistLookup.has(watchKey);
                const isWatchBusy = watchlistBusyKey === watchKey;
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3 last:border-b-0"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 text-inherit no-underline transition-colors hover:bg-base-200/70"
                      onClick={() => onOpenMarketDetail('perp', item.id)}
                    >
                      <div className="min-w-0">
                        <p className="m-0 text-sm font-semibold">{item.symbol}</p>
                        <p className="m-0 mt-0.5 text-xs text-base-content/60">
                          {t('trade.volumeShort')}: {formatCompactUsd(item.volume24h, i18n.language)}
                          {item.metaValue != null ? `  ${t('trade.openInterestShort')}: ${formatCompactUsd(item.metaValue, i18n.language)}` : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="m-0 text-sm text-base-content/70">
                          {item.currentPrice != null ? formatUsdAdaptive(item.currentPrice, i18n.language) : '--'}
                        </p>
                        <p className={`m-0 mt-0.5 text-base font-semibold ${pctClassname(item.change24h)}`}>
                          {formatPct(item.change24h)}
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={`btn btn-xs ml-2 border-0 ${isWatched ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => void toggleGenericWatch('perps', item)}
                      disabled={isWatchBusy}
                    >
                      {isWatchBusy ? <span className="loading loading-spinner loading-xs" /> : isWatched ? t('trade.watching') : t('trade.watch')}
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
                const watchKey = toGenericWatchKey('prediction', market.id);
                const isWatched = genericWatchlistLookup.has(watchKey);
                const isWatchBusy = watchlistBusyKey === watchKey;
                return (
                  <div
                    key={market.id}
                    className="flex items-start justify-between gap-3 border-b border-base-content/10 px-4 py-3 last:border-b-0"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start justify-between gap-3 text-inherit no-underline transition-colors hover:bg-base-200/70"
                      onClick={() => onOpenMarketDetail('prediction', market.id)}
                    >
                      <div className="min-w-0">
                        <p className="m-0 line-clamp-2 text-sm font-semibold">{market.title}</p>
                        <p className="m-0 mt-1 text-xs text-base-content/60">
                          {t('trade.volumeShort')}: {formatCompactUsd(market.volume24h, i18n.language)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="m-0 rounded-full bg-success/15 px-2 py-0.5 text-sm font-semibold text-success">
                          {market.probability != null ? `${market.probability.toFixed(1)}%` : '--'}
                        </p>
                        <p className="m-0 mt-1 text-xs text-base-content/60">{t('trade.probability')}</p>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={`btn btn-xs ml-2 border-0 ${isWatched ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => void toggleGenericWatch('prediction', market)}
                      disabled={isWatchBusy}
                    >
                      {isWatchBusy ? <span className="loading loading-spinner loading-xs" /> : isWatched ? t('trade.watching') : t('trade.watch')}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
