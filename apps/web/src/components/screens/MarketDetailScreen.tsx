import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CandlePoint, LivelinePoint } from 'liveline';
import {
  addMarketWatchlistAsset,
  cancelPerpsOrder,
  getPerpsAccount,
  getMarketWatchlist,
  getPredictionEventDetail,
  getPredictionEventKline,
  getTradeMarketDetail,
  getTradeMarketKline,
  ingestAgentEvent,
  removeMarketWatchlistAsset,
  submitPerpsOrder,
  submitPredictionBet,
  type KlinePeriod,
  type PerpsOpenOrderSnapshot,
  type PerpsPositionSnapshot,
  type PredictionEventOutcome,
  type PredictionEventSeries,
  type TradeBrowseMarketItem,
} from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useTheme } from '../../contexts/ThemeContext';
import { formatUsdAdaptive } from '../../utils/currency';
import {
  computeAdaptiveChartWindowSeconds,
  normalizeCandlesForLiveline,
  toLivelinePoints,
  toOpenAnchoredLivelinePoints,
} from '../../utils/kline';
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

const KLINE_PERIOD_OPTIONS: Array<{ value: KlinePeriod; labelKey: string }> = [
  { value: '15m', labelKey: 'trade.klinePeriod15m' },
  { value: '1h', labelKey: 'trade.klinePeriod1h' },
  { value: '4h', labelKey: 'trade.klinePeriod4h' },
  { value: '1d', labelKey: 'trade.klinePeriod1d' },
];

const PREDICTION_KLINE_PERIOD_OPTIONS: Array<{ value: KlinePeriod; label: string }> = [
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

function buildSyntheticWatchKey(
  watchType: 'perps' | 'prediction',
  itemId: string,
): { chain: string; contract: string } | null {
  const normalized = normalizeWatchlistItemId(itemId);
  if (!normalized) return null;
  return {
    chain: `watch:${watchType}`,
    contract: `item:${normalized}`,
  };
}

export function MarketDetailScreen({ marketType, itemId, onBack }: MarketDetailScreenProps) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const reportedAssetViewKeysRef = useRef<Set<string>>(new Set());
  const normalizedType = normalizeTradeMarketDetailType(marketType) ?? 'perp';
  const normalizedItemId = itemId.trim();
  const [klinePeriod, setKlinePeriod] = useState<KlinePeriod>(() => (
    normalizedType === 'prediction' ? 'all' : '1h'
  ));
  const [chartMode, setChartMode] = useState<'line' | 'candle'>('line');
  const [pendingKlinePeriod, setPendingKlinePeriod] = useState<KlinePeriod | null>(null);
  const [selectedPredictionOptionId, setSelectedPredictionOptionId] = useState<string | null>(null);
  const [predictionBetAmount, setPredictionBetAmount] = useState('5');
  const [pendingPredictionOptionId, setPendingPredictionOptionId] = useState<string | null>(null);
  const [isWatchlistToggling, setIsWatchlistToggling] = useState(false);
  const [perpsSide, setPerpsSide] = useState<'long' | 'short'>('long');
  const [perpsSize, setPerpsSize] = useState('');
  const [perpsLeverage, setPerpsLeverage] = useState('3');
  const [perpsReduceOnly, setPerpsReduceOnly] = useState(false);
  const [pendingPerpsSubmit, setPendingPerpsSubmit] = useState(false);
  const [pendingPerpsCancelOrderId, setPendingPerpsCancelOrderId] = useState<number | null>(null);

  const { data: detailItem, isLoading: isDetailLoading } = useQuery({
    queryKey: ['trade-market-detail', normalizedType, normalizedItemId],
    queryFn: () => getTradeMarketDetail(normalizedType, normalizedItemId),
    staleTime: 60_000,
    refetchInterval: 90_000,
    enabled: normalizedType !== 'prediction' && Boolean(normalizedItemId),
  });

  const { data: predictionDetail, isLoading: isPredictionDetailLoading } = useQuery({
    queryKey: ['prediction-event-detail', normalizedItemId],
    queryFn: () => getPredictionEventDetail(normalizedItemId),
    staleTime: 60_000,
    refetchInterval: 90_000,
    enabled: normalizedType === 'prediction' && Boolean(normalizedItemId),
  });

  const { data: watchlistData } = useQuery({
    queryKey: ['market-watchlist', 200],
    queryFn: () => getMarketWatchlist({ limit: 200 }),
    staleTime: 15_000,
  });
  const { data: perpsAccount, isFetching: isPerpsAccountFetching } = useQuery({
    queryKey: ['perps-account'],
    queryFn: () => getPerpsAccount(),
    staleTime: 15_000,
    refetchInterval: 20_000,
    enabled: normalizedType === 'perp',
  });

  const activeMarketItem = normalizedType === 'prediction' ? null : (detailItem as TradeBrowseMarketItem | null);
  const activePredictionItem = normalizedType === 'prediction' ? predictionDetail : null;
  const isSummaryLoading = normalizedType === 'prediction' ? isPredictionDetailLoading : isDetailLoading;
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
  const activePerpsPosition = useMemo<PerpsPositionSnapshot | null>(() => {
    const symbol = (activeMarketItem?.symbol ?? '').trim().toUpperCase();
    if (!symbol) return null;
    return perpsAccount?.positions.find((item) => item.coin.trim().toUpperCase() === symbol) ?? null;
  }, [activeMarketItem?.symbol, perpsAccount?.positions]);
  const activePerpsOrders = useMemo<PerpsOpenOrderSnapshot[]>(() => {
    const symbol = (activeMarketItem?.symbol ?? '').trim().toUpperCase();
    if (!symbol) return [];
    return (perpsAccount?.openOrders ?? []).filter((item) => item.coin.trim().toUpperCase() === symbol);
  }, [activeMarketItem?.symbol, perpsAccount?.openOrders]);
  const predictionDescription = activePredictionItem?.description ?? null;
  const predictionEndDate = activePredictionItem?.endDate ?? null;
  const hasKlineSupport = normalizedType === 'prediction'
    ? predictionOutcomes.some((outcome) => Boolean(outcome.yesTokenId))
    : Boolean(normalizedItemId);
  const klineSize = normalizedType === 'prediction' ? 240 : 60;

  const { data: klineData, isLoading: isKlineLoading } = useQuery({
    queryKey: ['trade-market-kline', normalizedType, normalizedItemId, klinePeriod, klineSize],
    queryFn: () => getTradeMarketKline(normalizedType, normalizedItemId, klinePeriod, klineSize),
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled: normalizedType !== 'prediction' && hasKlineSupport,
  });

  const { data: predictionKlineData, isLoading: isPredictionKlineLoading } = useQuery({
    queryKey: ['prediction-event-kline', normalizedItemId, klinePeriod, klineSize],
    queryFn: () => getPredictionEventKline(normalizedItemId, klinePeriod, klineSize),
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled: normalizedType === 'prediction' && hasKlineSupport,
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
  const assetViewDedupeKey = normalizedItemId
    ? `asset_viewed:${normalizedType}:${normalizedItemId}`
    : null;
  const assetViewLabel = (displaySymbol || displayName).trim().toUpperCase();

  useEffect(() => {
    if (normalizedType !== 'perp') return;
    setPerpsReduceOnly(false);
    setPerpsSize('');
    setPendingPerpsSubmit(false);
    setPendingPerpsCancelOrderId(null);
  }, [normalizedItemId, normalizedType]);

  useEffect(() => {
    if (!assetViewDedupeKey || !assetViewLabel) return;
    if (reportedAssetViewKeysRef.current.has(assetViewDedupeKey)) return;
    reportedAssetViewKeysRef.current.add(assetViewDedupeKey);
    ingestAgentEvent('asset_viewed', {
      asset: assetViewLabel,
      itemId: normalizedItemId,
      marketType: normalizedType,
      source: 'trade_market_detail',
    }, assetViewDedupeKey).catch(() => undefined);
  }, [assetViewDedupeKey, assetViewLabel, normalizedItemId, normalizedType]);

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
          queryKey: ['prediction-event-kline', normalizedItemId, nextPeriod, klineSize],
          queryFn: () => getPredictionEventKline(normalizedItemId, nextPeriod, klineSize),
          staleTime: 20_000,
        });
      } else {
        await queryClient.fetchQuery({
          queryKey: ['trade-market-kline', normalizedType, normalizedItemId, nextPeriod, klineSize],
          queryFn: () => getTradeMarketKline(normalizedType, normalizedItemId, nextPeriod, klineSize),
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
        await removeMarketWatchlistAsset({ id: activeWatchAsset.id });
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
    } catch {
      showError(t('common.actionFailed'));
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
    } catch {
      showError(t('trade.betFailedRetry'));
    } finally {
      setPendingPredictionOptionId(null);
    }
  }

  async function submitPerpsMarketOrder(): Promise<void> {
    if (pendingPerpsSubmit) return;
    const coin = (activeMarketItem?.symbol ?? '').trim().toUpperCase();
    if (!coin) {
      showError(t('trade.loadFailed'));
      return;
    }
    if (!perpsSize.trim()) {
      showError(t('trade.perpsSizeInvalid'));
      return;
    }

    const leverage = Number(perpsLeverage);
    setPendingPerpsSubmit(true);
    try {
      const result = await submitPerpsOrder({
        coin,
        side: perpsSide,
        size: perpsSize.trim(),
        orderType: 'market',
        reduceOnly: perpsReduceOnly,
        leverage: Number.isFinite(leverage) ? leverage : undefined,
        marginMode: activePerpsPosition?.leverageType === 'isolated' ? 'isolated' : 'cross',
      });
      ingestAgentEvent(perpsSide === 'long' ? 'trade_buy' : 'trade_sell', {
        asset: coin,
        itemId: normalizedItemId,
        marketType: normalizedType,
        source: 'trade_market_detail_perps',
        orderId: result.orderId,
      }).catch(() => undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['perps-account'] }),
        queryClient.invalidateQueries({ queryKey: ['wallet-portfolio'] }),
      ]);
      showSuccess(t('trade.perpsOrderSuccess'));
      setPerpsSize('');
      setPerpsReduceOnly(false);
    } catch {
      showError(t('trade.perpsOrderFailedRetry'));
    } finally {
      setPendingPerpsSubmit(false);
    }
  }

  async function handleCancelPerpsOrder(orderId: number): Promise<void> {
    if (pendingPerpsCancelOrderId != null || !activeMarketItem?.symbol) return;
    setPendingPerpsCancelOrderId(orderId);
    try {
      await cancelPerpsOrder({
        coin: activeMarketItem.symbol,
        orderId,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['perps-account'] }),
        queryClient.invalidateQueries({ queryKey: ['wallet-portfolio'] }),
      ]);
      showSuccess(t('trade.perpsCancelSuccess'));
    } catch {
      showError(t('trade.perpsCancelFailedRetry'));
    } finally {
      setPendingPerpsCancelOrderId(null);
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
            {pendingKlinePeriod === option.value ? <span className="loading loading-spinner loading-xs" /> : t(option.labelKey)}
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

      {normalizedType === 'perp' && activeMarketItem ? (
        <section className="rounded-3xl border border-base-300 bg-base-100 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="m-0 text-lg font-semibold">{t('trade.perpsTradePanelTitle')}</h3>
              <p className="m-0 mt-1 text-sm text-base-content/60">
                {perpsAccount?.available ? t('trade.perpsTradePanelHint') : t('trade.perpsUnavailableHint')}
              </p>
            </div>
            {isPerpsAccountFetching ? <span className="loading loading-spinner loading-sm" /> : null}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-base-300/80 bg-base-200/40 p-3">
              <p className="m-0 text-xs text-base-content/60">{t('trade.perpsAccountEquity')}</p>
              <p className="m-0 mt-1 text-base font-semibold">
                {perpsAccount?.available
                  ? formatUsdAdaptive(Number(perpsAccount.balanceUsd ?? 0), i18n.language)
                  : t('wallet.accountUnavailableValue')}
              </p>
            </div>
            <div className="rounded-2xl border border-base-300/80 bg-base-200/40 p-3">
              <p className="m-0 text-xs text-base-content/60">{t('trade.perpsWithdrawable')}</p>
              <p className="m-0 mt-1 text-base font-semibold">
                {perpsAccount?.available
                  ? formatUsdAdaptive(Number(perpsAccount.withdrawableUsd ?? 0), i18n.language)
                  : t('wallet.accountUnavailableValue')}
              </p>
            </div>
          </div>

          {activePerpsPosition ? (
            <div className="mt-4 rounded-2xl border border-base-300/80 bg-base-200/30 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{t('trade.perpsCurrentPosition')}</span>
                <span className={activePerpsPosition.side === 'long' ? 'text-success' : 'text-error'}>
                  {activePerpsPosition.side === 'long' ? t('trade.perpsLong') : t('trade.perpsShort')}
                </span>
              </div>
              <p className="m-0 mt-2 text-base-content/70">
                {activePerpsPosition.size} {activePerpsPosition.coin}
                {' · '}
                {formatUsdAdaptive(Number(activePerpsPosition.notionalUsd ?? 0), i18n.language)}
              </p>
              <p className="m-0 mt-1 text-base-content/70">
                {t('trade.perpsUnrealizedPnl')}
                {': '}
                {formatUsdAdaptive(Number(activePerpsPosition.unrealizedPnlUsd ?? 0), i18n.language)}
              </p>
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              className={`btn ${perpsSide === 'long' ? 'btn-success' : 'btn-outline'}`}
              onClick={() => setPerpsSide('long')}
              disabled={pendingPerpsSubmit}
            >
              {t('trade.perpsLong')}
            </button>
            <button
              type="button"
              className={`btn ${perpsSide === 'short' ? 'btn-error' : 'btn-outline'}`}
              onClick={() => setPerpsSide('short')}
              disabled={pendingPerpsSubmit}
            >
              {t('trade.perpsShort')}
            </button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-2">
              <span className="text-sm text-base-content/70">{t('trade.perpsOrderSize', { symbol: activeMarketItem.symbol })}</span>
              <input
                className="input input-bordered w-full"
                placeholder="0.01"
                value={perpsSize}
                inputMode="decimal"
                onChange={(event) => setPerpsSize(event.target.value)}
                disabled={pendingPerpsSubmit}
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-sm text-base-content/70">{t('trade.perpsLeverage')}</span>
              <input
                className="input input-bordered w-full"
                placeholder="3"
                value={perpsLeverage}
                inputMode="numeric"
                onChange={(event) => setPerpsLeverage(event.target.value)}
                disabled={pendingPerpsSubmit}
              />
            </label>
          </div>

          <label className="mt-3 inline-flex items-center gap-2 text-sm text-base-content/75">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={perpsReduceOnly}
              onChange={(event) => setPerpsReduceOnly(event.target.checked)}
              disabled={pendingPerpsSubmit}
            />
            {t('trade.perpsReduceOnly')}
          </label>

          <button
            type="button"
            className="btn btn-primary mt-4 w-full"
            onClick={() => void submitPerpsMarketOrder()}
            disabled={pendingPerpsSubmit || !perpsAccount?.available}
          >
            {pendingPerpsSubmit ? <span className="loading loading-spinner loading-sm" /> : null}
            {perpsReduceOnly ? t('trade.perpsReducePosition') : t('trade.perpsPlaceOrder')}
          </button>

          {activePerpsOrders.length > 0 ? (
            <div className="mt-5">
              <h4 className="m-0 text-sm font-medium text-base-content/75">{t('trade.perpsOpenOrders')}</h4>
              <div className="mt-3 flex flex-col gap-2">
                {activePerpsOrders.map((order) => (
                  <div key={order.orderId} className="flex items-center justify-between gap-3 rounded-2xl border border-base-300/80 px-3 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="m-0 font-medium">
                        {order.side === 'long' ? t('trade.perpsLong') : t('trade.perpsShort')}
                        {' · '}
                        {order.size} {order.coin}
                      </p>
                      <p className="m-0 mt-1 text-base-content/60">
                        {t('trade.perpsLimitPrice')}
                        {': '}
                        {order.limitPrice == null ? '--' : order.limitPrice}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void handleCancelPerpsOrder(order.orderId)}
                      disabled={pendingPerpsCancelOrderId === order.orderId}
                    >
                      {pendingPerpsCancelOrderId === order.orderId ? (
                        <span className="loading loading-spinner loading-xs" />
                      ) : (
                        t('trade.remove')
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

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
