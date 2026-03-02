import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getMarketShelves, type MarketShelf, type TopMarketAsset } from '../../api';
import { AssetListItem } from '../AssetListItem';
import { CachedIconImage } from '../CachedIconImage';
import { SkeletonAssetListItem, SkeletonBlock } from '../Skeleton';
import { formatUsdAdaptive } from '../../utils/currency';
import { cacheStores, readCache, writeCache } from '../../utils/indexedDbCache';
import { SettingsDropdown } from '../SettingsDropdown';

type TradeScreenProps = {
  onOpenToken: (token: TopMarketAsset, shelfId: string) => void;
  onLogout: () => void;
};

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function getTokenInitial(token: TopMarketAsset): string {
  const label = (token.symbol ?? token.name ?? '').trim();
  return label ? label[0].toUpperCase() : '?';
}

const PULL_REFRESH_THRESHOLD_PX = 72;
const PULL_REFRESH_MAX_PX = 120;
const MANUAL_REFRESH_COOLDOWN_MS = 5_000;
const TRADE_SHELVES_CACHE_KEY = 'trade-market-shelves:v1:limit=10';
const TRADE_SHELVES_CACHE_TTL_MS = 15 * 60 * 1000;

export function TradeScreen({ onOpenToken, onLogout }: TradeScreenProps) {
  const { t, i18n } = useTranslation();
  const pullStartYRef = useRef<number | null>(null);
  const lastManualRefreshAtRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [cachedShelves, setCachedShelves] = useState<MarketShelf[] | null>(null);

  const {
    data: shelfData,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['market-shelves', 10],
    queryFn: () =>
      getMarketShelves({
        limitPerShelf: 10,
      }),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const shelves = useMemo(() => shelfData ?? cachedShelves ?? [], [cachedShelves, shelfData]);
  const hasAnyShelfAssets = useMemo(
    () => shelves.some((shelf) => shelf.assets.length > 0),
    [shelves],
  );
  const shouldShowLoading = isLoading && shelves.length === 0;
  const shouldShowError = isError && shelves.length === 0;

  useEffect(() => {
    if (!shelfData || shelfData.length === 0) return;
    void writeCache<MarketShelf[]>(
      cacheStores.query,
      TRADE_SHELVES_CACHE_KEY,
      shelfData,
      TRADE_SHELVES_CACHE_TTL_MS,
    );
  }, [shelfData]);

  useEffect(() => {
    if (shelfData) return;
    void readCache<MarketShelf[]>(cacheStores.query, TRADE_SHELVES_CACHE_KEY).then((data) => {
      if (!data || data.length === 0) return;
      setCachedShelves(data);
    });
  }, [shelfData]);

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

  return (
    <section
      className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-28"
      onTouchStart={handleListTouchStart}
      onTouchMove={handleListTouchMove}
      onTouchEnd={handleListTouchEnd}
      onTouchCancel={handleListTouchEnd}
    >
      <header className="mt-4 flex items-center justify-between gap-3">
        <h1 className="m-0 text-2xl font-bold tracking-tight">{t('trade.title')}</h1>
        <SettingsDropdown onLogout={onLogout} />
      </header>

      {(pullDistance > 0 || isPullRefreshing) && (
        <div className="text-center text-xs text-base-content/60">
          {isPullRefreshing
            ? t('trade.refreshing')
            : pullDistance >= PULL_REFRESH_THRESHOLD_PX
              ? t('trade.refresh')
              : t('trade.pullToRefresh')}
        </div>
      )}

      {shouldShowLoading && (
        <section className="flex flex-col gap-5" aria-label={t('trade.loadingAssets')}>
          {Array.from({ length: 2 }).map((_, shelfIndex) => (
            <section key={`trade-skeleton-shelf-${shelfIndex}`} className="rounded-xl bg-base-200/35 p-3">
              <SkeletonBlock className="h-6 w-36" />
              <div className="mt-2 flex flex-col gap-1">
                {Array.from({ length: 4 }).map((__, rowIndex) => (
                  <SkeletonAssetListItem
                    key={`trade-skeleton-row-${shelfIndex}-${rowIndex}`}
                    className="bg-transparent py-3"
                  />
                ))}
              </div>
            </section>
          ))}
        </section>
      )}
      {shouldShowError && (
        <div className="bg-error/10 p-4 text-error">
          {t('trade.loadFailed', { message: (error as Error).message })}
        </div>
      )}
      {!shouldShowLoading && !shouldShowError && !hasAnyShelfAssets && (
        <div className="bg-base-200 p-4 text-sm">{t('trade.empty')}</div>
      )}

      <section className="flex flex-col gap-5">
        {shelves.map((shelf: MarketShelf) => (
          <section key={shelf.id} className="rounded-xl bg-base-200/35 p-3">
            <h2 className="m-0 text-lg font-semibold">{shelf.title}</h2>
            {shelf.assets.length === 0 ? (
              <p className="m-0 mt-2 text-sm text-base-content/60">{t('trade.empty')}</p>
            ) : (
              <div className="mt-2 flex flex-col gap-1">
                {shelf.assets.map((token) => (
                  <button
                    key={`${shelf.id}:${token.id}`}
                    type="button"
                    className="w-full cursor-pointer px-2 text-start transition-colors hover:bg-base-200/60"
                    onClick={() => onOpenToken(token, shelf.id)}
                  >
                    <AssetListItem
                      className="py-3"
                      leftIcon={
                        token.image ? (
                          <CachedIconImage
                            src={token.image}
                            alt={token.symbol}
                            className="h-10 w-10 rounded-full bg-base-300 object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-base font-semibold text-base-content/70">
                            {getTokenInitial(token)}
                          </div>
                        )
                      }
                      leftPrimary={token.symbol.toUpperCase()}
                      leftSecondary={token.name ?? t('trade.unknownAsset')}
                      rightPrimary={
                        token.current_price != null
                          ? formatUsdAdaptive(token.current_price, i18n.language)
                          : t('trade.priceUnavailable')
                      }
                      rightSecondary={formatPct(token.price_change_percentage_24h)}
                    />
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      </section>
    </section>
  );
}
