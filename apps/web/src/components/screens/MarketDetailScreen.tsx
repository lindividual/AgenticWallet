import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CandlePoint, LivelinePoint } from 'liveline';
import {
  addMarketWatchlistAsset,
  getMarketByInstrumentId,
  getMarketCandlesByInstrumentId,
  getMarketWatchlist,
  getPredictionEventDetail,
  getPredictionEventKline,
  resolveAssetIdentity,
  getTradeMarketDetail,
  getTradeMarketKline,
  getTokenKline,
  getTradeBrowse,
  ingestAgentEvent,
  removeMarketWatchlistAsset,
  submitPredictionBet,
  type KlinePeriod,
  type PredictionEventOutcome,
  type PredictionEventSeries,
  type TradeBrowseMarketItem,
} from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useTheme } from '../../contexts/ThemeContext';
import { formatUsdAdaptive } from '../../utils/currency';
import { computeAdaptiveChartWindowSeconds, normalizeCandlesForLiveline, toLivelinePoints, toOpenAnchoredLivelinePoints } from '../../utils/kline';
import {
  normalizeTradeMarketDetailType,
  normalizeWatchlistItemId,
  toWatchTypeFromTradeMarketType,
  type TradeMarketDetailType,
} from '../../utils/tradeMarketDetail';
import { MarketInfoSection } from './marketDetail/MarketInfoSection';
import { MarketKlineSection, type PredictionKlineSeries } from './marketDetail/MarketKlineSection';
import { MarketSummarySection } from './marketDetail/MarketSummarySection';
import { PredictionOverviewSection } from './marketDetail/PredictionOverviewSection';
import { PredictionBetOptionsSection, type PredictionBetTarget } from './marketDetail/PredictionBetOptionsSection';

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

const PREDICTION_KLINE_PERIOD_OPTIONS: Array<{
  value: KlinePeriod;
  label: string;
}> = [
  { value: '15m', label: '1H' },
  { value: '1h', label: '6H' },
  { value: '4h', label: '1D' },
  { value: '1d', label: '1W' },
  { value: 'all', label: 'ALL' },
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
  all: 86_400,
};

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

function toFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toTradeBrowseMarketItemLike(value: unknown): TradeBrowseMarketItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.symbol !== 'string' || typeof row.name !== 'string') return null;

  const source = row.source;
  const normalizedSource =
    source === 'bitget' || source === 'coingecko' || source === 'hyperliquid' || source === 'binance'
      ? source
      : 'bitget';

  return {
    id: typeof row.id === 'string' ? row.id : '',
    asset_id: typeof row.asset_id === 'string' ? row.asset_id : undefined,
    instrument_id: typeof row.instrument_id === 'string' ? row.instrument_id : undefined,
    symbol: row.symbol,
    name: row.name,
    image: typeof row.image === 'string' ? row.image : null,
    chain: typeof row.chain === 'string' ? row.chain : null,
    contract: typeof row.contract === 'string' ? row.contract : null,
    currentPrice: toFiniteNumber(row.currentPrice) ?? toFiniteNumber(row.currentPriceUsd),
    change24h: toFiniteNumber(row.change24h) ?? toFiniteNumber(row.priceChange24h),
    volume24h: toFiniteNumber(row.volume24h),
    source: normalizedSource,
    metaLabel: typeof row.metaLabel === 'string' ? row.metaLabel : null,
    metaValue: toFiniteNumber(row.metaValue),
    externalUrl: typeof row.externalUrl === 'string' ? row.externalUrl : null,
  };
}

function toPredictionSourceItemId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  return id || null;
}

export function MarketDetailScreen({ marketType, itemId, onBack }: MarketDetailScreenProps) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const [isWatchlistToggling, setIsWatchlistToggling] = useState(false);
  const [klinePeriod, setKlinePeriod] = useState<KlinePeriod>(() => (
    normalizeTradeMarketDetailType(marketType) === 'prediction' ? 'all' : '1h'
  ));
  const [chartMode, setChartMode] = useState<'line' | 'candle'>('line');
  const [pendingKlinePeriod, setPendingKlinePeriod] = useState<KlinePeriod | null>(null);
  const [selectedPredictionOptionId, setSelectedPredictionOptionId] = useState<string | null>(null);
  const [predictionBetAmount, setPredictionBetAmount] = useState('5');
  const [pendingPredictionOptionId, setPendingPredictionOptionId] = useState<string | null>(null);

  const normalizedType = normalizeTradeMarketDetailType(marketType) ?? 'stock';
  const normalizedItemId = itemId.trim();
  const isInstrumentRouteItem = normalizedItemId.toLowerCase().startsWith('ins:');

  const { data: resolvedIdentity, isFetched: isIdentityFetched } = useQuery({
    queryKey: ['trade-market-identity', normalizedType, normalizedItemId],
    queryFn: () =>
      resolveAssetIdentity(
        normalizedType === 'stock'
          ? {
              itemId: normalizedItemId,
              marketType: 'spot',
              assetClassHint: 'equity_exposure',
            }
          : {
              itemId: normalizedItemId,
              marketType: normalizedType,
            },
      ),
    enabled: Boolean(normalizedItemId),
    staleTime: 5 * 60_000,
  });

  const activeInstrumentId = resolvedIdentity?.instrument_id?.trim() ?? null;

  const { data: instrumentMarket, isLoading: isInstrumentLoading, isFetched: isInstrumentFetched } = useQuery({
    queryKey: ['market-by-instrument', activeInstrumentId],
    queryFn: () => getMarketByInstrumentId(activeInstrumentId ?? ''),
    enabled: Boolean(activeInstrumentId),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const { data: browseData, isLoading, isFetched: isBrowseFetched } = useQuery({
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

  const { data: detailItem, isLoading: isDetailLoading, isFetched: isDetailFetched } = useQuery({
    queryKey: ['trade-market-detail', normalizedType, normalizedItemId],
    queryFn: () => getTradeMarketDetail(normalizedType, normalizedItemId),
    staleTime: 60_000,
    refetchInterval: 90_000,
    enabled: Boolean(normalizedItemId) && !isInstrumentRouteItem && normalizedType !== 'prediction',
  });

  const stockItem = useMemo<TradeBrowseMarketItem | null>(
    () => {
      const fromInstrument = normalizedType === 'stock'
        ? toTradeBrowseMarketItemLike(instrumentMarket?.providerDetail)
        : null;
      if (fromInstrument) return fromInstrument;
      const fromDetail = normalizedType === 'stock'
        ? toTradeBrowseMarketItemLike(detailItem)
        : null;
      if (fromDetail) return fromDetail;
      return browseData?.stocks.find((item) => item.id === normalizedItemId) ?? null;
    },
    [browseData?.stocks, detailItem, instrumentMarket?.providerDetail, normalizedItemId, normalizedType],
  );
  const perpItem = useMemo<TradeBrowseMarketItem | null>(
    () => {
      const fromInstrument = normalizedType === 'perp'
        ? toTradeBrowseMarketItemLike(instrumentMarket?.providerDetail)
        : null;
      if (fromInstrument) return fromInstrument;
      const fromDetail = normalizedType === 'perp'
        ? toTradeBrowseMarketItemLike(detailItem)
        : null;
      if (fromDetail) return fromDetail;
      return browseData?.perps.find((item) => item.id === normalizedItemId) ?? null;
    },
    [browseData?.perps, detailItem, instrumentMarket?.providerDetail, normalizedItemId, normalizedType],
  );
  const predictionDetailId = useMemo(() => {
    if (normalizedType !== 'prediction') return null;
    if (!isInstrumentRouteItem) return normalizedItemId || null;
    return instrumentMarket?.instrument.source_item_id?.trim()
      || toPredictionSourceItemId(instrumentMarket?.providerDetail)
      || null;
  }, [instrumentMarket?.instrument.source_item_id, instrumentMarket?.providerDetail, isInstrumentRouteItem, normalizedItemId, normalizedType]);

  const { data: predictionDetail, isLoading: isPredictionDetailLoading, isFetched: isPredictionDetailFetched } = useQuery({
    queryKey: ['prediction-event-detail', predictionDetailId],
    queryFn: () => getPredictionEventDetail(predictionDetailId ?? ''),
    enabled: normalizedType === 'prediction' && Boolean(predictionDetailId),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const activeMarketItem = normalizedType === 'stock' ? stockItem : normalizedType === 'perp' ? perpItem : null;
  const activePredictionItem = normalizedType === 'prediction' ? predictionDetail : null;
  const hasResolvedSummaryIdentity = normalizedType === 'prediction'
    ? Boolean(activePredictionItem?.title?.trim())
    : Boolean(activeMarketItem?.name?.trim() || activeMarketItem?.symbol?.trim());
  const isPredictionIdentityPending = normalizedType === 'prediction'
    && !hasResolvedSummaryIdentity
    && (
      isPredictionDetailLoading
      || (isInstrumentRouteItem && (!isIdentityFetched || (Boolean(activeInstrumentId) && !isInstrumentFetched)))
      || (!isInstrumentRouteItem && !predictionDetailId && !isPredictionDetailFetched)
    );
  const isMarketIdentityPending = normalizedType !== 'prediction'
    && !hasResolvedSummaryIdentity
    && (
      (isInstrumentRouteItem && !isIdentityFetched)
      ||
      isLoading
      || isDetailLoading
      || isInstrumentLoading
      || !isBrowseFetched
      || (Boolean(activeInstrumentId) && !isInstrumentFetched)
      || (!isInstrumentRouteItem && !isDetailFetched)
    );
  const isSummaryLoading = isPredictionIdentityPending || isMarketIdentityPending;
  const predictionLayout = activePredictionItem?.layout === 'winner' ? 'winner' : 'binary';
  const predictionOutcomes = activePredictionItem?.outcomes ?? [];
  const selectedPredictionOption = useMemo<PredictionEventOutcome | null>(() => {
    if (!predictionOutcomes.length) return null;
    if (selectedPredictionOptionId) {
      const matched = predictionOutcomes.find((option) => option.id === selectedPredictionOptionId);
      if (matched) return matched;
    }
    const ranked = predictionOutcomes
      .filter((option) => Boolean(option.yesTokenId))
      .slice()
      .sort((a, b) => (b.probability ?? Number.NEGATIVE_INFINITY) - (a.probability ?? Number.NEGATIVE_INFINITY));
    return ranked[0] ?? predictionOutcomes[0] ?? null;
  }, [predictionOutcomes, selectedPredictionOptionId]);

  const displayName = activeMarketItem?.name ?? activePredictionItem?.title ?? '';
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
  const predictionDescription = activePredictionItem?.description ?? null;
  const predictionEndDate = activePredictionItem?.endDate ?? null;
  const predictionKlineItemId = activePredictionItem?.id ?? predictionDetailId;
  const normalizedKlineChain = (displayChain ?? '').trim().toLowerCase();
  const normalizedKlineContract = (displayContract ?? '').trim().toLowerCase();
  const klineSize = normalizedType === 'prediction' ? 240 : 60;
  const fallbackHasKlineSupport = normalizedType === 'stock'
    ? normalizedItemId.startsWith('binance-stock:') || (Boolean(normalizedKlineChain) && /^0x[a-f0-9]{40}$/.test(normalizedKlineContract))
    : normalizedType === 'perp'
      ? normalizedItemId.startsWith('hyperliquid:')
      : Boolean(activePredictionItem) && predictionOutcomes.some((outcome) => Boolean(outcome.yesTokenId));
  const hasKlineSupport = Boolean(activeInstrumentId) || fallbackHasKlineSupport;

  const {
    data: klineData,
    isLoading: isKlineLoading,
  } = useQuery({
    queryKey: [
      'trade-market-kline',
      normalizedType,
      normalizedItemId,
      activeInstrumentId,
      normalizedKlineChain,
      normalizedKlineContract,
      klinePeriod,
      klineSize,
    ],
    queryFn: () => {
      if (activeInstrumentId) {
        return getMarketCandlesByInstrumentId(
          activeInstrumentId,
          klinePeriod,
          klineSize,
          null,
        );
      }
      if (normalizedType === 'stock' && normalizedItemId.startsWith('binance-stock:')) {
        return getTradeMarketKline(normalizedType, normalizedItemId, klinePeriod, klineSize);
      }
      if (normalizedType === 'stock') {
        return getTokenKline(normalizedKlineChain, normalizedKlineContract, klinePeriod, klineSize);
      }
      return getTradeMarketKline(
        normalizedType,
        normalizedItemId,
        klinePeriod,
        klineSize,
        null,
      );
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled: hasKlineSupport && normalizedType !== 'prediction',
  });
  const { data: predictionKlineData, isLoading: isPredictionKlineLoading } = useQuery({
    queryKey: ['prediction-event-kline', predictionKlineItemId, klinePeriod, klineSize],
    queryFn: () => getPredictionEventKline(predictionKlineItemId ?? '', klinePeriod, klineSize),
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled: normalizedType === 'prediction' && Boolean(predictionKlineItemId),
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
  const chartCandles = useMemo<CandlePoint[]>(
    () => normalizeCandlesForLiveline(klineData),
    [klineData],
  );
  const candleWidth = KLINE_CANDLE_WIDTH_SECONDS[klinePeriod];
  const chartLine = useMemo<LivelinePoint[]>(
    () => toOpenAnchoredLivelinePoints(chartCandles, candleWidth),
    [candleWidth, chartCandles],
  );
  const predictionSeries = useMemo<PredictionKlineSeries[]>(
    () => (predictionKlineData ?? []).map((series: PredictionEventSeries) => {
      const line = toLivelinePoints(normalizeCandlesForLiveline(series.candles));
      return {
        id: series.outcomeId,
        label: series.label,
        line,
        latestValue: line[line.length - 1]?.value ?? series.latestValue ?? null,
        isSelected: series.outcomeId === (selectedPredictionOption?.id ?? null),
      };
    }),
    [predictionKlineData, selectedPredictionOption?.id],
  );
  const hasPredictionChartData = predictionSeries.some((item) => item.line.length > 0);
  const topPredictionOptions = useMemo(
    () => predictionOutcomes
      .slice()
      .sort((a, b) => (b.probability ?? Number.NEGATIVE_INFINITY) - (a.probability ?? Number.NEGATIVE_INFINITY))
      .slice(0, 4),
    [predictionOutcomes],
  );
  const latestChartValue = chartLine.length > 0
    ? chartLine[chartLine.length - 1].value
    : normalizedType === 'prediction'
      ? Number(selectedPredictionOption?.probability ?? displayProbability ?? 0)
      : Number(displayPrice ?? 0);
  const chartWindow = useMemo(
    () => computeAdaptiveChartWindowSeconds(chartCandles, candleWidth, 60),
    [candleWidth, chartCandles],
  );
  const isPredictionChartLoading = normalizedType === 'prediction'
    && isPredictionKlineLoading
    && !hasPredictionChartData;
  const isChartLoading = normalizedType === 'prediction'
    ? isPredictionChartLoading
    : hasKlineSupport && isKlineLoading && chartCandles.length === 0;
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
    if (!predictionOutcomes.length) {
      setSelectedPredictionOptionId(null);
      return;
    }
    const hasCurrent = selectedPredictionOptionId
      ? predictionOutcomes.some((option) => option.id === selectedPredictionOptionId)
      : false;
    if (hasCurrent) return;
    const ranked = predictionOutcomes
      .filter((option) => Boolean(option.yesTokenId))
      .slice()
      .sort((a, b) => (b.probability ?? Number.NEGATIVE_INFINITY) - (a.probability ?? Number.NEGATIVE_INFINITY));
    const fallback = ranked[0] ?? predictionOutcomes[0];
    setSelectedPredictionOptionId(fallback?.id ?? null);
  }, [normalizedType, predictionOutcomes, selectedPredictionOptionId]);

  async function switchKlinePeriod(nextPeriod: KlinePeriod): Promise<void> {
    if (!hasKlineSupport || nextPeriod === klinePeriod || pendingKlinePeriod) return;
    setPendingKlinePeriod(nextPeriod);
    try {
      if (normalizedType === 'prediction') {
        await queryClient.fetchQuery({
          queryKey: [
            'prediction-event-kline',
            predictionKlineItemId,
            nextPeriod,
            klineSize,
          ],
          queryFn: () => getPredictionEventKline(predictionKlineItemId ?? '', nextPeriod, klineSize),
          staleTime: 20_000,
        });
      } else {
        await queryClient.fetchQuery({
          queryKey: [
            'trade-market-kline',
            normalizedType,
            normalizedItemId,
            activeInstrumentId,
            normalizedKlineChain,
            normalizedKlineContract,
            nextPeriod,
            klineSize,
          ],
          queryFn: () => {
            if (activeInstrumentId) {
              return getMarketCandlesByInstrumentId(
                activeInstrumentId,
                nextPeriod,
                klineSize,
                null,
              );
            }
            if (normalizedType === 'stock' && normalizedItemId.startsWith('binance-stock:')) {
              return getTradeMarketKline(normalizedType, normalizedItemId, nextPeriod, klineSize);
            }
            if (normalizedType === 'stock') {
              return getTokenKline(normalizedKlineChain, normalizedKlineContract, nextPeriod, klineSize);
            }
            return getTradeMarketKline(
              normalizedType,
              normalizedItemId,
              nextPeriod,
              klineSize,
              null,
            );
          },
          staleTime: 20_000,
        });
      }
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

  async function submitPredictionBetOrder(option: PredictionBetTarget): Promise<void> {
    if (pendingPredictionOptionId != null) return;
    if (!option.tokenId) {
      showError(t('trade.betTokenUnavailable'));
      return;
    }

    const amount = predictionBetAmount.trim();
    const numericAmount = Number(amount);
    if (!amount || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      showError(t('trade.betAmountInvalid'));
      return;
    }

    setPendingPredictionOptionId(option.id);
    try {
      const result = await submitPredictionBet({
        tokenId: option.tokenId,
        amount,
        side: 'buy',
        orderType: 'fok',
      });
      ingestAgentEvent('trade_buy', {
        asset: (displaySymbol || displayName).toUpperCase(),
        itemId: normalizedItemId,
        marketType: normalizedType,
        option: option.label,
        source: 'trade_market_detail',
        tokenId: option.tokenId,
        orderId: result.orderId,
      }).catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ['wallet-portfolio'] });
      showSuccess(t('trade.betSuccess'));
    } catch (error) {
      showError(`${t('trade.betFailed')}: ${(error as Error).message}`);
    } finally {
      setPendingPredictionOptionId(null);
    }
  }

  const klinePeriodButtons = (
    <>
      {(normalizedType === 'prediction' ? PREDICTION_KLINE_PERIOD_OPTIONS : KLINE_PERIOD_OPTIONS).map((option) => (
        'labelKey' in option ? (
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
        ) : (
          <button
            key={option.value}
            type="button"
            className={`btn btn-xs border-0 px-3 ${klinePeriod === option.value ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => void switchKlinePeriod(option.value)}
            disabled={pendingKlinePeriod != null}
          >
            {pendingKlinePeriod === option.value ? <span className="loading loading-spinner loading-xs" /> : option.label}
          </button>
        )
      ))}
    </>
  );

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

      {normalizedType === 'prediction' ? (
        <PredictionOverviewSection
          isLoading={isSummaryLoading}
          title={displayName || t('trade.detailTitle')}
          image={displayImage}
          description={predictionDescription}
          volume24h={displayVolume24h}
          endDate={predictionEndDate}
          topOptions={topPredictionOptions}
          locale={i18n.language}
        />
      ) : (
        <MarketSummarySection
          isLoading={isSummaryLoading}
          displayImage={displayImage}
          displayName={displayName}
          displaySymbol={displaySymbol}
          normalizedType={normalizedType}
          displayPrice={displayPrice}
          displayProbability={displayProbability}
          displayChange24h={displayChange24h}
        />
      )}

      <MarketKlineSection
        normalizedType={normalizedType}
        hasKlineSupport={hasKlineSupport}
        klinePeriodButtons={klinePeriodButtons}
        chartMode={chartMode}
        setChartMode={setChartMode}
        isChartLoading={isChartLoading}
        chartCandles={chartCandles}
        chartLine={chartLine}
        latestChartValue={latestChartValue}
        candleWidth={candleWidth}
        chartWindow={chartWindow}
        resolvedTheme={resolvedTheme}
        chartColor={chartColor}
        locale={i18n.language}
        predictionSeries={predictionSeries}
        onSelectPredictionSeries={normalizedType === 'prediction' ? setSelectedPredictionOptionId : undefined}
      />

      {normalizedType === 'prediction' && (
        <PredictionBetOptionsSection
          layout={predictionLayout}
          outcomes={predictionOutcomes}
          selectedOptionId={selectedPredictionOption?.id ?? null}
          onSelectOption={setSelectedPredictionOptionId}
          betAmount={predictionBetAmount}
          onBetAmountChange={setPredictionBetAmount}
          onBet={(option) => void submitPredictionBetOrder(option)}
          pendingOptionId={pendingPredictionOptionId}
          locale={i18n.language}
        />
      )}

      <MarketInfoSection
        isLoading={isSummaryLoading}
        normalizedType={normalizedType}
        displaySource={displaySource}
        normalizedItemId={normalizedItemId}
        displayVolume24h={displayVolume24h}
        displayProbability={displayProbability}
        displayMetaLabel={displayMetaLabel}
        displayMetaValue={displayMetaValue}
        displayChange24h={displayChange24h}
        displayContract={displayContract}
        displayChain={displayChain}
        locale={i18n.language}
      />

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
