import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CandlePoint, LivelinePoint } from 'liveline';
import {
  addMarketWatchlistAsset,
  getMarketWatchlist,
  getTradeMarketDetail,
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
import { normalizeCandlesForLiveline, toLivelinePoints } from '../../utils/kline';
import {
  normalizeTradeMarketDetailType,
  normalizeWatchlistItemId,
  toWatchTypeFromTradeMarketType,
  type TradeMarketDetailType,
} from '../../utils/tradeMarketDetail';
import { MarketInfoSection } from './marketDetail/MarketInfoSection';
import { MarketKlineSection } from './marketDetail/MarketKlineSection';
import { MarketSummarySection } from './marketDetail/MarketSummarySection';
import { PredictionBetOptionsSection } from './marketDetail/PredictionBetOptionsSection';

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

  const { data: detailItem, isLoading: isDetailLoading } = useQuery({
    queryKey: ['trade-market-detail', normalizedType, normalizedItemId],
    queryFn: () => getTradeMarketDetail(normalizedType, normalizedItemId),
    staleTime: 60_000,
    refetchInterval: 90_000,
    enabled: Boolean(normalizedItemId),
  });

  const stockItem = useMemo<TradeBrowseMarketItem | null>(
    () => {
      const fromDetail = normalizedType === 'stock'
        && detailItem
        && 'symbol' in detailItem
        ? detailItem as TradeBrowseMarketItem
        : null;
      if (fromDetail) return fromDetail;
      return browseData?.stocks.find((item) => item.id === normalizedItemId) ?? null;
    },
    [browseData?.stocks, detailItem, normalizedItemId, normalizedType],
  );
  const perpItem = useMemo<TradeBrowseMarketItem | null>(
    () => {
      const fromDetail = normalizedType === 'perp'
        && detailItem
        && 'symbol' in detailItem
        ? detailItem as TradeBrowseMarketItem
        : null;
      if (fromDetail) return fromDetail;
      return browseData?.perps.find((item) => item.id === normalizedItemId) ?? null;
    },
    [browseData?.perps, detailItem, normalizedItemId, normalizedType],
  );
  const predictionItem = useMemo<TradeBrowsePredictionItem | null>(
    () => {
      const fromDetail = normalizedType === 'prediction'
        && detailItem
        && detailItem.source === 'polymarket'
        ? detailItem as TradeBrowsePredictionItem
        : null;
      if (fromDetail) return fromDetail;
      return browseData?.predictions.find((item) => item.id === normalizedItemId) ?? null;
    },
    [browseData?.predictions, detailItem, normalizedItemId, normalizedType],
  );

  const activeMarketItem = normalizedType === 'stock' ? stockItem : normalizedType === 'perp' ? perpItem : null;
  const activePredictionItem = normalizedType === 'prediction' ? predictionItem : null;
  const isSummaryLoading = isLoading && isDetailLoading && !activeMarketItem && !activePredictionItem;
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
    ? normalizedItemId.startsWith('binance-stock:') || (Boolean(normalizedKlineChain) && /^0x[a-f0-9]{40}$/.test(normalizedKlineContract))
    : normalizedType === 'perp'
      ? normalizedItemId.startsWith('hyperliquid:')
      : Boolean(activePredictionItem) && Boolean(selectedPredictionTokenId);

  const {
    data: klineData,
    isLoading: isKlineLoading,
    isError: isKlineError,
    error: klineError,
  } = useQuery({
    queryKey: [
      'trade-market-kline',
      normalizedType,
      normalizedItemId,
      normalizedKlineChain,
      normalizedKlineContract,
      selectedPredictionTokenId,
      klinePeriod,
    ],
    queryFn: () => {
      if (normalizedType === 'stock' && normalizedItemId.startsWith('binance-stock:')) {
        return getTradeMarketKline(normalizedType, normalizedItemId, klinePeriod, 60);
      }
      if (normalizedType === 'stock') {
        return getTokenKline(normalizedKlineChain, normalizedKlineContract, klinePeriod, 60);
      }
      return getTradeMarketKline(
        normalizedType,
        normalizedItemId,
        klinePeriod,
        60,
        normalizedType === 'prediction' ? selectedPredictionTokenId : null,
      );
    },
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
  const chartCandles = useMemo<CandlePoint[]>(
    () => normalizeCandlesForLiveline(klineData),
    [klineData],
  );
  const chartLine = useMemo<LivelinePoint[]>(
    () => toLivelinePoints(chartCandles),
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
    console.log('[trade-kline-debug][web][state]', {
      type: normalizedType,
      id: normalizedItemId,
      hasKlineSupport,
      selectedPredictionTokenId,
      klinePeriod,
    });
  }, [hasKlineSupport, klinePeriod, normalizedItemId, normalizedType, selectedPredictionTokenId]);

  useEffect(() => {
    if (!klineData) return;
    console.log('[trade-kline-debug][web][kline_data]', {
      type: normalizedType,
      id: normalizedItemId,
      period: klinePeriod,
      candles: klineData.length,
      firstTs: klineData[0]?.time ?? null,
      lastTs: klineData[klineData.length - 1]?.time ?? null,
      firstRenderTs: chartCandles[0]?.time ?? null,
      lastRenderTs: chartCandles[chartCandles.length - 1]?.time ?? null,
    });
  }, [chartCandles, klineData, klinePeriod, normalizedItemId, normalizedType]);

  useEffect(() => {
    if (!isKlineError) return;
    console.error('[trade-kline-debug][web][kline_error]', {
      type: normalizedType,
      id: normalizedItemId,
      period: klinePeriod,
      message: klineError instanceof Error ? klineError.message : String(klineError),
    });
  }, [isKlineError, klineError, klinePeriod, normalizedItemId, normalizedType]);

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
        queryFn: () => {
          if (normalizedType === 'stock' && normalizedItemId.startsWith('binance-stock:')) {
            return getTradeMarketKline(normalizedType, normalizedItemId, nextPeriod, 60);
          }
          if (normalizedType === 'stock') {
            return getTokenKline(normalizedKlineChain, normalizedKlineContract, nextPeriod, 60);
          }
          return getTradeMarketKline(
            normalizedType,
            normalizedItemId,
            nextPeriod,
            60,
            normalizedType === 'prediction' ? selectedPredictionTokenId : null,
          );
        },
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

  const klinePeriodButtons = (
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

      {normalizedType === 'prediction' && (
        <PredictionBetOptionsSection
          options={predictionOptions}
          selectedOptionId={selectedPredictionOption?.id ?? null}
          onSelectOption={setSelectedPredictionOptionId}
          onBet={(label) => openExternalMarket(label)}
          hasExternalUrl={Boolean(displayExternalUrl)}
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
      />

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
