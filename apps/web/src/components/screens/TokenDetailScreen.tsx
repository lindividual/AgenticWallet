import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Liveline } from 'liveline';
import type { CandlePoint, LivelinePoint } from 'liveline';
import {
  addMarketWatchlistAsset,
  getAppConfig,
  getTradeBrowse,
  getCoinDetail,
  getMarketWatchlist,
  getTokenKline,
  ingestAgentEvent,
  removeMarketWatchlistAsset,
  type KlinePeriod,
  type TradeBrowseResponse,
  type TopMarketAsset,
} from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { formatUsdAdaptive } from '../../utils/currency';
import { computeAdaptiveChartWindowSeconds, formatChartTimeLabel, normalizeCandlesForLiveline, toOpenAnchoredLivelinePoints } from '../../utils/kline';
import { cloneTradeToken, getNetworkKeyByMarketChain, getTradeTokenConfig } from '../../utils/tradeTokens';
import { CachedIconImage } from '../CachedIconImage';
import { Modal } from '../modals/Modal';
import { TradeContent, type TradePreset } from '../modals/TradeContent';
import { SkeletonBlock } from '../Skeleton';
import { useTheme } from '../../contexts/ThemeContext';
import { normalizeContractForChain } from '../../utils/chainIdentity';

type TokenDetailScreenProps = {
  chain: string;
  contract: string;
  onBack: () => void;
};

type DetailChartRange = '1d' | '1w' | '1m' | 'max';

const KLINE_PERIOD_OPTIONS: Array<{
  value: DetailChartRange;
  labelKey: string;
}> = [
  { value: '1d', labelKey: 'trade.klineRange1d' },
  { value: '1w', labelKey: 'trade.klineRange1w' },
  { value: '1m', labelKey: 'trade.klineRange1m' },
  { value: 'max', labelKey: 'trade.klineRangeMax' },
];

const KLINE_RANGE_REQUESTS: Record<DetailChartRange, { period: KlinePeriod; size: number }> = {
  '1d': { period: '1h', size: 24 },
  '1w': { period: '4h', size: 42 },
  '1m': { period: '1d', size: 30 },
  max: { period: '1w', size: 260 },
};

const KLINE_RANGE_FALLBACK_CHANGE_OPTIONS: Array<{ period: KlinePeriod; size: number }> = [
  { period: '1h', size: 48 },
  { period: '4h', size: 14 },
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
const TOKEN_ROUTE_PREVIEW_QUERY_KEY = 'trade-token-route-preview';

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

function formatCompactUsd(value: number | null | undefined, locale: string): string {
  if (!Number.isFinite(Number(value))) return '--';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatPercentFromRatio(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function formatTruncatedContract(value: string | null | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '--';
  if (normalized.length <= 10) return normalized;
  return `${normalized.slice(0, 5)}...${normalized.slice(-5)}`;
}

function ChangeTriangle({ direction }: { direction: 'up' | 'down' | 'flat' }) {
  const rotationClass = direction === 'up' ? '' : direction === 'down' ? 'rotate-180' : 'rotate-90';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 10 10"
      className={`h-2.5 w-2.5 ${rotationClass}`}
      fill="currentColor"
    >
      <path d="M5 1.5 8.5 7.5h-7Z" />
    </svg>
  );
}

function ChartModeToggleButton({
  chartMode,
  setChartMode,
}: {
  chartMode: 'line' | 'candle';
  setChartMode: (mode: 'line' | 'candle') => void;
}) {
  const isLineMode = chartMode === 'line';

  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs border-0 px-2.5"
      onClick={() => setChartMode(isLineMode ? 'candle' : 'line')}
      aria-label={isLineMode ? 'switch to candle chart' : 'switch to line chart'}
    >
      <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center">
        {isLineMode ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 3.5v9" />
            <path d="M12.5 3.5v9" />
            <path d="M7.75 2.5v11" />
            <rect x="2.5" y="6.25" width="2" height="3.5" rx="1" fill="currentColor" stroke="none" />
            <rect x="6.75" y="4.25" width="2" height="4.5" rx="1" fill="currentColor" stroke="none" />
            <rect x="11.5" y="7.25" width="2" height="3" rx="1" fill="currentColor" stroke="none" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 10.5 5.25 7.75 7.75 9.5 11.5 5.5 14 6.75" />
          </svg>
        )}
      </span>
    </button>
  );
}

function getTokenInitial(symbol: string | null | undefined, name: string | null | undefined): string {
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

function compute24hChangePctFromHourlyCandles(
  candles: Array<{ close: number }> | null | undefined,
): number | null {
  if (!candles || candles.length < 2) return null;
  const latestClose = Number(candles[candles.length - 1]?.close);
  const baseIndex = Math.max(0, candles.length - 1 - 24);
  const baseClose = Number(candles[baseIndex]?.close);
  if (!Number.isFinite(latestClose) || !Number.isFinite(baseClose) || baseClose <= 0) return null;
  return ((latestClose - baseClose) / baseClose) * 100;
}

function toWatchlistKey(chain: string, contract: string): string {
  return `${chain.trim().toLowerCase()}:${normalizeContractForChain(chain, contract)}`;
}

function findBrowseFallbackItem(
  payload: TradeBrowseResponse | undefined,
  options: {
    instrumentId: string | null;
    chain: string;
    contract: string;
  },
) {
  if (!payload) return null;

  const items = [
    ...payload.topMovers,
    ...payload.trendings,
  ];

  const normalizedInstrumentId = options.instrumentId?.trim() || null;
  if (normalizedInstrumentId) {
    const byInstrumentId = items.find((item) => (item.instrument_id?.trim() || null) === normalizedInstrumentId);
    if (byInstrumentId) return byInstrumentId;
  }

  const targetKey = toWatchlistKey(options.chain, options.contract);
  return items.find((item) => {
    if (!item.chain) return false;
    return toWatchlistKey(item.chain, item.contract ?? '') === targetKey;
  }) ?? null;
}

type TokenDetailLike = {
  chain?: string | null;
  contract?: string | null;
  symbol?: string | null;
  name?: string | null;
  image?: string | null;
  about?: string | null;
  currentPriceUsd?: number | null;
  priceChange24h?: number | null;
  holders?: number | null;
  liquidityUsd?: number | null;
  top10HolderPercent?: number | null;
  lockLpPercent?: number | null;
  fdv?: number | null;
  volume24h?: number | null;
  currentPrice?: number | null;
  change24h?: number | null;
};

function isUnknownLabel(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '' || normalized === 'unknown' || normalized === 'unknown token';
}

function hasMeaningfulTokenIdentity(detail: TokenDetailLike | null | undefined): boolean {
  if (!detail) return false;
  return !isUnknownLabel(detail.name) || !isUnknownLabel(detail.symbol);
}

export function TokenDetailScreen({ chain, contract, onBack }: TokenDetailScreenProps) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const [chartRange, setChartRange] = useState<DetailChartRange>('1d');
  const [chartMode, setChartMode] = useState<'line' | 'candle'>('line');
  const [pendingChartRange, setPendingChartRange] = useState<DetailChartRange | null>(null);
  const [isWatchlistToggling, setIsWatchlistToggling] = useState(false);
  const [tradePreset, setTradePreset] = useState<TradePreset | null>(null);
  const [isTradeModalOpen, setIsTradeModalOpen] = useState(false);

  const normalizedChain = chain.trim().toLowerCase();
  const normalizedContract = normalizeContractForChain(normalizedChain, contract);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [normalizedChain, normalizedContract]);

  const routePreview = useMemo<TopMarketAsset | null>(
    () =>
      queryClient.getQueryData<TopMarketAsset>([
        TOKEN_ROUTE_PREVIEW_QUERY_KEY,
        normalizedChain,
        normalizedContract,
      ]) ?? null,
    [normalizedChain, normalizedContract, queryClient],
  );

  const activeChartRequest = KLINE_RANGE_REQUESTS[chartRange];

  const { data: detail, isLoading: isLegacyDetailLoading } = useQuery({
    queryKey: ['trade-token-detail-legacy', normalizedChain, normalizedContract],
    queryFn: () => getCoinDetail(normalizedChain, normalizedContract),
    staleTime: 15_000,
    refetchInterval: 20_000,
    enabled: Boolean(normalizedChain),
  });

  const {
    data: klineData,
    isLoading: isKlineLoading,
    isError: isKlineError,
    error: klineError,
  } = useQuery({
    queryKey: [
      'trade-token-kline',
      normalizedChain,
      normalizedContract,
      chartRange,
      activeChartRequest.period,
      activeChartRequest.size,
    ],
    queryFn: () => getTokenKline(normalizedChain, normalizedContract, activeChartRequest.period, activeChartRequest.size),
    staleTime: 20_000,
    refetchInterval: 30_000,
  });

  const { data: watchlistData } = useQuery({
    queryKey: ['market-watchlist', 200],
    queryFn: () => getMarketWatchlist({ limit: 200 }),
    staleTime: 15_000,
  });
  const { data: appConfig } = useQuery({
    queryKey: ['app-config'],
    queryFn: getAppConfig,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const watchlistKeySet = useMemo(
    () =>
      new Set(
        (watchlistData?.assets ?? []).map((item) =>
          toWatchlistKey(item.chain, item.contract),
        ),
      ),
    [watchlistData?.assets],
  );
  const currentWatchKey = toWatchlistKey(normalizedChain, normalizedContract);
  const isInWatchlist = watchlistKeySet.has(currentWatchKey);
  const preferredDetail = hasMeaningfulTokenIdentity(detail) ? detail : detail ?? null;
  const resolvedTokenDetail: TokenDetailLike | null = {
    chain: preferredDetail?.chain ?? null,
    contract: preferredDetail?.contract ?? null,
    symbol: preferredDetail?.symbol ?? null,
    name: preferredDetail?.name ?? null,
    image: preferredDetail?.image ?? null,
    about: preferredDetail?.about ?? null,
    currentPriceUsd: preferredDetail?.currentPriceUsd ?? null,
    priceChange24h: preferredDetail?.priceChange24h ?? null,
    holders: preferredDetail?.holders ?? null,
    liquidityUsd: preferredDetail?.liquidityUsd ?? null,
    top10HolderPercent: preferredDetail?.top10HolderPercent ?? null,
    lockLpPercent: preferredDetail?.lockLpPercent ?? null,
    fdv: preferredDetail?.fdv ?? null,
    volume24h: preferredDetail?.volume24h ?? null,
  };

  const previewPriceChangePct = routePreview?.price_change_percentage_24h ?? null;
  const detailPriceChangePct = resolvedTokenDetail?.priceChange24h ?? null;
  const shouldUseTradeBrowseFallback =
    !Number.isFinite(Number(previewPriceChangePct))
    && !Number.isFinite(Number(detailPriceChangePct));

  const { data: tradeBrowseFallback } = useQuery({
    queryKey: ['trade-browse-price-change-fallback'],
    queryFn: () => getTradeBrowse(),
    staleTime: 60_000,
    refetchInterval: 90_000,
    enabled: shouldUseTradeBrowseFallback,
  });

  const tradeBrowseFallbackItem = useMemo(
    () =>
      findBrowseFallbackItem(tradeBrowseFallback, {
        instrumentId: null,
        chain: normalizedChain,
        contract: normalizedContract,
      }),
    [normalizedChain, normalizedContract, tradeBrowseFallback],
  );

  const tradeBrowseFallbackPriceChangePct = tradeBrowseFallbackItem?.change24h ?? null;
  const rawPriceChangePct =
    previewPriceChangePct
    ?? tradeBrowseFallbackPriceChangePct
    ?? detailPriceChangePct;
  const shouldUseKlineChangeFallback = !Number.isFinite(Number(rawPriceChangePct));

  const { data: fallbackChangeKlineData } = useQuery({
    queryKey: ['trade-token-kline-change-fallback', normalizedChain, normalizedContract],
    queryFn: async () => {
      for (const option of KLINE_RANGE_FALLBACK_CHANGE_OPTIONS) {
        const candles = await getTokenKline(normalizedChain, normalizedContract, option.period, option.size);
        if (candles.length > 1) return candles;
      }
      return [];
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled: shouldUseKlineChangeFallback,
  });

  useEffect(() => {
    ingestAgentEvent('asset_viewed', {
      asset: (preferredDetail?.symbol ?? routePreview?.symbol)?.toUpperCase(),
      itemId: undefined,
      chain: normalizedChain,
      contract: normalizedContract,
      source: 'trade_detail',
    }).catch(() => undefined);
  }, [normalizedChain, normalizedContract, preferredDetail?.symbol, routePreview?.symbol]);

  const chartCandles = useMemo<CandlePoint[]>(
    () => normalizeCandlesForLiveline(klineData),
    [klineData],
  );
  const candleWidth = KLINE_CANDLE_WIDTH_SECONDS[activeChartRequest.period];

  const chartLine = useMemo<LivelinePoint[]>(
    () => toOpenAnchoredLivelinePoints(chartCandles, candleWidth),
    [candleWidth, chartCandles],
  );

  const latestChartValue =
    chartLine.length > 0
      ? chartLine[chartLine.length - 1].value
      : resolvedTokenDetail?.currentPriceUsd
        ?? routePreview?.current_price
        ?? 0;

  const chartWindow = useMemo(
    () => computeAdaptiveChartWindowSeconds(chartCandles, candleWidth, 60),
    [candleWidth, chartCandles],
  );
  const displayContract = (resolvedTokenDetail?.contract ?? '').trim();
  const displayChain = (resolvedTokenDetail?.chain ?? '').trim().toUpperCase();
  const displayName = resolvedTokenDetail?.name ?? routePreview?.name ?? t('trade.detailTitle');
  const displaySymbol = (resolvedTokenDetail?.symbol ?? routePreview?.symbol ?? '').trim();
  const displayImage = resolvedTokenDetail?.image ?? routePreview?.image ?? null;
  const displayAbout = (resolvedTokenDetail?.about ?? '').trim();
  const displayFdv = resolvedTokenDetail?.fdv ?? null;
  const displayVolume24h = resolvedTokenDetail?.volume24h ?? routePreview?.turnover_24h ?? null;
  const displayHolders = resolvedTokenDetail?.holders ?? null;
  const displayLiquidity = resolvedTokenDetail?.liquidityUsd ?? null;
  const displayTop10HolderPercent = resolvedTokenDetail?.top10HolderPercent ?? null;
  const tradeMarketChain = (resolvedTokenDetail?.chain ?? routePreview?.chain ?? normalizedChain).trim().toLowerCase();
  const tradeContract = (resolvedTokenDetail?.contract ?? normalizedContract).trim();
  const tradeNetworkKey = getNetworkKeyByMarketChain(tradeMarketChain);
  const tradeTokenConfig = tradeNetworkKey ? getTradeTokenConfig(tradeNetworkKey) : null;
  const canTradeToken = Boolean(
    tradeNetworkKey
      && tradeTokenConfig
      && (tradeMarketChain === 'sol' ? tradeContract && tradeContract !== 'native' : /^0x[a-fA-F0-9]{40}$/.test(tradeContract)),
  );

  const fallbackPriceChangePct = useMemo(
    () => compute24hChangePctFromHourlyCandles(fallbackChangeKlineData),
    [fallbackChangeKlineData],
  );
  const priceChangePct = rawPriceChangePct ?? fallbackPriceChangePct;
  const hasPriceChangePct = Number.isFinite(Number(priceChangePct));
  const numericPriceChangePct = hasPriceChangePct ? Number(priceChangePct) : 0;
  const priceChangeTone =
    !hasPriceChangePct || numericPriceChangePct === 0
      ? 'text-base-content/70'
      : numericPriceChangePct > 0
        ? 'text-success'
        : 'text-error';
  const isPriceLoading = isLegacyDetailLoading;
  const isChartLoading = isKlineLoading && chartCandles.length === 0;
  const shouldShowHeaderSkeleton =
    isLegacyDetailLoading
    && !resolvedTokenDetail?.name
    && !routePreview;
  const chartColor = useMemo(
    () => resolveThemeColor('--color-base-content', resolvedTheme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'),
    [resolvedTheme],
  );

  async function switchChartRange(nextRange: DetailChartRange): Promise<void> {
    if (nextRange === chartRange || pendingChartRange) return;
    setPendingChartRange(nextRange);
    const nextRequest = KLINE_RANGE_REQUESTS[nextRange];
    try {
      await queryClient.fetchQuery({
        queryKey: [
          'trade-token-kline',
          normalizedChain,
          normalizedContract,
          nextRange,
          nextRequest.period,
          nextRequest.size,
        ],
        queryFn: () => getTokenKline(normalizedChain, normalizedContract, nextRequest.period, nextRequest.size),
        staleTime: 20_000,
      });
      setChartRange(nextRange);
    } finally {
      setPendingChartRange(null);
    }
  }

  async function toggleWatchlist(): Promise<void> {
    if (isWatchlistToggling) return;
    setIsWatchlistToggling(true);
    try {
      if (isInWatchlist) {
        await removeMarketWatchlistAsset({
          chain: normalizedChain,
          contract: normalizedContract,
        });
        showSuccess(t('trade.watchRemoved'));
      } else {
        await addMarketWatchlistAsset({
          watchType: 'crypto',
          itemId: `${normalizedChain}:${normalizedContract}`,
          chain: normalizedChain,
          contract: normalizedContract,
          symbol: (detail?.symbol ?? routePreview?.symbol ?? '').trim() || undefined,
          name: (detail?.name ?? routePreview?.name ?? '').trim() || undefined,
          image: displayImage,
          source: 'token_detail',
          change24h: priceChangePct ?? null,
        });
        ingestAgentEvent('asset_favorited', {
          asset: (preferredDetail?.symbol ?? routePreview?.symbol)?.toUpperCase(),
          itemId: undefined,
          chain: normalizedChain,
          contract: normalizedContract,
          source: 'trade_detail',
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

  function openTrade(mode: 'buy' | 'sell'): void {
    if (!tradeNetworkKey || !tradeTokenConfig || !canTradeToken) {
      showError(t('wallet.tradeChainNotSupported'));
      return;
    }

    const tokenPreset = {
      address: tradeContract,
      symbol: displaySymbol || t('wallet.token'),
    };
    const preset: TradePreset =
      mode === 'buy'
        ? {
            mode: 'buy',
            networkKey: tradeNetworkKey,
            sellToken: cloneTradeToken(tradeTokenConfig.usdc),
            buyToken: tokenPreset,
            assetSymbolForEvent: displaySymbol || undefined,
          }
        : {
            mode: 'sell',
            networkKey: tradeNetworkKey,
            sellToken: tokenPreset,
            buyToken: cloneTradeToken(tradeTokenConfig.usdc),
            assetSymbolForEvent: displaySymbol || undefined,
          };

    setTradePreset(preset);
    setIsTradeModalOpen(true);
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
          disabled={isWatchlistToggling}
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
        {shouldShowHeaderSkeleton ? (
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
                  fallback={(
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-base-300 text-lg font-semibold text-base-content/70">
                      {getTokenInitial(displaySymbol, displayName)}
                    </div>
                  )}
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-base-300 text-lg font-semibold text-base-content/70">
                  {getTokenInitial(displaySymbol, displayName)}
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
                {isPriceLoading
                  ? Number.isFinite(Number(routePreview?.current_price))
                    ? formatUsdAdaptive(Number(routePreview?.current_price), i18n.language)
                    : t('trade.priceUnavailable')
                  : Number.isFinite(Number(resolvedTokenDetail?.currentPriceUsd))
                    ? formatUsdAdaptive(Number(resolvedTokenDetail?.currentPriceUsd), i18n.language)
                    : Number.isFinite(Number(routePreview?.current_price))
                      ? formatUsdAdaptive(Number(routePreview?.current_price), i18n.language)
                      : t('trade.priceUnavailable')}
              </p>
              <p className={`m-0 mt-1 flex items-center gap-1 text-base font-medium ${priceChangeTone}`}>
                <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center">
                  {hasPriceChangePct && numericPriceChangePct > 0 ? (
                    <ChangeTriangle direction="up" />
                  ) : hasPriceChangePct && numericPriceChangePct < 0 ? (
                    <ChangeTriangle direction="down" />
                  ) : (
                    <ChangeTriangle direction="flat" />
                  )}
                </span>
                <span>{formatPct(priceChangePct)}</span>
              </p>
            </div>
          </>
        )}
      </section>

      <section className="p-0">
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {KLINE_PERIOD_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`btn btn-xs border-0 px-3 ${chartRange === option.value ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => void switchChartRange(option.value)}
                disabled={pendingChartRange != null}
              >
                {pendingChartRange === option.value ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  t(option.labelKey)
                )}
              </button>
            ))}
          </div>
          <ChartModeToggleButton chartMode={chartMode} setChartMode={setChartMode} />
        </div>
        {isChartLoading ? (
          <div className="mt-3">
            <div className="h-72 overflow-hidden rounded-lg bg-base-200/30 px-2 py-2">
              <svg viewBox="0 0 640 220" className="h-full w-full" role="img" aria-label={t('trade.loadingKline')}>
                <defs>
                  <linearGradient id="loading-kline-line" x1="0%" y1="0%" x2="100%" y2="0%">
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
                  stroke="url(#loading-kline-line)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  className="text-base-content/70"
                />
              </svg>
            </div>
          </div>
        ) : chartCandles.length === 0 ? (
          <p className="m-0 mt-3 text-sm text-base-content/60">
            {isKlineError
              ? t('trade.loadFailed', { message: klineError instanceof Error ? klineError.message : t('common.error') })
              : t('trade.noKline')}
          </p>
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
              formatValue={(value) => formatUsdAdaptive(value, i18n.language)}
              formatTime={(time) => formatChartTimeLabel(time, i18n.language, candleWidth)}
              grid={false}
              scrub
              padding={{ top: 6, right: 6, bottom: 6, left: 6 }}
            />
          </div>
        )}
      </section>

      <section className="p-0">
        <h2 className="m-0 text-lg font-bold">{t('trade.about')}</h2>
        <p className="m-0 mt-3 whitespace-pre-wrap text-sm leading-7 text-base-content/75">
          {displayAbout || t('trade.noDescription')}
        </p>
        {isLegacyDetailLoading && !resolvedTokenDetail?.name ? (
          <div className="mt-3 grid grid-cols-2 gap-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={`token-info-skeleton-${index}`} className="rounded bg-base-200/40 p-2">
                <SkeletonBlock className="h-3 w-16" />
                <SkeletonBlock className="mt-2 h-4 w-20" />
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.change24h')}</p>
              <p className={`m-0 mt-1 font-medium ${priceChangeTone}`}>{formatPct(priceChangePct)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.volume24h')}</p>
              <p className="m-0 mt-1 font-medium">{formatCompactUsd(displayVolume24h, i18n.language)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.fdv')}</p>
              <p className="m-0 mt-1 font-medium">{formatCompactUsd(displayFdv, i18n.language)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.liquidity')}</p>
              <p className="m-0 mt-1 font-medium">{formatCompactUsd(displayLiquidity, i18n.language)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.holders')}</p>
              <p className="m-0 mt-1 font-medium">{formatCompact(displayHolders, i18n.language)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.top10HolderPercent')}</p>
              <p className="m-0 mt-1 font-medium">{formatPercentFromRatio(displayTop10HolderPercent)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.chain')}</p>
              <p className="m-0 mt-1 font-medium">{displayChain || '--'}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.contract')}</p>
              <p className="m-0 mt-1 truncate font-medium">
                {displayContract
                  ? displayContract === 'native'
                    ? t('trade.nativeToken')
                    : formatTruncatedContract(displayContract)
                  : resolvedTokenDetail
                    ? t('trade.nativeToken')
                    : '--'}
              </p>
            </div>
          </div>
        )}
      </section>

      <div className="fixed bottom-5 left-1/2 z-30 w-full max-w-105 -translate-x-1/2 px-5">
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="btn btn-success border-0"
            onClick={() => openTrade('buy')}
          >
            {t('trade.buy')}
          </button>
          <button
            type="button"
            className="btn btn-error border-0"
            onClick={() => openTrade('sell')}
          >
            {t('trade.sell')}
          </button>
        </div>
      </div>
      {isTradeModalOpen && tradePreset ? (
        <Modal visible originRect={null} onClose={() => setIsTradeModalOpen(false)}>
          <TradeContent
            active={isTradeModalOpen}
            preset={tradePreset}
            supportedChains={appConfig?.supportedChains ?? []}
            onBack={() => setIsTradeModalOpen(false)}
            onClose={() => setIsTradeModalOpen(false)}
          />
        </Modal>
      ) : null}
    </section>
  );
}
