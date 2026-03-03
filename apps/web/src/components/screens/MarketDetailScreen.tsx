import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Liveline } from 'liveline';
import type { CandlePoint, LivelinePoint } from 'liveline';
import {
  addMarketWatchlistAsset,
  getMarketWatchlist,
  getTradeMarketKline,
  getTokenKline,
  getTradeBrowse,
  ingestAgentEvent,
  removeMarketWatchlistAsset,
  type KlinePeriod,
  type TradeBrowseMarketItem,
  type TradeBrowsePredictionOption,
  type TradeBrowsePredictionItem,
} from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useTheme } from '../../contexts/ThemeContext';
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

const KLINE_PERIOD_OPTIONS: Array<{
  value: KlinePeriod;
  labelKey: string;
}> = [
  { value: '15m', labelKey: 'trade.klinePeriod15m' },
  { value: '1h', labelKey: 'trade.klinePeriod1h' },
  { value: '4h', labelKey: 'trade.klinePeriod4h' },
  { value: '1d', labelKey: 'trade.klinePeriod1d' },
];

const KLINE_CANDLE_WIDTH_SECONDS: Record<KlinePeriod, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
  '1w': 604_800,
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

function resolveThemeColor(variable: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;

  const probe = document.createElement('span');
  probe.style.color = `var(${variable})`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color.trim();
  probe.remove();
  return resolved || fallback;
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
  const { resolvedTheme } = useTheme();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const [isWatchlistToggling, setIsWatchlistToggling] = useState(false);
  const [klinePeriod, setKlinePeriod] = useState<KlinePeriod>('1h');
  const [chartMode, setChartMode] = useState<'line' | 'candle'>('line');
  const [pendingKlinePeriod, setPendingKlinePeriod] = useState<KlinePeriod | null>(null);
  const [selectedPredictionOptionId, setSelectedPredictionOptionId] = useState<string | null>(null);

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
  const predictionOptions = activePredictionItem?.options ?? [];
  const selectedPredictionOption = useMemo<TradeBrowsePredictionOption | null>(() => {
    if (!predictionOptions.length) return null;
    if (selectedPredictionOptionId) {
      const matched = predictionOptions.find((option) => option.id === selectedPredictionOptionId);
      if (matched) return matched;
    }
    const ranked = predictionOptions
      .filter((option) => Boolean(option.tokenId))
      .slice()
      .sort((a, b) => (b.probability ?? Number.NEGATIVE_INFINITY) - (a.probability ?? Number.NEGATIVE_INFINITY));
    return ranked[0] ?? predictionOptions[0] ?? null;
  }, [predictionOptions, selectedPredictionOptionId]);

  const displayName = activeMarketItem?.name ?? activePredictionItem?.title ?? normalizedItemId;
  const displaySymbol = activeMarketItem?.symbol ?? '';
  const displayImage = activeMarketItem?.image ?? activePredictionItem?.image ?? null;
  const displayPrice = activeMarketItem?.currentPrice ?? null;
  const displayChange24h = activeMarketItem?.change24h ?? null;
  const displayVolume24h = activeMarketItem?.volume24h ?? activePredictionItem?.volume24h ?? null;
  const displayProbability = selectedPredictionOption?.probability ?? activePredictionItem?.probability ?? null;
  const displayExternalUrl = activeMarketItem?.externalUrl ?? activePredictionItem?.url ?? null;
  const displaySource = activeMarketItem?.source ?? activePredictionItem?.source ?? null;
  const displayMetaLabel = activeMarketItem?.metaLabel ?? null;
  const displayMetaValue = activeMarketItem?.metaValue ?? null;
  const displayChain = activeMarketItem?.chain ?? null;
  const displayContract = activeMarketItem?.contract ?? null;
  const selectedPredictionTokenId = selectedPredictionOption?.tokenId ?? null;
  const normalizedKlineChain = (displayChain ?? '').trim().toLowerCase();
  const normalizedKlineContract = (displayContract ?? '').trim().toLowerCase();
  const hasKlineSupport = normalizedType === 'stock'
    ? Boolean(normalizedKlineChain) && /^0x[a-f0-9]{40}$/.test(normalizedKlineContract)
    : normalizedType === 'perp'
      ? Boolean(perpItem)
      : Boolean(activePredictionItem) && Boolean(selectedPredictionTokenId);

  const { data: klineData, isLoading: isKlineLoading } = useQuery({
    queryKey: [
      'trade-market-kline',
      normalizedType,
      normalizedItemId,
      normalizedKlineChain,
      normalizedKlineContract,
      selectedPredictionTokenId,
      klinePeriod,
    ],
    queryFn: () => (
      normalizedType === 'stock'
        ? getTokenKline(normalizedKlineChain, normalizedKlineContract, klinePeriod, 60)
        : getTradeMarketKline(
          normalizedType,
          normalizedItemId,
          klinePeriod,
          60,
          normalizedType === 'prediction' ? selectedPredictionTokenId : null,
        )
    ),
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled: hasKlineSupport,
  });

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
  const chartCandles = useMemo<CandlePoint[]>(
    () =>
      (klineData ?? []).map((item) => ({
        time: item.time,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
      })),
    [klineData],
  );
  const chartLine = useMemo<LivelinePoint[]>(
    () =>
      chartCandles.map((item) => ({
        time: item.time,
        value: item.close,
      })),
    [chartCandles],
  );
  const latestChartValue = chartLine.length > 0
    ? chartLine[chartLine.length - 1].value
    : normalizedType === 'prediction'
      ? Number(selectedPredictionOption?.probability ?? displayProbability ?? 0)
      : Number(displayPrice ?? 0);
  const candleWidth = KLINE_CANDLE_WIDTH_SECONDS[klinePeriod];
  const chartWindow = Math.max(candleWidth * Math.min(chartCandles.length || 30, 60), candleWidth * 10);
  const isChartLoading = hasKlineSupport && isKlineLoading && chartCandles.length === 0;
  const chartColor = useMemo(
    () => resolveThemeColor('--color-base-content', resolvedTheme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'),
    [resolvedTheme],
  );

  useEffect(() => {
    ingestAgentEvent('asset_viewed', {
      asset: (displaySymbol || displayName).toUpperCase(),
      itemId: normalizedItemId,
      marketType: normalizedType,
      source: 'trade_market_detail',
    }).catch(() => undefined);
  }, [displayName, displaySymbol, normalizedItemId, normalizedType]);

  useEffect(() => {
    if (normalizedType !== 'prediction') {
      setSelectedPredictionOptionId(null);
      return;
    }
    if (!predictionOptions.length) {
      setSelectedPredictionOptionId(null);
      return;
    }
    const hasCurrent = selectedPredictionOptionId
      ? predictionOptions.some((option) => option.id === selectedPredictionOptionId)
      : false;
    if (hasCurrent) return;
    const ranked = predictionOptions
      .filter((option) => Boolean(option.tokenId))
      .slice()
      .sort((a, b) => (b.probability ?? Number.NEGATIVE_INFINITY) - (a.probability ?? Number.NEGATIVE_INFINITY));
    const fallback = ranked[0] ?? predictionOptions[0];
    setSelectedPredictionOptionId(fallback?.id ?? null);
  }, [normalizedType, predictionOptions, selectedPredictionOptionId]);

  async function switchKlinePeriod(nextPeriod: KlinePeriod): Promise<void> {
    if (!hasKlineSupport || nextPeriod === klinePeriod || pendingKlinePeriod) return;
    setPendingKlinePeriod(nextPeriod);
    try {
      await queryClient.fetchQuery({
        queryKey: [
          'trade-market-kline',
          normalizedType,
          normalizedItemId,
          normalizedKlineChain,
          normalizedKlineContract,
          selectedPredictionTokenId,
          nextPeriod,
        ],
        queryFn: () => (
          normalizedType === 'stock'
            ? getTokenKline(normalizedKlineChain, normalizedKlineContract, nextPeriod, 60)
            : getTradeMarketKline(
              normalizedType,
              normalizedItemId,
              nextPeriod,
              60,
              normalizedType === 'prediction' ? selectedPredictionTokenId : null,
            )
        ),
        staleTime: 20_000,
      });
      setKlinePeriod(nextPeriod);
    } finally {
      setPendingKlinePeriod(null);
    }
  }

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

  function openExternalMarket(optionLabel?: string): void {
    if (!displayExternalUrl) return;
    if (optionLabel) {
      ingestAgentEvent('trade_buy', {
        asset: (displaySymbol || displayName).toUpperCase(),
        itemId: normalizedItemId,
        marketType: normalizedType,
        option: optionLabel,
        source: 'trade_market_detail',
      }).catch(() => undefined);
    }
    window.open(displayExternalUrl, '_blank', 'noopener,noreferrer');
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

      {normalizedType === 'prediction' && (
        <section className="p-0">
          <h2 className="m-0 text-lg font-bold">{t('trade.betOptions')}</h2>
          {!predictionOptions.length ? (
            <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noPredictionOptions')}</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {predictionOptions.map((option) => {
                const selected = selectedPredictionOption?.id === option.id;
                return (
                  <div
                    key={option.id}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                      selected ? 'border-primary/60 bg-primary/10' : 'border-base-content/10 bg-base-200/30'
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setSelectedPredictionOptionId(option.id)}
                    >
                      <p className="m-0 text-sm font-semibold">{option.label}</p>
                      <p className="m-0 mt-0.5 text-xs text-base-content/60">
                        {t('trade.probability')}: {formatProbability(option.probability)}
                      </p>
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs btn-primary border-0"
                      onClick={() => openExternalMarket(option.label)}
                      disabled={!displayExternalUrl}
                    >
                      {t('trade.betNow')}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section className="p-0">
        <h2 className="m-0 text-lg font-bold">{t('trade.klineTitle')}</h2>
        {hasKlineSupport ? (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              {KLINE_PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`btn btn-xs border-0 px-3 ${klinePeriod === option.value ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => void switchKlinePeriod(option.value)}
                  disabled={pendingKlinePeriod != null}
                >
                  {pendingKlinePeriod === option.value ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    t(option.labelKey)
                  )}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={`btn btn-xs border-0 px-3 ${chartMode === 'line' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setChartMode('line')}
              >
                line
              </button>
              <button
                type="button"
                className={`btn btn-xs border-0 px-3 ${chartMode === 'candle' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setChartMode('candle')}
              >
                candle
              </button>
            </div>
            {isChartLoading ? (
              <div className="mt-3">
                <div className="h-72 overflow-hidden rounded-lg bg-base-200/30 px-2 py-2">
                  <svg viewBox="0 0 640 220" className="h-full w-full" role="img" aria-label={t('trade.loadingKline')}>
                    <defs>
                      <linearGradient id="loading-market-kline-line" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
                        <stop offset="50%" stopColor="currentColor" stopOpacity="0.9" />
                        <stop offset="100%" stopColor="currentColor" stopOpacity="0.3" />
                      </linearGradient>
                    </defs>
                    <line
                      x1="24"
                      y1="110"
                      x2="616"
                      y2="110"
                      stroke="url(#loading-market-kline-line)"
                      strokeWidth="3"
                      strokeLinecap="round"
                      className="text-base-content/70"
                    />
                  </svg>
                </div>
              </div>
            ) : chartCandles.length === 0 ? (
              <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noKline')}</p>
            ) : (
              <div className="mt-2 h-72 overflow-hidden p-0">
                <Liveline
                  mode="candle"
                  data={chartLine}
                  value={latestChartValue}
                  candles={chartCandles}
                  candleWidth={candleWidth}
                  liveCandle={chartCandles[chartCandles.length - 1]}
                  lineMode={chartMode === 'line'}
                  lineData={chartLine}
                  lineValue={latestChartValue}
                  theme={resolvedTheme}
                  color={chartColor}
                  badge={false}
                  window={chartWindow}
                  formatValue={(value) => (
                    normalizedType === 'prediction'
                      ? `${value.toFixed(2)}%`
                      : formatUsdAdaptive(value, i18n.language)
                  )}
                  formatTime={() => ''}
                  grid={false}
                  scrub
                  padding={{ top: 6, right: 6, bottom: 6, left: 6 }}
                />
              </div>
            )}
          </>
        ) : (
          <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noKline')}</p>
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
            onClick={() => openExternalMarket()}
          >
            {t('trade.openExternal')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
