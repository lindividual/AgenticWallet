import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  addMarketWatchlistAsset,
  getMarketWatchlist,
  getTradeBrowse,
  ingestAgentEvent,
  removeMarketWatchlistAsset,
  type TradeBrowseMarketItem,
  type TradeBrowsePredictionItem,
} from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { formatUsdAdaptive } from '../../utils/currency';
import {
  normalizeTradeMarketDetailType,
  normalizeWatchlistItemId,
  toWatchTypeFromTradeMarketType,
  type TradeMarketDetailType,
} from '../../utils/tradeMarketDetail';
import { CachedIconImage } from '../CachedIconImage';
import { SkeletonBlock } from '../Skeleton';

type MarketDetailScreenProps = {
  marketType: TradeMarketDetailType;
  itemId: string;
  onBack: () => void;
};

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function formatCompact(value: number | null | undefined, locale: string): string {
  if (!Number.isFinite(Number(value))) return '--';
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function getLabelInitial(symbol: string | null | undefined, name: string | null | undefined): string {
  const label = (symbol ?? name ?? '').trim();
  return label ? label[0].toUpperCase() : '?';
}

function buildSyntheticWatchKey(watchType: 'stock' | 'perps' | 'prediction', itemId: string): { chain: string; contract: string } | null {
  const normalized = normalizeWatchlistItemId(itemId);
  if (!normalized) return null;
  return {
    chain: `watch:${watchType}`,
    contract: `item:${normalized}`,
  };
}

function formatProbability(probability: number | null | undefined): string {
  if (!Number.isFinite(Number(probability))) return '--';
  return `${Number(probability).toFixed(1)}%`;
}

export function MarketDetailScreen({ marketType, itemId, onBack }: MarketDetailScreenProps) {
  const { t, i18n } = useTranslation();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const [isWatchlistToggling, setIsWatchlistToggling] = useState(false);

  const normalizedType = normalizeTradeMarketDetailType(marketType) ?? 'stock';
  const normalizedItemId = itemId.trim();

  const { data: browseData, isLoading } = useQuery({
    queryKey: ['trade-browse'],
    queryFn: () => getTradeBrowse(),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const { data: watchlistData } = useQuery({
    queryKey: ['market-watchlist', 200],
    queryFn: () => getMarketWatchlist({ limit: 200 }),
    staleTime: 15_000,
  });

  const stockItem = useMemo<TradeBrowseMarketItem | null>(
    () => browseData?.stocks.find((item) => item.id === normalizedItemId) ?? null,
    [browseData?.stocks, normalizedItemId],
  );
  const perpItem = useMemo<TradeBrowseMarketItem | null>(
    () => browseData?.perps.find((item) => item.id === normalizedItemId) ?? null,
    [browseData?.perps, normalizedItemId],
  );
  const predictionItem = useMemo<TradeBrowsePredictionItem | null>(
    () => browseData?.predictions.find((item) => item.id === normalizedItemId) ?? null,
    [browseData?.predictions, normalizedItemId],
  );

  const activeMarketItem = normalizedType === 'stock' ? stockItem : normalizedType === 'perp' ? perpItem : null;
  const activePredictionItem = normalizedType === 'prediction' ? predictionItem : null;

  const displayName = activeMarketItem?.name ?? activePredictionItem?.title ?? normalizedItemId;
  const displaySymbol = activeMarketItem?.symbol ?? '';
  const displayImage = activeMarketItem?.image ?? activePredictionItem?.image ?? null;
  const displayPrice = activeMarketItem?.currentPrice ?? null;
  const displayChange24h = activeMarketItem?.change24h ?? null;
  const displayVolume24h = activeMarketItem?.volume24h ?? activePredictionItem?.volume24h ?? null;
  const displayProbability = activePredictionItem?.probability ?? null;
  const displayExternalUrl = activeMarketItem?.externalUrl ?? activePredictionItem?.url ?? null;
  const displaySource = activeMarketItem?.source ?? activePredictionItem?.source ?? null;
  const displayMetaLabel = activeMarketItem?.metaLabel ?? null;
  const displayMetaValue = activeMarketItem?.metaValue ?? null;
  const displayChain = activeMarketItem?.chain ?? null;
  const displayContract = activeMarketItem?.contract ?? null;

  const watchType = toWatchTypeFromTradeMarketType(normalizedType);
  const syntheticWatchKey = buildSyntheticWatchKey(watchType, normalizedItemId);

  const activeWatchAsset = useMemo(() => {
    if (!syntheticWatchKey) return null;
    return (watchlistData?.assets ?? []).find((item) => (
      item.watch_type === watchType
      && item.chain === syntheticWatchKey.chain
      && item.contract === syntheticWatchKey.contract
    )) ?? null;
  }, [syntheticWatchKey, watchType, watchlistData?.assets]);

  const isInWatchlist = Boolean(activeWatchAsset);
  const hasPrimaryValue = normalizedType === 'prediction'
    ? Number.isFinite(Number(displayProbability))
    : Number.isFinite(Number(displayPrice));
  const hasChangeValue = Number.isFinite(Number(displayChange24h));
  const numericChange = hasChangeValue ? Number(displayChange24h) : 0;
  const changeTone =
    !hasChangeValue || numericChange === 0
      ? 'text-base-content/70'
      : numericChange > 0
        ? 'text-success'
        : 'text-error';

  useEffect(() => {
    ingestAgentEvent('asset_viewed', {
      asset: (displaySymbol || displayName).toUpperCase(),
      itemId: normalizedItemId,
      marketType: normalizedType,
      source: 'trade_market_detail',
    }).catch(() => undefined);
  }, [displayName, displaySymbol, normalizedItemId, normalizedType]);

  async function toggleWatchlist(): Promise<void> {
    if (isWatchlistToggling) return;
    setIsWatchlistToggling(true);
    try {
      if (activeWatchAsset) {
        await removeMarketWatchlistAsset({
          id: activeWatchAsset.id,
        });
        showSuccess(t('trade.watchRemoved'));
      } else {
        await addMarketWatchlistAsset({
          watchType,
          itemId: normalizedItemId,
          symbol: displaySymbol || displayName.slice(0, 24),
          name: displayName,
          image: displayImage,
          source: `${normalizedType}_detail`,
          change24h: displayChange24h,
          externalUrl: displayExternalUrl,
        });
        ingestAgentEvent('asset_favorited', {
          asset: (displaySymbol || displayName).toUpperCase(),
          itemId: normalizedItemId,
          marketType: normalizedType,
          source: 'trade_market_detail',
        }).catch(() => undefined);
        showSuccess(t('trade.watchAdded'));
      }
      await queryClient.invalidateQueries({ queryKey: ['market-watchlist'] });
    } catch (error) {
      showError(`${t('common.error')}: ${(error as Error).message}`);
    } finally {
      setIsWatchlistToggling(false);
    }
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-44">
      <header className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          className="btn btn-sm btn-ghost border-0 px-2"
          onClick={onBack}
          aria-label={t('trade.backToList')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          className={`btn btn-sm border-0 px-3 ${isInWatchlist ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => void toggleWatchlist()}
          disabled={isWatchlistToggling || !syntheticWatchKey}
        >
          {isWatchlistToggling ? (
            <span className="loading loading-spinner loading-xs" />
          ) : isInWatchlist ? (
            t('trade.watching')
          ) : (
            t('trade.watch')
          )}
        </button>
      </header>

      <section className="p-0">
        {isLoading ? (
          <div>
            <div className="flex flex-col items-start gap-3">
              <SkeletonBlock className="h-12 w-12 rounded-full" />
              <div className="min-w-0">
                <SkeletonBlock className="h-5 w-48" />
                <SkeletonBlock className="mt-2 h-4 w-20" />
              </div>
            </div>
            <div className="mt-4">
              <SkeletonBlock className="h-9 w-44" />
              <SkeletonBlock className="mt-2 h-4 w-24" />
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-start gap-3">
              {displayImage ? (
                <CachedIconImage
                  src={displayImage}
                  alt={displaySymbol || displayName}
                  className="h-12 w-12 rounded-full bg-base-300 object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-base-300 text-lg font-semibold text-base-content/70">
                  {getLabelInitial(displaySymbol, displayName)}
                </div>
              )}
              <div className="min-w-0">
                <p className="m-0 flex items-baseline gap-2">
                  <span className="truncate text-lg font-bold text-base-content/75">{displayName}</span>
                  {displaySymbol && <span className="text-sm font-medium uppercase text-base-content/50">{displaySymbol}</span>}
                </p>
              </div>
            </div>
            <div className="mt-4">
              <p className="m-0 text-3xl font-bold">
                {hasPrimaryValue
                  ? normalizedType === 'prediction'
                    ? formatProbability(displayProbability)
                    : formatUsdAdaptive(Number(displayPrice), i18n.language)
                  : t('trade.priceUnavailable')}
              </p>
              {normalizedType === 'prediction' ? (
                <p className="m-0 mt-1 text-base font-medium text-base-content/70">{t('trade.probability')}</p>
              ) : (
                <p className={`m-0 mt-1 flex items-center gap-1 text-base font-medium ${changeTone}`}>
                  <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center">
                    {hasChangeValue && numericChange > 0 ? (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 19V5" />
                        <path d="M6 11l6-6 6 6" />
                      </svg>
                    ) : hasChangeValue && numericChange < 0 ? (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14" />
                        <path d="M18 13l-6 6-6-6" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14" />
                        <path d="M15 8l4 4-4 4" />
                      </svg>
                    )}
                  </span>
                  <span>{formatPct(displayChange24h)}</span>
                </p>
              )}
            </div>
          </>
        )}
      </section>

      <section className="p-0">
        <h2 className="m-0 text-lg font-bold">{t('trade.marketInfo')}</h2>
        {isLoading ? (
          <div className="mt-3 grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={`market-info-skeleton-${index}`} className="rounded bg-base-200/40 p-2">
                <SkeletonBlock className="h-3 w-16" />
                <SkeletonBlock className="mt-2 h-4 w-20" />
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.marketType')}</p>
              <p className="m-0 mt-1 font-medium">
                {normalizedType === 'stock'
                  ? t('trade.stocks')
                  : normalizedType === 'perp'
                    ? t('trade.perps')
                    : t('trade.prediction')}
              </p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.dataSource')}</p>
              <p className="m-0 mt-1 font-medium uppercase">{displaySource ?? '--'}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.itemId')}</p>
              <p className="m-0 mt-1 truncate font-medium">{normalizedItemId || '--'}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.turnover24h')}</p>
              <p className="m-0 mt-1 font-medium">{formatCompact(displayVolume24h, i18n.language)}</p>
            </div>
            {normalizedType === 'prediction' ? (
              <div className="rounded bg-base-200/40 p-2">
                <p className="m-0 text-xs text-base-content/60">{t('trade.probability')}</p>
                <p className="m-0 mt-1 font-medium">{formatProbability(displayProbability)}</p>
              </div>
            ) : (
              <div className="rounded bg-base-200/40 p-2">
                <p className="m-0 text-xs text-base-content/60">{displayMetaLabel ?? t('trade.change24h')}</p>
                <p className="m-0 mt-1 font-medium">
                  {displayMetaValue != null ? formatCompact(displayMetaValue, i18n.language) : formatPct(displayChange24h)}
                </p>
              </div>
            )}
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.contract')}</p>
              <p className="m-0 mt-1 truncate font-medium">
                {displayContract ?? displayChain ?? '--'}
              </p>
            </div>
          </div>
        )}
      </section>

      {displayExternalUrl ? (
        <div className="fixed bottom-5 left-1/2 z-30 w-full max-w-105 -translate-x-1/2 px-5">
          <button
            type="button"
            className="btn btn-primary w-full border-0"
            onClick={() => window.open(displayExternalUrl, '_blank', 'noopener,noreferrer')}
          >
            {t('trade.openExternal')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
